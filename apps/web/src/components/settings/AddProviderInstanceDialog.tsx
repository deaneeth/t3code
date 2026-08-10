"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ApiProviderSettings,
  ApiProviderProfileId,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { ACPRegistryIcon, Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  API_PROVIDER_PROFILE_OPTIONS,
  DRIVER_OPTION_BY_VALUE,
  DRIVER_OPTIONS,
  resolveApiProfileId,
} from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [testModel, setTestModel] = useState("");
  const [apiTestPassed, setApiTestPassed] = useState(false);
  const [apiTestError, setApiTestError] = useState<string | null>(null);
  const [isTestingApi, setIsTestingApi] = useState(false);
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const testApiProvider = useAtomCommand(serverEnvironment.testApiProvider, {
    reportFailure: false,
  });

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const instanceId =
    instanceIdOverride ??
    deriveInstanceId(
      driver,
      driver === "api" ? String(configDraft.profileId ?? "provider") : label,
    );
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    let nextConfig = config;
    if (driver === "api" && config !== undefined) {
      const inferredProfile = resolveApiProfileId({
        profileId: typeof config.profileId === "string" ? config.profileId : undefined,
        baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
      });
      const inferredOption = API_PROVIDER_PROFILE_OPTIONS.find(
        ([value]) => value === inferredProfile,
      );
      if (inferredOption && inferredProfile !== config.profileId) {
        nextConfig = { ...config, profileId: inferredProfile, protocol: inferredOption[2] };
      }
    }
    if (driver === "api") {
      setApiTestPassed(false);
      setApiTestError(null);
    }
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (nextConfig === undefined || Object.keys(nextConfig).length === 0) {
        delete next[driver];
      } else {
        next[driver] = nextConfig;
      }
      return next;
    });
  };

  const runApiTest = async () => {
    const settingsDraft = ApiProviderSettings.make({
      ...configDraft,
      enabled: true,
      profileId: String(configDraft.profileId ?? "openai"),
      protocol: String(
        configDraft.protocol ?? "openai-responses",
      ) as ApiProviderSettings["protocol"],
      baseUrl: String(configDraft.baseUrl ?? ""),
      apiKeyHeader: String(configDraft.apiKeyHeader ?? ""),
      apiKeyPrefix: String(configDraft.apiKeyPrefix ?? ""),
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: String(configDraft.organization ?? ""),
      project: String(configDraft.project ?? ""),
      region: String(configDraft.region ?? ""),
      customModels: Array.isArray(configDraft.customModels) ? configDraft.customModels : [],
    });
    if (!apiKey.trim()) {
      setApiTestError("Enter an API key first.");
      return;
    }
    if (!testModel.trim()) {
      setApiTestError("Enter a model ID for the verification request.");
      return;
    }
    setIsTestingApi(true);
    setApiTestPassed(false);
    setApiTestError(null);
    const result = await testApiProvider({
      environmentId,
      input: {
        profileId: ApiProviderProfileId.make(String(settingsDraft.profileId)),
        protocol: settingsDraft.protocol,
        baseUrl: settingsDraft.baseUrl,
        apiKeyHeader: settingsDraft.apiKeyHeader,
        apiKeyPrefix: settingsDraft.apiKeyPrefix,
        apiKey: apiKey.trim(),
        model: testModel.trim(),
      },
    });
    setIsTestingApi(false);
    if (result._tag === "Success") {
      setApiTestPassed(true);
      toastManager.add({
        type: "success",
        title: "API connection verified",
        description: `Received a response from ${result.value.model}.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setApiTestError(error instanceof Error ? error.message : "The provider test failed.");
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (driver === "api" && apiKey.trim().length === 0) {
      toastManager.add({
        type: "error",
        title: "API key required",
        description: "Add the provider API key before creating this instance.",
      });
      return;
    }
    if (driver === "api" && !apiTestPassed) {
      toastManager.add({
        type: "error",
        title: "Test the API connection first",
        description:
          "T3 only saves API providers after the current key, endpoint, and model return a valid response.",
      });
      return;
    }
    if (instanceIdError !== null) return;

    const config = configByDriver[driver] ?? {};
    const persistedConfig =
      driver === "api" && apiKey.trim().length > 0 && testModel.trim().length > 0
        ? {
            ...config,
            customModels: Array.from(
              new Set([
                ...(Array.isArray(config.customModels)
                  ? config.customModels.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : []),
                testModel.trim(),
              ]),
            ),
          }
        : config;
    const hasConfig = Object.keys(persistedConfig).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(driver === "api" && apiKey.trim().length > 0
        ? {
            environment: [
              {
                name: "T3_API_KEY",
                value: apiKey,
                sensitive: true,
              },
            ],
          }
        : {}),
      ...(hasConfig ? { config: persistedConfig } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add provider instance</DialogTitle>
            <DialogDescription>
              Configure an additional provider instance on {environmentLabel} — for example, a
              second Codex install pointed at a different workspace.
            </DialogDescription>
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              onNavigation={applyWizardNavigation}
            />
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            <AnimatedHeight>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  Driver
                </div>
                <RadioGroup
                  value={driver}
                  onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                      >
                        <IconComponent className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <RadioPrimitive.Indicator
                          className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                          aria-hidden
                        >
                          <CheckIcon className="size-3.5 shrink-0" />
                        </RadioPrimitive.Indicator>
                        {option.badgeLabel ? (
                          <Badge variant="warning" size="sm">
                            {option.badgeLabel}
                          </Badge>
                        ) : null}
                      </RadioPrimitive.Root>
                    );
                  })}
                  {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        disabled
                        className={cn(
                          "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-55 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
                        )}
                      >
                        <IconComponent
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <Badge variant="warning" size="sm">
                          Coming Soon
                        </Badge>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  className="bg-background"
                  placeholder="e.g. Work"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Shown in the provider list. Optional.
                </span>
              </label>

              <label
                className={cn("grid gap-2", (wizardStep !== 1 || driver === "api") && "hidden")}
              >
                <span className="text-xs font-medium text-foreground">Instance ID</span>
                <Input
                  className="bg-background"
                  placeholder={`${driver}_work`}
                  value={instanceId}
                  onChange={(event) => {
                    setInstanceIdOverride(event.target.value);
                  }}
                  aria-invalid={showInstanceIdError}
                />
                {showInstanceIdError ? (
                  <span className="text-[11px] text-destructive">{instanceIdError}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Routing key used by threads and sessions. Letters, digits, '-', or '_'.
                  </span>
                )}
              </label>

              <div className={cn("grid gap-2", (wizardStep !== 1 || driver === "api") && "hidden")}>
                <span className="text-xs font-medium text-foreground">Accent color</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
                    onChange={(event) => setAccentColor(event.target.value)}
                    aria-label="Provider instance accent color"
                    className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                      const selected = accentColor.toLowerCase() === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          className={cn(
                            "size-6 cursor-pointer rounded-full border transition",
                            selected
                              ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                              : "border-black/10 hover:scale-105 dark:border-white/20",
                          )}
                          style={{ backgroundColor: swatch }}
                          onClick={() => setAccentColor(swatch)}
                          aria-label={`Use ${swatch} accent`}
                        />
                      );
                    })}
                  </div>
                  {accentColor ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setAccentColor("")}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Optional marker shown in the picker.
                </span>
              </div>

              {driver === "api" ? (
                <div className={cn("grid gap-3", wizardStep !== 2 && "hidden")}>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">API profile</span>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={String(configDraft.profileId ?? "openai")}
                      onChange={(event) => {
                        const selected = API_PROVIDER_PROFILE_OPTIONS.find(
                          ([value]) => value === event.target.value,
                        );
                        setConfigDraft({
                          ...configDraft,
                          profileId: event.target.value,
                          protocol: selected?.[2] ?? "openai-chat-completions",
                        });
                      }}
                    >
                      {API_PROVIDER_PROFILE_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <span className="text-[11px] text-muted-foreground">
                      Select the provider protocol. T3 will verify the key server-side and mark
                      unavailable account data explicitly.
                    </span>
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">API key</span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setApiTestPassed(false);
                        setApiTestError(null);
                      }}
                      placeholder="Stored securely on the T3 server"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      The key is saved as a sensitive provider secret and is never returned to the
                      client.
                    </span>
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">Test model ID</span>
                    <Input
                      value={testModel}
                      onChange={(event) => {
                        setTestModel(event.target.value);
                        setApiTestPassed(false);
                        setApiTestError(null);
                      }}
                      placeholder="e.g. sensenova-6.7-flash-lite"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      T3 sends one tiny request with this model before allowing the provider to be
                      added.
                    </span>
                  </label>
                  <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void runApiTest()}
                      disabled={isTestingApi || !apiKey.trim() || !testModel.trim()}
                    >
                      {isTestingApi
                        ? "Testing connection…"
                        : apiTestPassed
                          ? "Connection verified"
                          : "Test connection"}
                    </Button>
                    {apiTestPassed ? (
                      <p className="text-xs text-emerald-600">
                        The key, endpoint, protocol, and model returned a valid response.
                      </p>
                    ) : null}
                    {apiTestError ? (
                      <p className="text-xs text-destructive">{apiTestError}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {driverSettingsFields.length > 0 ? (
                <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    onChange={setConfigDraft}
                  />
                </div>
              ) : wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    This driver has no required configuration. You can add the instance now.
                  </p>
                </div>
              ) : null}
            </AnimatedHeight>
          </div>

          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (wizardStep === 0) {
                  onOpenChange(false);
                  return;
                }
                setWizardStep((step) => Math.max(0, step - 1));
              }}
            >
              {wizardStep === 0 ? "Cancel" : "Back"}
            </Button>
            {wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
              <Button size="sm" onClick={() => navigateToStep(wizardStep + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave} disabled={driver === "api" && !apiTestPassed}>
                Add instance
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
