import {
  type ApiProviderSettings,
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProvider,
  type ApiProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  API_PROVIDER_PROFILE_BY_ID,
  buildApiProviderAuthHeaders,
  isApiProviderChatModel,
  normalizeApiProviderSettings,
} from "../apiProviderProfiles.ts";
import {
  modelDiscoveryRequest,
  normalizeModelList,
  validateApiBaseUrl,
  type ApiProviderModelRecord,
} from "../apiProviderTransport.ts";
import { testApiProvider } from "../apiProviderTest.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const presentationFor = (settings: Pick<ApiProviderSettings, "profileId">) => ({
  displayName:
    API_PROVIDER_PROFILE_BY_ID.get(settings.profileId as never)?.displayName ?? "API Provider",
  showInteractionModeToggle: false as const,
});
const chatModelsFromSettings = (settings: ApiProviderSettings): ReadonlyArray<string> =>
  settings.customModels.filter((model) =>
    isApiProviderChatModel(String(settings.profileId), model),
  );
const option = (
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue?: string,
) => ({
  id,
  label,
  type: "select" as const,
  options,
  ...(currentValue ? { currentValue } : {}),
});

function capabilitiesForProtocol(
  protocol: ApiProviderSettings["protocol"],
  profileId?: string,
): ModelCapabilities {
  const isSenseNova = profileId === "sensenova";
  const descriptors = [
    option(
      "temperature",
      "Temperature",
      [
        { id: "0", label: "0" },
        { id: "0.2", label: "0.2" },
        { id: "0.7", label: "0.7", isDefault: true },
        { id: "1", label: "1" },
      ],
      "0.7",
    ),
    option(
      "maxOutputTokens",
      "Max output tokens",
      [
        { id: "1024", label: "1,024" },
        { id: "4096", label: "4,096", isDefault: true },
        { id: "8192", label: "8,192" },
        { id: "16384", label: "16,384" },
        ...(isSenseNova
          ? [
              { id: "32768", label: "32,768" },
              { id: "65536", label: "65,536" },
            ]
          : []),
      ],
      "4096",
    ),
    {
      id: "parallelToolCalls",
      label: "Parallel tool calls",
      type: "boolean" as const,
      currentValue: true,
    },
  ];
  if (protocol === "openai-responses" || isSenseNova) {
    descriptors.push(
      option(
        "reasoningEffort",
        "Reasoning effort",
        [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        "low",
      ),
    );
  }
  return createModelCapabilities({ optionDescriptors: descriptors });
}

const DEFAULT_CAPABILITIES: ModelCapabilities = capabilitiesForProtocol("openai-chat-completions");

const capability = (
  state: ApiProviderCapabilities["authentication"]["state"],
  checkedAt: string,
  detail: string,
) => ({ state, checkedAt, detail });
const apiCapabilities = (
  protocol: ApiProviderSettings["protocol"],
  state: ApiProviderCapabilities["authentication"]["state"],
  checkedAt: string,
  detail: string,
  supportsToolCalls = true,
  modelDiscoveryState = state,
): ApiProviderCapabilities => ({
  authentication: capability(state, checkedAt, detail),
  modelDiscovery: capability(modelDiscoveryState, checkedAt, detail),
  streaming: capability(
    state === "verified" ? "partial" : state,
    checkedAt,
    "Streaming is supported by the transport; this check does not prove the selected model streams correctly.",
  ),
  toolCalls: capability(
    supportsToolCalls ? "partial" : "unavailable",
    checkedAt,
    supportsToolCalls
      ? "Tool support is available in the transport but must be verified for the selected model."
      : "This provider profile does not expose documented function/tool calling.",
  ),
  approvals: capability(
    supportsToolCalls ? "partial" : "unavailable",
    checkedAt,
    supportsToolCalls
      ? "T3 approval handling is available for API tool calls."
      : "Unavailable because this profile does not expose tool calls.",
  ),
  attachments: capability(
    "partial",
    checkedAt,
    "T3 translates supported image attachments; whether the selected model accepts vision input is provider/model-specific.",
  ),
  sessions: capability(
    "partial",
    checkedAt,
    "T3 maintains API conversation state in the active runtime; persistence is provider/runtime dependent.",
  ),
  perRequestUsage: capability(
    "partial",
    checkedAt,
    "Usage is shown only when returned by the provider response.",
  ),
  rateLimits: capability(
    "partial",
    checkedAt,
    "Rate-limit response headers are captured when the provider sends them.",
  ),
  credits: capability(
    "unavailable",
    checkedAt,
    "This provider profile does not expose a verified credit endpoint.",
  ),
  billing: capability(
    "unavailable",
    checkedAt,
    "This provider profile does not expose a verified billing endpoint.",
  ),
});

function modelRecordsToSnapshotModels(
  records: ReadonlyArray<ApiProviderModelRecord>,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  return records.map((record) => ({
    slug: record.id,
    name: record.name,
    isCustom: false,
    capabilities: {
      ...capabilities,
      ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
      ...(record.maxOutputTokens !== undefined ? { maxOutputTokens: record.maxOutputTokens } : {}),
      ...(record.supportsTools !== undefined ? { supportsToolCalls: record.supportsTools } : {}),
      ...(record.supportsVision !== undefined ? { supportsVision: record.supportsVision } : {}),
      ...(record.supportsReasoning !== undefined
        ? { supportsReasoning: record.supportsReasoning }
        : {}),
    },
  }));
}

export const makePendingApiProvider = (
  settings: ApiProviderSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (checkedAt) =>
    buildServerProvider({
      presentation: presentationFor(settings),
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(checkedAt),
      models: providerModelsFromSettings(
        [],
        chatModelsFromSettings(settings),
        DEFAULT_CAPABILITIES,
      ),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown", type: "API key" },
        message: "API provider has not been checked yet.",
      },
      apiCapabilities: apiCapabilities(
        settings.protocol,
        "unavailable",
        DateTime.formatIso(checkedAt),
        "Add an API key to begin verification.",
      ),
    }),
  );

export const checkApiProviderStatus = (input: {
  readonly settings: ApiProviderSettings;
  readonly apiKey: string;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const settings = normalizeApiProviderSettings(input.settings);
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso), Effect.orDie);
    const profile = API_PROVIDER_PROFILE_BY_ID.get(settings.profileId as never);
    if (!profile) {
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: settings.enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Unknown API provider profile.",
        },
        apiCapabilities: apiCapabilities(
          settings.protocol,
          "unavailable",
          checkedAt,
          "Unknown API provider profile.",
        ),
      });
    }
    if (!input.apiKey.trim()) {
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          chatModelsFromSettings(settings),
          DEFAULT_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unauthenticated", type: "API key" },
          message: "Add an API key to verify this provider.",
        },
        apiCapabilities: apiCapabilities(
          settings.protocol,
          "unavailable",
          checkedAt,
          "Add an API key to verify this provider.",
        ),
      });
    }

    const baseUrl = settings.baseUrl.trim() || profile.defaultBaseUrl;
    const invalidBaseUrl = validateApiBaseUrl(baseUrl);
    if (invalidBaseUrl) {
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: settings.enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: invalidBaseUrl,
        },
        apiCapabilities: apiCapabilities(
          profile.protocol,
          "unavailable",
          checkedAt,
          invalidBaseUrl,
        ),
      });
    }
    const headers = buildApiProviderAuthHeaders({ settings, profile, apiKey: input.apiKey });
    const discoveryHeaders = {
      ...headers,
      ...(profile.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
    };
    const discovery = modelDiscoveryRequest({
      protocol: profile.protocol,
      baseUrl,
      headers: discoveryHeaders,
    });
    const manualModel = settings.customModels[0];
    const verifyManualModel =
      manualModel === undefined
        ? Effect.succeed(null)
        : testApiProvider(
            {
              profileId: profile.id,
              protocol: profile.protocol,
              baseUrl,
              apiKey: input.apiKey,
              model: manualModel,
            },
            input.httpClient,
          ).pipe(Effect.result);
    if (!discovery) {
      const manualResult = yield* verifyManualModel;
      if (manualResult?._tag === "Success") {
        return buildServerProvider({
          presentation: presentationFor(settings),
          enabled: settings.enabled,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            chatModelsFromSettings(settings),
            DEFAULT_CAPABILITIES,
          ),
          probe: {
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated", type: "API key", label: profile.displayName },
            message: `Manual model '${manualModel}' verified.`,
          },
          apiCapabilities: apiCapabilities(
            profile.protocol,
            "verified",
            checkedAt,
            "Authentication and manual generation verified; model discovery is unavailable.",
            true,
            "partial",
          ),
        });
      }
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          chatModelsFromSettings(settings),
          DEFAULT_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown", type: "API key", label: profile.displayName },
          message:
            "This profile does not expose a safe model-discovery endpoint; authentication and model access must be verified by a test generation request.",
        },
        apiCapabilities: apiCapabilities(
          profile.protocol,
          "partial",
          checkedAt,
          "The provider does not expose a safe model-discovery endpoint, so key and model access are not independently verified.",
        ),
      });
    }

    const result = yield* HttpClientRequest.get(discovery.url).pipe(
      HttpClientRequest.setHeaders(discoveryHeaders),
      input.httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.result,
    );
    if (result._tag === "Failure") {
      const manualResult = yield* verifyManualModel;
      if (manualResult?._tag === "Success") {
        return buildServerProvider({
          presentation: presentationFor(settings),
          enabled: settings.enabled,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            chatModelsFromSettings(settings),
            DEFAULT_CAPABILITIES,
          ),
          probe: {
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated", type: "API key", label: profile.displayName },
            message: `Model discovery is unavailable; manual model '${manualModel}' verified.`,
          },
          apiCapabilities: apiCapabilities(
            profile.protocol,
            "verified",
            checkedAt,
            "Authentication and manual generation verified; model discovery is unavailable.",
            true,
            "partial",
          ),
        });
      }
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          chatModelsFromSettings(settings),
          DEFAULT_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "The provider rejected the API key or model discovery request.",
        },
        apiCapabilities: apiCapabilities(
          profile.protocol,
          "unavailable",
          checkedAt,
          "The provider rejected the API key or model discovery request.",
        ),
      });
    }
    const records = normalizeModelList(profile.protocol, result.success, {
      profileId: String(profile.id),
    });
    const capabilities = capabilitiesForProtocol(profile.protocol, String(profile.id));
    return buildServerProvider({
      presentation: presentationFor(settings),
      enabled: settings.enabled,
      checkedAt,
      models: [
        ...modelRecordsToSnapshotModels(records, capabilities),
        ...providerModelsFromSettings([], chatModelsFromSettings(settings), capabilities),
      ],
      probe: {
        installed: true,
        version: null,
        status: records.length > 0 ? "ready" : "warning",
        auth: { status: "authenticated", type: "API key", label: profile.displayName },
        ...(records.length === 0
          ? { message: "Authentication succeeded, but the provider returned no models." }
          : {}),
      },
      apiCapabilities: apiCapabilities(
        profile.protocol,
        records.length > 0 ? "verified" : "partial",
        checkedAt,
        records.length > 0
          ? "Provider authentication and model catalog verified; selected-model invocation remains a separate check."
          : "Authentication succeeded, but no models were returned.",
        true,
      ),
    });
  });
