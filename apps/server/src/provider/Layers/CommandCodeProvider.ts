import {
  type CommandCodeSettings,
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const COMMANDCODE_PRESENTATION = {
  displayName: "CommandCode",
  showInteractionModeToggle: true,
} as const;
const COMMANDCODE_AUTH_TIMEOUT_MS = 20_000;
const COMMANDCODE_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

const EMPTY_COMMANDCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const COMMANDCODE_EFFORTS_BY_MODEL: Readonly<Record<string, ReadonlyArray<string>>> = {
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "qwen/qwen3.8-max": ["low", "medium", "xhigh"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
};

function commandCodeModelCapabilities(slug: string): ModelCapabilities {
  const efforts = COMMANDCODE_EFFORTS_BY_MODEL[slug.toLowerCase()];
  if (!efforts) return EMPTY_COMMANDCODE_MODEL_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: efforts.map((effort, index) => ({
          id: effort,
          label: effort === "xhigh" ? "Extra High" : effort[0]!.toUpperCase() + effort.slice(1),
          ...(index === 0 ? { isDefault: true } : {}),
        })),
        currentValue: efforts[0],
      },
    ],
  });
}

const COMMANDCODE_MODEL_FALLBACKS: ReadonlyArray<string> = [
  "deepseek/deepseek-v4-flash",
  "claude-sonnet-4-6",
  "gpt-5.5",
];

const MODEL_HEADINGS = new Set([
  "Anthropic",
  "Google",
  "Meta",
  "OpenAI",
  "Open Source",
  "Sakana",
  "xAI",
]);

function displayModelName(slug: string): string {
  const model = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  return model
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Parse the human-readable output of `command-code --list-models`. */
export function parseCommandCodeModels(output: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available models") || trimmed.startsWith("Pass the")) {
      continue;
    }

    const slug = trimmed.split(/\s+/u)[0];
    if (
      !slug ||
      MODEL_HEADINGS.has(trimmed) ||
      (!slug.includes("/") && !/^(?:claude|gpt)-/u.test(slug))
    ) {
      continue;
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(slug) || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    models.push({
      slug,
      name: displayModelName(slug),
      ...(slug.includes("/") ? { subProvider: slug.slice(0, slug.indexOf("/")) } : {}),
      isCustom: false,
      ...(line.includes("(default)") ? { isDefault: true } : {}),
      capabilities: commandCodeModelCapabilities(slug),
    });
  }

  return models;
}

export function commandCodeModelsFromSettings(
  discoveredModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const models = providerModelsFromSettings(
    discoveredModels,
    customModels,
    EMPTY_COMMANDCODE_MODEL_CAPABILITIES,
  );
  if (models.some((model) => model.isDefault)) return models;
  return models.map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));
}

function commandCodeFallbackModels(
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return commandCodeModelsFromSettings(
    parseCommandCodeModels(COMMANDCODE_MODEL_FALLBACKS.join("\n")),
    customModels,
  );
}

function stringValueTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseCommandCodeAuth(output: string): {
  readonly status: "authenticated" | "unauthenticated" | "unknown";
  readonly label?: string;
} {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { readonly authenticated?: unknown; readonly user?: unknown };
      const label = stringValueTrimmed(record.user) ?? "Command Code";
      if (record.authenticated === true) return { status: "authenticated", label };
      if (record.authenticated === false) return { status: "unauthenticated" };
    }
  } catch {
    // `status` without `--json` is still supported for older CommandCode builds.
  }

  const lower = output.toLowerCase();
  if (
    /not authenticated|unauthenticated|log in|login required|authentication required|no auth required|no auth/u.test(
      lower,
    )
  ) {
    return { status: "unauthenticated" };
  }
  if (/authentication verified|authenticated|logged in/u.test(lower)) {
    return { status: "authenticated", label: "Command Code" };
  }
  return { status: "unknown" };
}

const runCommandCodeCommand = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, args, {
      env: environment,
      extendEnv: true,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: true,
        shell: spawnCommand.shell,
      }),
    );
  });

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableSnapshot(
  settings: CommandCodeSettings,
  checkedAt: string,
  models: ReadonlyArray<ServerProviderModel>,
  message: string,
  installed = false,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: COMMANDCODE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: {
      installed,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message,
    },
  });
}

export const makePendingCommandCodeProvider = (
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: commandCodeModelsFromSettings([], settings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking CommandCode availability…",
      },
    }),
  );

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeFallbackModels(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "CommandCode is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCommandCodeCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      return unavailableSnapshot(
        settings,
        checkedAt,
        fallbackModels,
        isCommandMissingCause(error)
          ? "CommandCode (`command-code`) is not installed or not on PATH."
          : `CommandCode version check failed: ${commandErrorMessage(error)}`,
        !isCommandMissingCause(error),
      );
    }
    if (Option.isNone(versionResult.success)) {
      return unavailableSnapshot(
        settings,
        checkedAt,
        fallbackModels,
        "CommandCode is installed but the version check timed out.",
        true,
      );
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: detailFromResult(versionOutput) ?? "CommandCode failed to run.",
        },
      });
    }

    const statusResult = yield* runCommandCodeCommand(
      settings,
      ["status", "--json"],
      environment,
    ).pipe(Effect.timeoutOption(COMMANDCODE_AUTH_TIMEOUT_MS), Effect.result);
    const auth = Result.isSuccess(statusResult)
      ? Option.isSome(statusResult.success)
        ? parseCommandCodeAuth(
            `${statusResult.success.value.stdout}\n${statusResult.success.value.stderr}`,
          )
        : { status: "unknown" as const }
      : { status: "unknown" as const };

    const modelsResult = yield* runCommandCodeCommand(
      settings,
      ["--list-models"],
      environment,
    ).pipe(Effect.timeoutOption(COMMANDCODE_MODEL_DISCOVERY_TIMEOUT_MS), Effect.result);
    const discoveredModels =
      Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
        ? parseCommandCodeModels(
            `${modelsResult.success.value.stdout}\n${modelsResult.success.value.stderr}`,
          )
        : [];
    const models = commandCodeModelsFromSettings(discoveredModels, settings.customModels);
    const statusMessage =
      auth.status === "unauthenticated"
        ? "CommandCode is installed but not authenticated."
        : Result.isFailure(statusResult) || Option.isNone(statusResult.success)
          ? "CommandCode is installed; authentication status could not be checked."
          : undefined;

    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: models.length > 0 ? models : fallbackModels,
      probe: {
        installed: true,
        version,
        status: auth.status === "authenticated" ? "ready" : "warning",
        auth: {
          status: auth.status,
          ...(auth.label ? { label: auth.label } : {}),
          type: "commandcode",
        },
        ...(statusMessage ? { message: statusMessage } : {}),
      },
    });
  },
);
