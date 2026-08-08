import { useCallback, useEffect, useRef, useState } from "react";

export interface CommandCodeUsageData {
  readonly plan: {
    readonly id: string;
    readonly displayName: string;
    readonly status: string;
    readonly currentPeriodEnd: string;
    readonly daysToRenewal: number;
  };
  readonly cycle: {
    readonly totalRemaining: number;
    readonly monthlyRemaining: number;
    readonly purchasedRemaining: number;
    readonly freeRemaining: number;
    readonly totalSpent: number;
    readonly totalPool: number;
    readonly usagePercent: number;
    readonly totalRequests: number;
  };
  readonly windowLimits: {
    readonly limited: boolean;
    readonly fiveHour: {
      readonly used: number;
      readonly cap: number;
      readonly percentage: number;
      readonly exceeded: boolean;
      readonly resetAtMs: number;
      readonly resetsIn: string;
    };
    readonly weekly: {
      readonly used: number;
      readonly cap: number;
      readonly percentage: number;
      readonly exceeded: boolean;
      readonly resetAtMs: number;
      readonly resetsIn: string;
    };
  };
}

function formatResetsIn(resetAtMs: number): string {
  const now = Date.now();
  const diffMs = resetAtMs - now;
  if (diffMs <= 0) return "resetting soon";

  const diffMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "resetting soon";
}

const POLL_INTERVAL_MS = 10_000;
const TICK_INTERVAL_MS = 30_000;

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
  return Math.max(0, toFiniteNumber(value, fallback));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toFiniteString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Validate and normalize whatever the CommandCode usage API returned.
 * A malformed or partial response must never survive to the UI, where a
 * missing `plan`/`cycle`/`windowLimits` would crash the popover.
 */
export function sanitizeCommandCodeResult(raw: unknown): CommandCodeUsageData {
  const obj =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const planRaw =
    obj.plan && typeof obj.plan === "object" ? (obj.plan as Record<string, unknown>) : {};

  const sanitizedPlan: CommandCodeUsageData["plan"] = {
    id: toFiniteString(planRaw.id, "unknown"),
    displayName: toFiniteString(planRaw.displayName, "Command Code"),
    status: toFiniteString(planRaw.status, "inactive"),
    currentPeriodEnd: toFiniteString(planRaw.currentPeriodEnd, ""),
    daysToRenewal: toNonNegativeNumber(planRaw.daysToRenewal, 0),
  };

  const cycleRaw =
    obj.cycle && typeof obj.cycle === "object" ? (obj.cycle as Record<string, unknown>) : {};

  const sanitizedCycle: CommandCodeUsageData["cycle"] = {
    totalRemaining: toNonNegativeNumber(cycleRaw.totalRemaining, 0),
    monthlyRemaining: toNonNegativeNumber(cycleRaw.monthlyRemaining, 0),
    purchasedRemaining: toNonNegativeNumber(cycleRaw.purchasedRemaining, 0),
    freeRemaining: toNonNegativeNumber(cycleRaw.freeRemaining, 0),
    totalSpent: toNonNegativeNumber(cycleRaw.totalSpent, 0),
    totalPool: toNonNegativeNumber(cycleRaw.totalPool, 0),
    usagePercent: Math.min(100, toNonNegativeNumber(cycleRaw.usagePercent, 0)),
    totalRequests: toNonNegativeNumber(cycleRaw.totalRequests, 0),
  };

  const windowLimitsRaw =
    obj.windowLimits && typeof obj.windowLimits === "object"
      ? (obj.windowLimits as Record<string, unknown>)
      : {};

  const fiveHourRaw =
    windowLimitsRaw.fiveHour && typeof windowLimitsRaw.fiveHour === "object"
      ? (windowLimitsRaw.fiveHour as Record<string, unknown>)
      : {};

  const weeklyRaw =
    windowLimitsRaw.weekly && typeof windowLimitsRaw.weekly === "object"
      ? (windowLimitsRaw.weekly as Record<string, unknown>)
      : {};

  const resetAtMs = toNonNegativeNumber(fiveHourRaw.resetAtMs, 0);
  const weeklyResetAtMs = toNonNegativeNumber(weeklyRaw.resetAtMs, 0);
  const now = Date.now();

  const sanitizedWindowLimits: CommandCodeUsageData["windowLimits"] = {
    limited: toBoolean(windowLimitsRaw.limited, false),
    fiveHour: {
      used: toNonNegativeNumber(fiveHourRaw.used, 0),
      cap: toNonNegativeNumber(fiveHourRaw.cap, 0),
      percentage: Math.min(100, toNonNegativeNumber(fiveHourRaw.percentage, 0)),
      exceeded: toBoolean(fiveHourRaw.exceeded, false),
      resetAtMs,
      resetsIn: formatResetsIn(resetAtMs),
    },
    weekly: {
      used: toNonNegativeNumber(weeklyRaw.used, 0),
      cap: toNonNegativeNumber(weeklyRaw.cap, 0),
      percentage: Math.min(100, toNonNegativeNumber(weeklyRaw.percentage, 0)),
      exceeded: toBoolean(weeklyRaw.exceeded, false),
      resetAtMs: weeklyResetAtMs,
      resetsIn: formatResetsIn(weeklyResetAtMs),
    },
  };

  // Recompute daysToRenewal from a parseable end date; keep the raw value when
  // the provider already sent a sane one and the date is unparseable.
  let daysToRenewal = sanitizedPlan.daysToRenewal;
  const endTime = new Date(sanitizedPlan.currentPeriodEnd).getTime();
  if (Number.isFinite(endTime)) {
    daysToRenewal = Math.max(0, Math.ceil((endTime - now) / (24 * 60 * 60 * 1000)));
  }

  return {
    plan: { ...sanitizedPlan, daysToRenewal },
    cycle: sanitizedCycle,
    windowLimits: sanitizedWindowLimits,
  };
}

export function useCommandCodeUsage(enabled: boolean) {
  const [data, setData] = useState<CommandCodeUsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/provider/commandcode/usage");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const result = await response.json();
      if (result && typeof result === "object" && "error" in result) {
        throw new Error(String((result as { error?: unknown }).error ?? "Unknown error"));
      }
      setData(sanitizeCommandCodeResult(result));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let initialFetchDone = false;
    const doFetch = async () => {
      if (!initialFetchDone) setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/provider/commandcode/usage", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const result = await response.json();
        if (result && typeof result === "object" && "error" in result) {
          throw new Error(String((result as { error?: unknown }).error ?? "Unknown error"));
        }
        setData(sanitizeCommandCodeResult(result));
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        initialFetchDone = true;
        setLoading(false);
      }
    };

    doFetch();
    const pollInterval = setInterval(doFetch, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(pollInterval);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !data) return;

    const tick = () => {
      setData((prev) => {
        if (!prev) return prev;
        const now = Date.now();
        const endTime = new Date(prev.plan.currentPeriodEnd).getTime();
        const daysToRenewal = Number.isFinite(endTime)
          ? Math.max(0, Math.ceil((endTime - now) / (24 * 60 * 60 * 1000)))
          : prev.plan.daysToRenewal;
        return {
          ...prev,
          plan: {
            ...prev.plan,
            daysToRenewal,
          },
          windowLimits: {
            ...prev.windowLimits,
            fiveHour: {
              ...prev.windowLimits.fiveHour,
              resetsIn: formatResetsIn(prev.windowLimits.fiveHour.resetAtMs),
            },
            weekly: {
              ...prev.windowLimits.weekly,
              resetsIn: formatResetsIn(prev.windowLimits.weekly.resetAtMs),
            },
          },
        };
      });
    };

    const tickInterval = setInterval(tick, TICK_INTERVAL_MS);
    tick();
    return () => clearInterval(tickInterval);
  }, [enabled, data?.windowLimits.fiveHour.resetAtMs, data?.windowLimits.weekly.resetAtMs]);

  return { data, loading, error, refetch: fetchUsage };
}
