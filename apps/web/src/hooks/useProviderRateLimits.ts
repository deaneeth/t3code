import { useMemo } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { extractLatestRateLimitSnapshot, type ProviderRateLimitSnapshot } from "~/lib/rateLimits";

export function useProviderRateLimits(
  activities: ReadonlyArray<OrchestrationThreadActivity> | null,
  providerKind: string | null,
): ProviderRateLimitSnapshot | null {
  return useMemo(
    () => extractLatestRateLimitSnapshot(activities ?? [], providerKind),
    [activities, providerKind],
  );
}
