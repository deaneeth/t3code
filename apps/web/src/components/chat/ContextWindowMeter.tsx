import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useCommandCodeUsage } from "~/hooks/useCommandCodeUsage";
import { useProviderLimits } from "~/hooks/useProviderLimits";
import { useProviderRateLimits } from "~/hooks/useProviderRateLimits";
import {
  formatRateLimitReachedReason,
  formatRateLimitResetsIn,
  toProviderRateLimitSnapshot,
  type ProviderRateLimitSnapshot,
} from "~/lib/rateLimits";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

const COMMANDCODE_USAGE_URL = "https://commandcode.ai/usage";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function TokenBreakdownBar(props: {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}) {
  const { label, value, maxValue, color } = props;
  const percentage = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  if (value <= 0) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] leading-4">
      <span className="w-16 shrink-0 text-muted-foreground/60">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percentage}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground/70">
        {formatContextWindowTokens(value)}
      </span>
    </div>
  );
}

function formatCredits(value: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `$${safeValue.toFixed(2)}`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function CommandCodeUsageBar(props: { percentage: number; hasData: boolean }) {
  const { percentage, hasData } = props;

  if (!hasData) {
    return <div className="text-[11px] text-muted-foreground/60">Plan details unavailable</div>;
  }

  const getUsageColor = (pct: number) => {
    if (pct >= 80) return "var(--color-red-500)";
    if (pct >= 50) return "var(--color-amber-500)";
    return "var(--color-green-500)";
  };

  const roundedPct = Math.round(percentage);

  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${Math.min(100, percentage)}%`,
            backgroundColor: getUsageColor(percentage),
          }}
        />
      </div>
      <div className="text-[11px] font-medium text-muted-foreground/80">{roundedPct}% used</div>
    </div>
  );
}

function CommandCodeWindowBar(props: {
  label: string;
  percentage: number;
  exceeded: boolean;
  resetsIn: string;
}) {
  const { label, percentage, exceeded, resetsIn } = props;

  const getUsageColor = (pct: number) => {
    if (pct >= 80) return "var(--color-red-500)";
    if (pct >= 50) return "var(--color-amber-500)";
    return "var(--color-green-500)";
  };

  const getTextColor = (pct: number) => {
    if (pct >= 80) return "text-red-500/80";
    if (pct >= 50) return "text-amber-500/80";
    return "text-green-500/80";
  };

  const roundedPct = Math.round(percentage);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] leading-4">
        <span className="text-muted-foreground/60">{label}</span>
        <span className={`font-medium tabular-nums ${getTextColor(percentage)}`}>
          {roundedPct}%{resetsIn ? ` · resets in ${resetsIn}` : ""}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${Math.min(100, percentage)}%`,
            backgroundColor: getUsageColor(percentage),
          }}
        />
      </div>
      {exceeded ? (
        <div className="text-[10px] text-red-500/80">Limit reached. Requests may be throttled.</div>
      ) : null}
    </div>
  );
}

function ProviderRateLimitWindowBar(props: {
  label: string;
  usedPercent: number;
  resetsIn: string;
  status: "allowed" | "warning" | "rejected" | null;
}) {
  const { label, usedPercent, resetsIn, status } = props;

  const getUsageColor = (pct: number, st: "allowed" | "warning" | "rejected" | null) => {
    if (st === "rejected" || pct >= 80) return "var(--color-red-500)";
    if (st === "warning" || pct >= 50) return "var(--color-amber-500)";
    return "var(--color-green-500)";
  };

  const getTextColor = (pct: number, st: "allowed" | "warning" | "rejected" | null) => {
    if (st === "rejected" || pct >= 80) return "text-red-500/80";
    if (st === "warning" || pct >= 50) return "text-amber-500/80";
    return "text-green-500/80";
  };

  const roundedPct = Math.round(usedPercent);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] leading-4">
        <span className="text-muted-foreground/60">{label}</span>
        <span className={`font-medium tabular-nums ${getTextColor(usedPercent, status)}`}>
          {roundedPct}%{resetsIn ? ` · resets in ${resetsIn}` : ""}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${Math.min(100, usedPercent)}%`,
            backgroundColor: getUsageColor(usedPercent, status),
          }}
        />
      </div>
      {status === "rejected" ? (
        <div className="text-[10px] text-red-500/80">Limit reached. Requests may be throttled.</div>
      ) : null}
    </div>
  );
}

function ProviderRateLimitSection(props: { snapshot: ProviderRateLimitSnapshot }) {
  const { snapshot } = props;
  const { windows, credits, spendControl, planType, status, reachedType } = snapshot;

  const getStatusColor = () => {
    if (status === "rejected") return "text-red-500/80";
    if (status === "warning") return "text-amber-500/80";
    return "text-green-500/80";
  };

  const getStatusLabel = () => {
    if (status === "rejected") return "Rate limited";
    if (status === "warning") return "Approaching limit";
    return "OK";
  };

  const reachedReason = formatRateLimitReachedReason(reachedType);
  const hasNoData = windows.length === 0 && !credits && !spendControl && !planType;
  const reportedAge = formatRateLimitReportedAge(snapshot.updatedAt);

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-muted/60 pt-2">
      <div className="flex items-center justify-between text-[11px] leading-4">
        <span className="text-muted-foreground/60">Rate Limits</span>
        {hasNoData ? (
          <span className="text-muted-foreground/50">No data</span>
        ) : (
          <span className={`font-medium ${getStatusColor()}`}>{getStatusLabel()}</span>
        )}
      </div>
      {reportedAge ? (
        <div className="text-[10px] text-muted-foreground/50">Last reported {reportedAge}</div>
      ) : null}
      {reachedReason && status === "rejected" ? (
        <div className="text-[11px] text-red-500/80">{reachedReason}</div>
      ) : null}
      {planType ? (
        <div className="flex items-center justify-between text-[11px] leading-4">
          <span className="text-muted-foreground/60">Plan</span>
          <span className="font-medium text-muted-foreground/80">{planType}</span>
        </div>
      ) : null}
      {windows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {windows.map((window, index) => (
            <ProviderRateLimitWindowBar
              key={`${window.label}-${index}`}
              label={window.label}
              usedPercent={window.usedPercent}
              resetsIn={formatRateLimitResetsIn(window.resetsAt)}
              status={status}
            />
          ))}
        </div>
      ) : null}
      {credits ? (
        <div className="flex flex-col gap-1">
          {credits.unlimited ? (
            <div className="flex items-center justify-between text-[11px] leading-4">
              <span className="text-muted-foreground/60">Credits</span>
              <span className="font-medium text-green-500/80">Unlimited</span>
            </div>
          ) : credits.hasCredits && credits.balance ? (
            <div className="flex items-center justify-between text-[11px] leading-4">
              <span className="text-muted-foreground/60">Balance</span>
              <span className="font-medium text-muted-foreground/80">${credits.balance}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] leading-4">
              <span className="text-muted-foreground/60">Credits</span>
              <span className="font-medium text-muted-foreground/80">None</span>
            </div>
          )}
        </div>
      ) : null}
      {spendControl ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px] leading-4">
            <span className="text-muted-foreground/60">Spend</span>
            <span className="font-medium text-muted-foreground/80">
              ${spendControl.used} / ${spendControl.limit}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatRateLimitReportedAge(updatedAt: string): string | null {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return null;
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null;
  providerDriverKind?: string | null;
  providerInstanceId?: string | null;
  activities?: ReadonlyArray<OrchestrationThreadActivity> | undefined;
}) {
  const { usage, providerDisplayName, providerDriverKind, providerInstanceId, activities } = props;
  const isCommandCode = providerDriverKind === "commandcode";
  const isCodexOrClaude = providerDriverKind === "codex" || providerDriverKind === "claude";
  const {
    data: commandCodeUsage,
    loading: commandCodeLoading,
    error: commandCodeError,
  } = useCommandCodeUsage(isCommandCode, providerInstanceId);
  const rateLimits = useProviderRateLimits(
    activities ?? null,
    isCodexOrClaude ? providerDriverKind : null,
  );
  const { data: providerLimits } = useProviderLimits(isCodexOrClaude);
  const liveRateLimits = useMemo(() => {
    if (!providerLimits) return null;
    const snapshot = providerLimits.snapshots.find(
      (candidate) =>
        (candidate.instanceId === providerInstanceId || !providerInstanceId) &&
        (candidate.driver === providerDriverKind ||
          (providerDriverKind === "claude" && candidate.driver === "claudeAgent")),
    );
    return snapshot ? toProviderRateLimitSnapshot(snapshot) : null;
  }, [providerDriverKind, providerInstanceId, providerLimits]);
  const effectiveRateLimits = liveRateLimits ?? rateLimits;
  const [, setRateLimitTick] = useState(0);
  useEffect(() => {
    if (!effectiveRateLimits) return;
    const interval = globalThis.setInterval(() => setRateLimitTick((value) => value + 1), 30_000);
    return () => globalThis.clearInterval(interval);
  }, [effectiveRateLimits]);
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const reasoningOutputTokens = usage.reasoningOutputTokens ?? 0;
  const hasTokenBreakdown =
    inputTokens > 0 ||
    outputTokens > 0 ||
    cachedInputTokens > 0 ||
    cacheCreationTokens > 0 ||
    reasoningOutputTokens > 0;
  const breakdownMax = Math.max(
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    reasoningOutputTokens,
    1,
  );

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-80 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {hasTokenBreakdown ? (
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                Breakdown
              </div>
              <TokenBreakdownBar
                label="Input"
                value={inputTokens}
                maxValue={breakdownMax}
                color="var(--color-blue-500)"
              />
              <TokenBreakdownBar
                label="Output"
                value={outputTokens}
                maxValue={breakdownMax}
                color="var(--color-green-500)"
              />
              {cachedInputTokens > 0 ? (
                <TokenBreakdownBar
                  label="Cached"
                  value={cachedInputTokens}
                  maxValue={breakdownMax}
                  color="var(--color-cyan-500)"
                />
              ) : null}
              {cacheCreationTokens > 0 ? (
                <TokenBreakdownBar
                  label="Cache write"
                  value={cacheCreationTokens}
                  maxValue={breakdownMax}
                  color="var(--color-cyan-500)"
                />
              ) : null}
              {reasoningOutputTokens > 0 ? (
                <TokenBreakdownBar
                  label="Reasoning"
                  value={reasoningOutputTokens}
                  maxValue={breakdownMax}
                  color="var(--color-purple-500)"
                />
              ) : null}
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
          {isCommandCode ? (
            <div className="mt-2 flex flex-col gap-2 border-t border-muted/60 pt-2">
              {commandCodeLoading && !commandCodeUsage ? (
                <div className="text-[11px] text-muted-foreground/60">Loading usage data...</div>
              ) : commandCodeError ? (
                <div className="text-[11px] text-red-500/80">
                  Failed to load usage: {commandCodeError}
                </div>
              ) : commandCodeUsage ? (
                <>
                  <div className="flex items-center justify-between text-[11px] leading-4">
                    <span className="text-muted-foreground/60">Plan</span>
                    <span className="font-medium text-muted-foreground/80">
                      {commandCodeUsage.plan.displayName}
                      {commandCodeUsage.plan.status === "active" ? (
                        <span className="ml-1 text-green-500/80">· active</span>
                      ) : null}
                    </span>
                  </div>
                  <CommandCodeUsageBar
                    percentage={commandCodeUsage.cycle.usagePercent}
                    hasData={
                      commandCodeUsage.cycle.totalPool > 0 || commandCodeUsage.cycle.totalSpent > 0
                    }
                  />
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[11px] leading-4">
                      <span className="text-muted-foreground/60">Cycle</span>
                      <span className="font-medium text-muted-foreground/80">
                        {formatCredits(commandCodeUsage.cycle.totalRemaining)} left
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] leading-4">
                      <span className="text-muted-foreground/60" />
                      <span className="font-medium text-muted-foreground/80">
                        {formatNumber(commandCodeUsage.cycle.totalRequests)} requests
                        <span className="mx-1 text-muted-foreground/40">·</span>
                        {commandCodeUsage.plan.daysToRenewal === 0
                          ? "renewal today"
                          : `${commandCodeUsage.plan.daysToRenewal} day${commandCodeUsage.plan.daysToRenewal === 1 ? "" : "s"} to renewal`}
                      </span>
                    </div>
                  </div>
                  {commandCodeUsage.windowLimits.limited ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                        Usage limits
                      </div>
                      <CommandCodeWindowBar
                        label="5-hour"
                        percentage={commandCodeUsage.windowLimits.fiveHour.percentage}
                        exceeded={commandCodeUsage.windowLimits.fiveHour.exceeded}
                        resetsIn={commandCodeUsage.windowLimits.fiveHour.resetsIn}
                      />
                      <CommandCodeWindowBar
                        label="Weekly"
                        percentage={commandCodeUsage.windowLimits.weekly.percentage}
                        exceeded={commandCodeUsage.windowLimits.weekly.exceeded}
                        resetsIn={commandCodeUsage.windowLimits.weekly.resetsIn}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {isCommandCode ? (
            <a
              href={COMMANDCODE_USAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1 rounded-md border border-muted/60 bg-muted/30 px-2 py-1.5 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              Full breakdown at commandcode.ai
              <svg
                className="size-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          ) : null}
          {effectiveRateLimits && !isCommandCode ? (
            <ProviderRateLimitSection snapshot={effectiveRateLimits} />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
