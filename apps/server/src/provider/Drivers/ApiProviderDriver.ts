import { ApiProviderSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";

import { makeApiProviderTextGeneration } from "../../textGeneration/ApiProviderTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeApiProviderAdapter } from "../Layers/ApiProviderAdapter.ts";
import { checkApiProviderStatus, makePendingApiProvider } from "../Layers/ApiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeProviderSnapshotSettingsSource,
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { ApiProviderUsageLedger } from "../../usage/ApiProviderUsageLedger.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { normalizeApiProviderSettings } from "../apiProviderProfiles.ts";

const DRIVER_KIND = ProviderDriverKind.make("api");
const decodeSettings = Schema.decodeSync(ApiProviderSettings);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);

const stampIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
  });

export type ApiProviderDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const ApiProviderDriver: ProviderDriver<ApiProviderSettings, ApiProviderDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "API Provider", supportsMultipleInstances: true },
  configSchema: ApiProviderSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const usageLedger = yield* Effect.serviceOption(ApiProviderUsageLedger);
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const settings = normalizeApiProviderSettings({
        ...config,
        enabled,
      } satisfies ApiProviderSettings);
      const apiKey = processEnv[settings.apiKeyEnvironmentVariable] ?? "";
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = stampIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE);
      const adapter = yield* makeApiProviderAdapter({
        instanceId,
        settings,
        apiKey,
        httpClient,
        fileSystem,
        childProcessSpawner,
        path,
        attachmentsDir: serverConfig.attachmentsDir,
        ...(usageLedger._tag === "Some" ? { usageLedger: usageLedger.value } : {}),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const textGeneration = yield* makeApiProviderTextGeneration(settings, apiKey, httpClient);
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ApiProviderSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (current) =>
          makePendingApiProvider(current.provider).pipe(Effect.map(stamp)),
        checkProvider: checkApiProviderStatus({ settings, apiKey, httpClient }).pipe(
          Effect.map(stamp),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build API provider snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
