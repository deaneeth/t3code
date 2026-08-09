import type {
  ProviderLimitSnapshot,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { AlertCircleIcon, BotIcon, CheckCircle2Icon, CircleXIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useCommandCodeUsage, type CommandCodeUsageData } from "../../hooks/useCommandCodeUsage";
import { useProviderLimits } from "../../hooks/useProviderLimits";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK } from "./usageProviders";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatTokens } from "../../usage/usageFormat";

type ProviderRow = {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
};

export function ProviderPlansPanel({ refreshSignal = 0 }: { readonly refreshSignal?: number }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const rows = useMemo<ReadonlyArray<ProviderRow>>(
    () =>
      [...serverConfigs.entries()].flatMap(([environmentId, config]) => {
        const environmentLabel =
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          config.environment.label;
        return config.providers.map((provider) => ({ environmentId, environmentLabel, provider }));
      }),
    [environments, serverConfigs],
  );
  // The raw HTTP telemetry endpoint belongs to the primary connected server.
  // Do not apply an identically named instance from another environment to it.
  const commandCodeRows = rows.filter(
    (row) => row.environmentId === primaryEnvironmentId && row.provider.driver === "commandcode",
  );
  const commandCodeInstanceId =
    commandCodeRows.length === 1 ? commandCodeRows[0]?.provider.instanceId : null;
  const commandCodeEnabled =
    commandCodeRows.length > 0 && commandCodeRows.some((row) => row.provider.enabled);
  const commandCodeUsage = useCommandCodeUsage(
    commandCodeEnabled && commandCodeRows.length === 1,
    commandCodeInstanceId,
  );
  const providerLimits = useProviderLimits(true);
  const refetchCommandCodeUsage = commandCodeUsage.refetch;
  const refetchProviderLimits = providerLimits.refetch;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  useEffect(() => {
    if (refreshSignal === 0) return;
    for (const environmentId of serverConfigs.keys()) {
      void refreshServerProviders({ environmentId, input: {} });
    }
    void refetchProviderLimits();
    if (commandCodeEnabled && commandCodeRows.length === 1) {
      void refetchCommandCodeUsage();
    }
  }, [
    commandCodeEnabled,
    commandCodeRows.length,
    refetchCommandCodeUsage,
    refetchProviderLimits,
    refreshServerProviders,
    refreshSignal,
    serverConfigs,
  ]);
  const limitsByInstance = useMemo(
    () =>
      new Map(
        (providerLimits.data?.snapshots ?? []).map((snapshot) => [snapshot.instanceId, snapshot]),
      ),
    [providerLimits.data],
  );

  if (rows.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        No provider instances configured.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">Plans &amp; limits</h2>
          <p className="text-xs text-muted-foreground">
            Live provider status, account details, model availability and reported quota windows.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {providerLimits.loading && !providerLimits.data
            ? "Reading provider telemetry…"
            : providerLimits.data
              ? `Telemetry read ${formatAge(providerLimits.data.readAt)}`
              : providerLimits.error
                ? "Telemetry unavailable"
                : "No telemetry reported"}
        </span>
      </div>

      {providerLimits.error ? (
        <p className="border border-border px-3 py-2 text-xs text-muted-foreground">
          Provider quota telemetry is unavailable: {providerLimits.error}. Status and model data
          below are still live from the provider registry.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => {
          const commandCodeData =
            row.provider.instanceId === commandCodeInstanceId ? commandCodeUsage.data : null;
          return (
            <ProviderPlanCard
              key={`${row.environmentId}:${row.provider.instanceId}`}
              row={row}
              limit={
                row.environmentId === primaryEnvironmentId
                  ? (limitsByInstance.get(row.provider.instanceId) ?? null)
                  : null
              }
              commandCodeData={commandCodeData}
              commandCodeLoading={
                row.provider.instanceId === commandCodeInstanceId && commandCodeUsage.loading
              }
              commandCodeError={
                row.provider.instanceId === commandCodeInstanceId ? commandCodeUsage.error : null
              }
              commandCodeAmbiguous={
                row.provider.driver === "commandcode" && commandCodeRows.length > 1
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function ProviderPlanCard({
  row,
  limit,
  commandCodeData,
  commandCodeLoading,
  commandCodeError,
  commandCodeAmbiguous,
}: {
  readonly row: ProviderRow;
  readonly limit: ProviderLimitSnapshot | null;
  readonly commandCodeData: CommandCodeUsageData | null;
  readonly commandCodeLoading: boolean;
  readonly commandCodeError: string | null;
  readonly commandCodeAmbiguous: boolean;
}) {
  const { provider } = row;
  const [modelsOpen, setModelsOpen] = useState(false);
  const status = provider.availability === "unavailable" ? "unavailable" : provider.status;
  const statusText = provider.availability === "unavailable" ? "missing driver" : status;
  const usageProvider = toUsageProvider(provider.driver);
  const Mark = usageProvider ? PROVIDER_MARK[usageProvider] : BotIcon;
  const accent =
    provider.accentColor ?? (usageProvider ? PROVIDER_COLOR[usageProvider] : undefined);

  return (
    <article className="flex min-w-0 flex-col gap-4 border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Mark
            className="size-4 shrink-0"
            style={accent ? { color: accent } : undefined}
            aria-hidden
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-foreground">
              {provider.displayName ??
                (usageProvider ? PROVIDER_LABEL[usageProvider] : provider.driver)}
            </h3>
            <p className="truncate text-xs text-muted-foreground">
              {row.environmentLabel} · {provider.instanceId}
            </p>
          </div>
        </div>
        <ProviderStatus status={status} label={statusText} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <ProviderDetail label="Access" value={provider.enabled ? "Active" : "Deactivated"} />
        <ProviderDetail
          label="Authentication"
          value={provider.auth.label ?? provider.auth.type ?? provider.auth.status}
        />
        <ProviderDetail label="Version" value={provider.version ?? "Not reported"} />
        <ProviderDetail label="Models" value={`${provider.models.length}`} />
        {provider.auth.email ? (
          <ProviderDetail label="Account" value={provider.auth.email} />
        ) : null}
        <ProviderDetail label="Checked" value={formatDate(provider.checkedAt)} />
      </dl>

      {provider.message || provider.unavailableReason ? (
        <p className="border border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
          {provider.unavailableReason ?? provider.message}
        </p>
      ) : null}

      {provider.driver === "commandcode" ? (
        <CommandCodePlanDetails
          data={commandCodeData}
          loading={commandCodeLoading}
          error={commandCodeError}
          ambiguous={commandCodeAmbiguous}
        />
      ) : (
        <ProviderTelemetry limit={limit} />
      )}

      <div className="border-t border-border/60 pt-3">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setModelsOpen((open) => !open)}
          aria-expanded={modelsOpen}
        >
          {modelsOpen ? "Hide" : "Show"} {provider.models.length} available model
          {provider.models.length === 1 ? "" : "s"}
        </button>
        {modelsOpen ? <ModelList models={provider.models} /> : null}
      </div>
    </article>
  );
}

function ProviderTelemetry({ limit }: { readonly limit: ProviderLimitSnapshot | null }) {
  if (!limit || (limit.windows.length === 0 && !limit.credits && !limit.spendControl)) {
    return (
      <div className="border border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
        No provider-reported quota telemetry is available for this instance.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Provider-reported limits</span>
        <span className="text-[11px] text-muted-foreground">
          updated {formatAge(limit.updatedAt)}
        </span>
      </div>
      {limit.planType ? (
        <p className="text-xs text-muted-foreground">Plan: {limit.planType}</p>
      ) : null}
      {limit.windows.map((window) => (
        <QuotaWindow key={window.label} window={window} />
      ))}
      {limit.credits ? (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Credits</span>
          <span className="text-foreground tabular-nums">
            {limit.credits.unlimited
              ? "Unlimited"
              : (limit.credits.balance ?? "Balance not reported")}
          </span>
        </div>
      ) : null}
      {limit.spendControl ? (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Spend control</span>
          <span className="text-foreground tabular-nums">
            {limit.spendControl.remainingPercent}% remaining · {limit.spendControl.used} of{" "}
            {limit.spendControl.limit}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function CommandCodePlanDetails({
  data,
  loading,
  error,
  ambiguous,
}: {
  readonly data: CommandCodeUsageData | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly ambiguous: boolean;
}) {
  if (ambiguous) {
    return (
      <ProviderTelemetryMessage>
        Live plan data is instance-specific; multiple CommandCode accounts were found.
      </ProviderTelemetryMessage>
    );
  }
  if (loading && !data)
    return (
      <ProviderTelemetryMessage>Reading the live CommandCode account…</ProviderTelemetryMessage>
    );
  if (error)
    return (
      <ProviderTelemetryMessage>
        Live CommandCode account unavailable: {error}
      </ProviderTelemetryMessage>
    );
  if (!data)
    return (
      <ProviderTelemetryMessage>
        Live CommandCode plan data is not available.
      </ProviderTelemetryMessage>
    );
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Live plan</span>
        <span className="text-xs text-muted-foreground">
          {data.plan.displayName} · {data.plan.status}
        </span>
      </div>
      <QuotaBar
        label="Credit cycle"
        percentage={data.cycle.usagePercent}
        detail={`${formatUsd(data.cycle.totalSpent)} spent · ${formatUsd(data.cycle.totalRemaining)} left`}
      />
      <QuotaBar
        label="5-hour limit"
        percentage={data.windowLimits.fiveHour.percentage}
        detail={formatLiveLimit(data.windowLimits.fiveHour)}
      />
      <QuotaBar
        label="Weekly limit"
        percentage={data.windowLimits.weekly.percentage}
        detail={formatLiveLimit(data.windowLimits.weekly)}
      />
      <span className="text-[11px] text-muted-foreground">
        {data.plan.currentPeriodEnd
          ? `Renews ${formatDate(data.plan.currentPeriodEnd)}`
          : "Renewal date not reported"}{" "}
        · {formatTokens(data.cycle.totalRequests)} requests
      </span>
    </div>
  );
}

function ProviderTelemetryMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function QuotaWindow({ window }: { readonly window: ProviderLimitSnapshot["windows"][number] }) {
  return (
    <QuotaBar
      label={window.label}
      percentage={window.usedPercent}
      detail={formatReset(window.resetsAtMs)}
    />
  );
}

function QuotaBar({
  label,
  percentage,
  detail,
}: {
  readonly label: string;
  readonly percentage: number;
  readonly detail: string;
}) {
  const safePercentage = Math.max(0, Math.min(100, percentage));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">{Math.round(safePercentage)}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground" style={{ width: `${safePercentage}%` }} />
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">{detail}</span>
    </div>
  );
}

function ModelList({ models }: { readonly models: ReadonlyArray<ServerProviderModel> }) {
  if (models.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground">No models reported.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
      {models.map((model) => (
        <li key={model.slug} className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{model.name}</span>
          {model.isDefault ? (
            <span className="shrink-0 text-[10px] text-foreground">default</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ProviderDetail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs text-foreground">{value}</dd>
    </div>
  );
}

function ProviderStatus({ status, label }: { readonly status: string; readonly label: string }) {
  const Icon =
    status === "ready"
      ? CheckCircle2Icon
      : status === "error" || status === "unavailable"
        ? CircleXIcon
        : AlertCircleIcon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        status === "ready"
          ? "text-emerald-500"
          : status === "error" || status === "unavailable"
            ? "text-red-400"
            : "text-amber-400",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

function toUsageProvider(driver: string): keyof typeof PROVIDER_LABEL | null {
  if (driver === "claudeAgent" || driver === "claude") return "claude";
  if (driver === "codex" || driver === "opencode" || driver === "commandcode") return driver;
  return null;
}

function formatUsd(value: number): string {
  return `$${Math.max(0, Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function formatLiveLimit(limit: CommandCodeUsageData["windowLimits"]["weekly"]): string {
  return `${formatUsd(limit.used)} of ${formatUsd(limit.cap)} · ${limit.resetsIn}`;
}

function formatReset(resetAtMs: number | null): string {
  if (resetAtMs === null || resetAtMs <= 0) return "Reset not reported";
  const diff = resetAtMs - Date.now();
  if (diff <= 0) return "Resetting soon";
  const minutes = Math.ceil(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return `Resets in ${days > 0 ? `${days}d ` : ""}${hours > 0 ? `${hours}h ` : ""}${rest > 0 && days === 0 ? `${rest}m` : ""}`.trim();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "Not reported";
}

function formatAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "at an unknown time";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}
