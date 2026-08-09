import type {
  ProviderLimitSnapshot,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleXIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useCommandCodeUsage, type CommandCodeUsageData } from "../../hooks/useCommandCodeUsage";
import { useProviderLimits } from "../../hooks/useProviderLimits";
import { cn } from "../../lib/utils";
import { Card, CardFooter, CardHeader, CardPanel } from "../ui/card";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatTokens } from "../../usage/usageFormat";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK } from "./usageProviders";

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
        return config.providers
          .filter((provider) => provider.enabled && provider.availability !== "unavailable")
          .map((provider) => ({ environmentId, environmentLabel, provider }));
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
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
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

      <div className="grid gap-5 lg:grid-cols-2">
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
    <Card className="min-w-0 gap-0 overflow-hidden rounded-xl border-border/80 bg-card/30 shadow-none">
      <CardHeader className="flex grid-cols-none grid-rows-none flex-row items-start justify-between gap-3 p-5 pb-4">
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
      </CardHeader>

      <CardPanel className="flex flex-col gap-5 px-5 pb-5 pt-0">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-xs">
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
          <p className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5 text-xs text-muted-foreground">
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
      </CardPanel>

      <CardFooter className="border-t border-border/60 px-5 py-3.5">
        <Popover open={modelsOpen} onOpenChange={setModelsOpen}>
          <PopoverTrigger
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={modelsOpen}
          >
            <span className="truncate">
              {modelsOpen ? "Hide" : "Show"} {provider.models.length} available model
              {provider.models.length === 1 ? "" : "s"}
            </span>
            <ChevronDownIcon
              className={cn("size-3.5 shrink-0 transition-transform", modelsOpen && "rotate-180")}
              aria-hidden
            />
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="start"
            sideOffset={8}
            className="w-[min(24rem,calc(100vw-2rem))]"
            viewportClassName="p-0"
          >
            <div className="p-4">
              <PopoverTitle className="text-sm">Available models</PopoverTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {provider.models.length} model{provider.models.length === 1 ? "" : "s"} reported by{" "}
                {provider.displayName ?? provider.driver}.
              </p>
              <div className="mt-3 max-h-72 overflow-y-auto overscroll-contain pr-1">
                <ModelList models={provider.models} />
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </CardFooter>
    </Card>
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
        <span
          className={cn(
            "text-[11px]",
            limit.status === "rejected"
              ? "text-red-400"
              : limit.status === "warning"
                ? "text-amber-400"
                : "text-muted-foreground",
          )}
        >
          {limit.status === "rejected"
            ? "Limit reached"
            : limit.status === "warning"
              ? "Approaching limit"
              : "Up to date"}
          {" · "}
          updated {formatAge(limit.updatedAt)}
        </span>
      </div>
      {limit.status === "warning" || limit.status === "rejected" ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
            limit.status === "rejected"
              ? "border-red-500/30 bg-red-500/5 text-red-300"
              : "border-amber-500/30 bg-amber-500/5 text-amber-200",
          )}
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {limit.status === "rejected"
              ? "The provider reported a reached quota. New requests may be throttled until a window resets."
              : "A provider quota is near its limit. Consider reducing usage or waiting for the reset."}
          </span>
        </div>
      ) : null}
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
      {data.windowLimits.limited ? (
        <>
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
        </>
      ) : (
        <ProviderTelemetryMessage>
          Rolling request limits are not reported for this plan.
        </ProviderTelemetryMessage>
      )}
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
  const barColor =
    safePercentage >= 80
      ? "var(--color-red-500)"
      : safePercentage >= 50
        ? "var(--color-amber-500)"
        : "var(--color-green-500)";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">{Math.round(safePercentage)}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted/70"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safePercentage)}
        aria-label={`${label} usage`}
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500 motion-reduce:transition-none"
          style={{ width: `${safePercentage}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">{detail}</span>
      {safePercentage >= 80 ? (
        <span
          className={
            safePercentage >= 100 ? "text-[11px] text-red-400" : "text-[11px] text-amber-400"
          }
        >
          {safePercentage >= 100 ? "Limit reached." : "Approaching limit."}
        </span>
      ) : null}
    </div>
  );
}

function ModelList({ models }: { readonly models: ReadonlyArray<ServerProviderModel> }) {
  if (models.length === 0)
    return <p className="text-xs text-muted-foreground">No models reported.</p>;
  return (
    <ul className="grid gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-2">
      {models.map((model) => (
        <li key={model.slug} className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate" title={model.name}>
            {model.name}
          </span>
          {model.isDefault ? (
            <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-foreground">
              default
            </span>
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
