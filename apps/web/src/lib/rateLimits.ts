import type { OrchestrationThreadActivity } from "@t3tools/contracts";

// ── Normalized Types ────────────────────────────────────────────────

export type RateLimitWindow = {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly windowDurationMins: number | null;
  readonly label: string;
};

export type RateLimitCredits = {
  readonly balance: string | null;
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
};

export type RateLimitSpendControl = {
  readonly limit: string;
  readonly used: string;
  readonly remainingPercent: number;
  readonly resetsAt: number;
};

export type ProviderRateLimitSnapshot = {
  readonly provider: string;
  readonly windows: ReadonlyArray<RateLimitWindow>;
  readonly credits: RateLimitCredits | null;
  readonly spendControl: RateLimitSpendControl | null;
  readonly planType: string | null;
  readonly status: "allowed" | "warning" | "rejected" | null;
  readonly reachedType: string | null;
  readonly updatedAt: string;
};

// ── Helpers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Reject sentinel literals that some providers emit for missing values:
  // rendering "$undefined" or "$null" in the UI would be a silent lie.
  if (value === "undefined" || value === "null" || value === "NaN") return null;
  return value;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Coerce a stringly-typed number (e.g. "0.5" for Claude utilization) into a
 * finite number. Accepts real numbers and numeric strings; rejects everything
 * else including NaN, Infinity, and empty strings.
 */
function asCoercedNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatWindowLabel(windowDurationMins: number | null): string {
  if (windowDurationMins === null || windowDurationMins <= 0) return "Window";
  if (windowDurationMins < 60) return `${windowDurationMins}min`;
  const hours = windowDurationMins / 60;
  if (hours < 24) {
    const h = Math.round(hours);
    return `${h}hr`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatClaudeWindowLabel(rateLimitType: string | null): string {
  switch (rateLimitType) {
    case "five_hour":
      return "5hr";
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "7d";
    case "overage":
      return "Overage";
    default:
      return "Window";
  }
}

// ── Codex Parser ────────────────────────────────────────────────────

function parseCodexRateLimits(
  rateLimits: Record<string, unknown>,
): Omit<ProviderRateLimitSnapshot, "updatedAt"> | null {
  const planType = asString(rateLimits.planType);
  const rateLimitReachedType = asString(rateLimits.rateLimitReachedType);
  const spendControlReached = asBoolean(rateLimits.spendControlReached);

  // Parse windows (primary and secondary)
  const windows: RateLimitWindow[] = [];

  const primary = asRecord(rateLimits.primary);
  if (primary) {
    const usedPercent = asCoercedNumber(primary.usedPercent);
    if (usedPercent !== null) {
      // Clamp to 0-100 range for display
      const clampedPercent = Math.max(0, Math.min(100, usedPercent));
      windows.push({
        usedPercent: clampedPercent,
        resetsAt: asFiniteNumber(primary.resetsAt),
        windowDurationMins: asFiniteNumber(primary.windowDurationMins),
        label: formatWindowLabel(asFiniteNumber(primary.windowDurationMins)),
      });
    }
  }

  const secondary = asRecord(rateLimits.secondary);
  if (secondary) {
    const usedPercent = asCoercedNumber(secondary.usedPercent);
    if (usedPercent !== null) {
      // Clamp to 0-100 range for display
      const clampedPercent = Math.max(0, Math.min(100, usedPercent));
      windows.push({
        usedPercent: clampedPercent,
        resetsAt: asFiniteNumber(secondary.resetsAt),
        windowDurationMins: asFiniteNumber(secondary.windowDurationMins),
        label: formatWindowLabel(asFiniteNumber(secondary.windowDurationMins)),
      });
    }
  }

  // Parse credits
  const creditsRaw = asRecord(rateLimits.credits);
  const credits: RateLimitCredits | null = creditsRaw
    ? {
        balance: asString(creditsRaw.balance),
        hasCredits: asBoolean(creditsRaw.hasCredits) ?? false,
        unlimited: asBoolean(creditsRaw.unlimited) ?? false,
      }
    : null;

  // Parse spend control
  const spendControlRaw = asRecord(rateLimits.individualLimit);
  const spendControl: RateLimitSpendControl | null = spendControlRaw
    ? {
        limit: asString(spendControlRaw.limit) ?? "0",
        used: asString(spendControlRaw.used) ?? "0",
        remainingPercent: asFiniteNumber(spendControlRaw.remainingPercent) ?? 0,
        resetsAt: asFiniteNumber(spendControlRaw.resetsAt) ?? 0,
      }
    : null;

  // Determine status from rate limit reached type
  let status: "allowed" | "warning" | "rejected" | null = null;
  if (rateLimitReachedType) {
    if (rateLimitReachedType === "rate_limit_reached") {
      status = "rejected";
    } else if (
      rateLimitReachedType.includes("credits_depleted") ||
      rateLimitReachedType.includes("usage_limit_reached")
    ) {
      status = "rejected";
    }
  } else if (spendControlReached) {
    status = "rejected";
  } else if (windows.some((w) => w.usedPercent >= 80)) {
    status = "warning";
  } else {
    status = "allowed";
  }

  // Only return if there's meaningful data
  if (windows.length === 0 && !credits && !spendControl && !planType) {
    return null;
  }

  return {
    provider: "codex",
    windows,
    credits,
    spendControl,
    planType,
    status,
    reachedType: rateLimitReachedType,
  };
}

// ── Claude Parser ───────────────────────────────────────────────────

function parseClaudeRateLimits(
  rateLimits: Record<string, unknown>,
): Omit<ProviderRateLimitSnapshot, "updatedAt"> | null {
  const rateLimitInfo = asRecord(rateLimits.rate_limit_info);
  if (!rateLimitInfo) return null;

  const statusRaw = asString(rateLimitInfo.status);
  const rateLimitType = asString(rateLimitInfo.rateLimitType);
  const utilization = asCoercedNumber(rateLimitInfo.utilization);
  const resetsAt = asFiniteNumber(rateLimitInfo.resetsAt);

  // Parse windows based on rateLimitType
  const windows: RateLimitWindow[] = [];

  if (rateLimitType && utilization !== null) {
    // Clamp utilization to 0-1 range, then convert to percentage
    const clampedUtilization = Math.max(0, Math.min(1, utilization));
    windows.push({
      usedPercent: clampedUtilization * 100,
      resetsAt,
      windowDurationMins: null, // Claude doesn't provide window duration
      label: formatClaudeWindowLabel(rateLimitType),
    });
  }

  // Parse overage info if present
  const overageStatus = asString(rateLimitInfo.overageStatus);
  const overageResetsAt = asFiniteNumber(rateLimitInfo.overageResetsAt);
  const isUsingOverage = asBoolean(rateLimitInfo.isUsingOverage);
  const overageInUse = asBoolean(rateLimitInfo.overageInUse);

  if (isUsingOverage || overageInUse) {
    // Add overage window if relevant
    if (overageStatus && overageStatus !== "allowed") {
      windows.push({
        usedPercent: 100, // Overage means limit exceeded
        resetsAt: overageResetsAt,
        windowDurationMins: null,
        label: "Overage",
      });
    }
  }

  // Determine normalized status
  let status: "allowed" | "warning" | "rejected" | null = null;
  if (statusRaw === "rejected") {
    status = "rejected";
  } else if (statusRaw === "allowed_warning") {
    status = "warning";
  } else if (statusRaw === "allowed") {
    status = "allowed";
  }

  // Override status if overage is in a bad state
  if (overageStatus === "rejected") {
    status = "rejected";
  } else if (overageStatus === "allowed_warning" && status !== "rejected") {
    status = "warning";
  }

  // Only return if there's meaningful data
  if (windows.length === 0 && !rateLimitType) {
    return null;
  }

  return {
    provider: "claude",
    windows,
    credits: null, // Claude doesn't expose credits via this event
    spendControl: null,
    planType: null,
    status,
    reachedType: null,
  };
}

// ── CommandCode Parser ─────────────────────────────────────────────

function parseCommandCodeRateLimits(
  rateLimits: Record<string, unknown>,
): Omit<ProviderRateLimitSnapshot, "updatedAt"> | null {
  const planType = asString(rateLimits.planType);
  const statusRaw = asString(rateLimits.status);

  const windows: RateLimitWindow[] = [];

  const fiveHour = asRecord(rateLimits.fiveHour);
  if (fiveHour) {
    const usedPercent = asCoercedNumber(fiveHour.usedPercent);
    if (usedPercent !== null) {
      windows.push({
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        resetsAt: asFiniteNumber(fiveHour.resetsAt),
        windowDurationMins: 300,
        label: "5hr",
      });
    }
  }

  const weekly = asRecord(rateLimits.weekly);
  if (weekly) {
    const usedPercent = asCoercedNumber(weekly.usedPercent);
    if (usedPercent !== null) {
      windows.push({
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        resetsAt: asFiniteNumber(weekly.resetsAt),
        windowDurationMins: 10080,
        label: "7d",
      });
    }
  }

  let status: "allowed" | "warning" | "rejected" | null = null;
  if (statusRaw === "rejected" || statusRaw === "exceeded") {
    status = "rejected";
  } else if (windows.some((w) => w.usedPercent >= 80)) {
    status = "warning";
  } else {
    status = "allowed";
  }

  if (windows.length === 0 && !planType) {
    return null;
  }

  return {
    provider: "commandcode",
    windows,
    credits: null,
    spendControl: null,
    planType,
    status,
    reachedType: null,
  };
}

// ── Main Extractor ──────────────────────────────────────────────────

export function extractLatestRateLimitSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerKind: string | null,
): ProviderRateLimitSnapshot | null {
  if (!providerKind) return null;

  // Only Codex, Claude, and CommandCode send rate limit data
  if (providerKind !== "codex" && providerKind !== "claude" && providerKind !== "commandcode")
    return null;

  // Walk backwards to find the latest rate limit update
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.rate-limits.updated") continue;

    const payload = asRecord(activity.payload);
    if (!payload) continue;

    const rateLimits = asRecord(payload.rateLimits);
    if (!rateLimits) continue;

    let parsed: Omit<ProviderRateLimitSnapshot, "updatedAt"> | null = null;

    if (providerKind === "codex") {
      parsed = parseCodexRateLimits(rateLimits);
    } else if (providerKind === "claude") {
      parsed = parseClaudeRateLimits(rateLimits);
    } else if (providerKind === "commandcode") {
      parsed = parseCommandCodeRateLimits(rateLimits);
    }

    if (parsed) {
      return { ...parsed, updatedAt: activity.createdAt };
    }
  }

  return null;
}

export function formatRateLimitResetsIn(resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return "";
  const now = Date.now();
  const diffMs = resetsAt - now;
  if (diffMs <= 0) return "now";
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = diffMins / 60;
  if (hours < 24) {
    const h = Math.floor(hours);
    const m = diffMins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Human-readable reason a Codex rate limit was reached, so the UI can explain
 * *why* requests are being throttled instead of silently showing red bars.
 */
export function formatRateLimitReachedReason(reachedType: string | null): string | null {
  if (!reachedType) return null;
  switch (reachedType) {
    case "rate_limit_reached":
      return "Usage limit reached for this window";
    case "workspace_owner_credits_depleted":
      return "Workspace credits depleted";
    case "workspace_member_credits_depleted":
      return "Workspace credits depleted";
    case "workspace_owner_usage_limit_reached":
      return "Workspace usage limit reached";
    case "workspace_member_usage_limit_reached":
      return "Workspace usage limit reached";
    default:
      return `Limit reached: ${reachedType}`;
  }
}
