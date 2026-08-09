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
  return parsed === null ? null : Math.trunc(parsed);
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
    const usedPercent = percent(input?.usedPercent);
    if (usedPercent === null) return [];
    const duration = nonNegativeNumber(input?.windowDurationMins);
    return [
      {
        label:
          duration === null || duration <= 0
            ? key === "primary"
              ? "Primary"
              : "Secondary"
            : duration >= 1440
              ? `${Math.round(duration / 1440)}d`
              : `${Math.round(duration / 60)}hr`,
        usedPercent,
        resetsAtMs: resetAt(input?.resetsAt),
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
  const planType = stringValue(rateLimits.planType);
  if (windows.length === 0 && credits === null && spendControl === null && planType === null) {
    return null;
  }
  return {
    windows,
    credits,
    spendControl,
    planType,
    status: statusFor(null, stringValue(rateLimits.rateLimitReachedType), windows),
  };
}

function parseClaude(
  rateLimits: RecordValue,
): Omit<ProviderLimitSnapshot, "instanceId" | "driver" | "updatedAt" | "source"> | null {
  const info = record(rateLimits.rate_limit_info);
  if (!info) return null;
  const utilization = numberValue(info.utilization);
  const rateLimitType = stringValue(info.rateLimitType);
  const windows =
    utilization !== null && rateLimitType !== null
      ? [
          {
            label:
              rateLimitType === "five_hour"
                ? "5hr"
                : rateLimitType.startsWith("seven_day")
                  ? "7d"
                  : rateLimitType === "overage"
                    ? "Overage"
                    : rateLimitType,
            usedPercent: Math.max(
              0,
              Math.min(100, utilization <= 1 ? utilization * 100 : utilization),
            ),
            resetsAtMs: resetAt(info.resetsAt),
          },
        ]
      : [];
  const overageStatus = stringValue(info.overageStatus);
  if (info.isUsingOverage === true || info.overageInUse === true) {
    windows.push({
      label: "Overage",
      usedPercent: overageStatus === "rejected" ? 100 : 0,
      resetsAtMs: resetAt(info.overageResetsAt),
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
  return null;
}

export function latestProviderLimitSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  readModel: OrchestrationReadModel,
): ReadonlyArray<ProviderLimitSnapshot> {
  const providerByInstance = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const latest = new Map<ProviderInstanceId, ProviderLimitSnapshot>();

  for (const thread of readModel.threads) {
    const instanceId = thread.modelSelection.instanceId;
    const provider = providerByInstance.get(instanceId);
    if (!provider) continue;
    for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
      const activity = thread.activities[index];
      if (activity?.kind !== "account.rate-limits.updated") continue;
      const payload = record(activity.payload);
      const rateLimits = record(payload?.rateLimits);
      if (!rateLimits) continue;
      const parsed = parseForDriver(provider.driver, rateLimits);
      if (!parsed) continue;
      const current = latest.get(instanceId);
      if (current && current.updatedAt >= activity.createdAt) continue;
      latest.set(instanceId, {
        instanceId,
        driver: provider.driver,
        ...parsed,
        updatedAt: activity.createdAt,
        source: "provider-activity",
      });
      break;
    }
  }

  return [...latest.values()].toSorted((a, b) => a.instanceId.localeCompare(b.instanceId));
}
