import type {
  OrchestrationReadModel,
  ProviderLimitSnapshot,
  ProviderLimitStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (value === "undefined" || value === "null" || value === "NaN") return null;
  return value.trim();
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, parsed);
}

function percent(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.min(100, parsed));
}

function resetAt(value: unknown): number | null {
  const parsed = nonNegativeNumber(value);
  if (parsed === null) return null;
  // Codex has emitted both epoch milliseconds and epoch seconds across CLI
  // versions. The contract is milliseconds; normalise at the adapter edge so
  // every consumer renders the same real reset time.
  const integer = Math.trunc(parsed);
  return integer > 0 && integer < 1_000_000_000_000 ? integer * 1000 : integer;
}

function firstValue(input: RecordValue, ...keys: ReadonlyArray<string>): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

function windowLabel(key: string, durationMinutes: number | null): string {
  if (durationMinutes === 5 * 60) return "5-hour";
  if (durationMinutes === 7 * 24 * 60) return "Weekly";
  if (durationMinutes !== null && durationMinutes > 0) {
    if (durationMinutes % (24 * 60) === 0) return `${durationMinutes / (24 * 60)}d`;
    if (durationMinutes % 60 === 0) return `${durationMinutes / 60}hr`;
    return `${durationMinutes}min`;
  }
  return key === "primary" ? "Primary" : key === "secondary" ? "Secondary" : key;
}

function statusFor(
  rawStatus: string | null,
  reached: string | null,
  windows: ReadonlyArray<{ usedPercent: number }>,
): ProviderLimitStatus {
  if (
    rawStatus === "rejected" ||
    rawStatus === "exceeded" ||
    reached === "rate_limit_reached" ||
    reached?.includes("credits_depleted") ||
    reached?.includes("usage_limit_reached")
  ) {
    return "rejected";
  }
  return windows.some((window) => window.usedPercent >= 80) || rawStatus === "allowed_warning"
    ? "warning"
    : "allowed";
}

function parseCodex(
  rateLimits: RecordValue,
): Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source"> | null {
  const windows = ["primary", "secondary"].flatMap((key) => {
    const input = record(rateLimits[key]);
    const usedPercent = percent(firstValue(input ?? {}, "usedPercent", "used_percent"));
    if (usedPercent === null) return [];
    const duration = nonNegativeNumber(
      firstValue(input ?? {}, "windowDurationMins", "window_minutes"),
    );
    return [
      {
        label: windowLabel(key, duration),
        usedPercent,
        resetsAtMs: resetAt(firstValue(input ?? {}, "resetsAt", "resets_at")),
      },
    ];
  });
  const creditsInput = record(rateLimits.credits);
  const credits = creditsInput
    ? {
        balance: stringValue(creditsInput.balance),
        hasCredits: creditsInput.hasCredits === true,
        unlimited: creditsInput.unlimited === true,
      }
    : null;
  const spendInput = record(rateLimits.individualLimit);
  const spendControl = spendInput
    ? {
        limit: stringValue(spendInput.limit) ?? "0",
        used: stringValue(spendInput.used) ?? "0",
        remainingPercent: percent(spendInput.remainingPercent) ?? 0,
        resetsAtMs: resetAt(spendInput.resetsAt) ?? 0,
      }
    : null;
  const planType = stringValue(firstValue(rateLimits, "planType", "plan_type"));
  if (windows.length === 0 && credits === null && spendControl === null && planType === null) {
    return null;
  }
  return {
    windows,
    credits,
    spendControl,
    planType,
    status: statusFor(
      null,
      stringValue(firstValue(rateLimits, "rateLimitReachedType", "rate_limit_reached_type")),
      windows,
    ),
  };
}

function parseClaude(
  rateLimits: RecordValue,
): Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source"> | null {
  const info = record(rateLimits.rate_limit_info);
  if (!info) return null;
  const utilization = numberValue(firstValue(info, "utilization", "used_percent"));
  const rateLimitType = stringValue(firstValue(info, "rateLimitType", "rate_limit_type"));
  const windows =
    utilization !== null && rateLimitType !== null
      ? [
          {
            label:
              rateLimitType === "five_hour"
                ? "5-hour"
                : rateLimitType === "seven_day"
                  ? "Weekly"
                  : rateLimitType === "seven_day_opus"
                    ? "Weekly · Opus"
                    : rateLimitType === "seven_day_sonnet"
                      ? "Weekly · Sonnet"
                      : rateLimitType.startsWith("seven_day_")
                        ? `Weekly · ${rateLimitType.slice("seven_day_".length).replaceAll("_", " ")}`
                        : rateLimitType === "overage"
                          ? "Overage"
                          : rateLimitType,
            usedPercent: Math.max(
              0,
              Math.min(100, utilization <= 1 ? utilization * 100 : utilization),
            ),
            resetsAtMs: resetAt(firstValue(info, "resetsAt", "resets_at")),
          },
        ]
      : [];
  const overageStatus = stringValue(firstValue(info, "overageStatus", "overage_status"));
  if (
    firstValue(info, "isUsingOverage", "is_using_overage") === true ||
    firstValue(info, "overageInUse", "overage_in_use") === true
  ) {
    windows.push({
      label: "Overage",
      usedPercent: overageStatus === "rejected" ? 100 : 0,
      resetsAtMs: resetAt(firstValue(info, "overageResetsAt", "overage_resets_at")),
    });
  }
  if (windows.length === 0 && rateLimitType === null) return null;
  return {
    windows,
    credits: null,
    spendControl: null,
    planType: null,
    status: statusFor(stringValue(info.status), overageStatus, windows),
  };
}

function parseCommandCode(
  rateLimits: RecordValue,
): Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source"> | null {
  const windows = [
    ["5hr", rateLimits.fiveHour],
    ["7d", rateLimits.weekly],
  ].flatMap(([label, value]) => {
    const input = record(value);
    const usedPercent = percent(input?.usedPercent);
    return usedPercent === null
      ? []
      : [{ label: String(label), usedPercent, resetsAtMs: resetAt(input?.resetsAt) }];
  });
  const planType = stringValue(rateLimits.planType);
  if (windows.length === 0 && planType === null) return null;
  return {
    windows,
    credits: null,
    spendControl: null,
    planType,
    status: statusFor(stringValue(rateLimits.status), null, windows),
  };
}

function parseForDriver(
  driver: ProviderDriverKind,
  rateLimits: RecordValue,
): Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source"> | null {
  if (driver === "codex") return parseCodex(rateLimits);
  if (driver === "claudeAgent" || driver === "claude") return parseClaude(rateLimits);
  if (driver === "commandcode") return parseCommandCode(rateLimits);
  // Unknown providers must publish a normalized provider-activity payload
  // through their adapter before it is safe to render as quota telemetry.
  return null;
}

type ParsedLimit = Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source">;

function mergeParsedLimits(previous: ParsedLimit | undefined, next: ParsedLimit): ParsedLimit {
  if (!previous) return next;
  const windows = new Map(previous.windows.map((window) => [window.label, window]));
  for (const window of next.windows) windows.set(window.label, window);
  const mergedWindows = [...windows.values()];
  return {
    windows: mergedWindows,
    credits: next.credits ?? previous.credits,
    spendControl: next.spendControl ?? previous.spendControl,
    planType: next.planType ?? previous.planType,
    status: statusFor(
      next.status === "rejected"
        ? "rejected"
        : next.status === "warning"
          ? "allowed_warning"
          : null,
      null,
      mergedWindows,
    ),
  };
}

export function latestProviderLimitSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  readModel: OrchestrationReadModel,
): ReadonlyArray<ProviderLimitSnapshot> {
  const providerByInstance = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const latest = new Map<ProviderInstanceId, { updatedAt: string; parsed: ParsedLimit }>();

  const events = readModel.threads.flatMap((thread) => {
    const instanceId = thread.modelSelection.instanceId;
    const provider = providerByInstance.get(instanceId);
    if (!provider) return [];
    return thread.activities
      .filter((activity) => activity?.kind === "account.rate-limits.updated")
      .map((activity) => ({ activity, instanceId, provider }));
  });

  // Applying events in timestamp order means a stale event from another
  // thread can contribute a missing Claude window, but can never overwrite a
  // newer value for the same window.
  for (const { activity, instanceId, provider } of events.toSorted((a, b) =>
    a.activity.createdAt.localeCompare(b.activity.createdAt),
  )) {
    const payload = record(activity.payload);
    const rateLimits = record(payload?.rateLimits);
    if (!rateLimits) continue;
    const parsed = parseForDriver(provider.driver, rateLimits);
    if (!parsed) continue;
    const current = latest.get(instanceId);
    latest.set(instanceId, {
      updatedAt: activity.createdAt,
      parsed: mergeParsedLimits(current?.parsed, parsed),
    });
  }

  return [...latest.entries()]
    .map(([instanceId, value]) => ({
      instanceId,
      driver: providerByInstance.get(instanceId)!.driver,
      ...value.parsed,
      updatedAt: value.updatedAt,
      source: "provider-activity" as const,
    }))
    .toSorted((a, b) => a.instanceId.localeCompare(b.instanceId));
}
