import { describe, expect, it } from "vite-plus/test";

import { providerLimitsRetryDelay, sanitizeProviderLimitsResponse } from "./useProviderLimits";

describe("providerLimitsRetryDelay", () => {
  it("uses bounded delays for transient initial-load failures", () => {
    expect([0, 1, 2].map(providerLimitsRetryDelay)).toEqual([1_000, 5_000, 15_000]);
    expect(providerLimitsRetryDelay(3)).toBeNull();
    expect(providerLimitsRetryDelay(-1)).toBeNull();
  });
});

describe("sanitizeProviderLimitsResponse", () => {
  it("rejects incomplete responses instead of defaulting values to zero", () => {
    expect(() => sanitizeProviderLimitsResponse({ snapshots: [] })).toThrow("incomplete response");
    expect(() => sanitizeProviderLimitsResponse({ readAt: "now", snapshots: null })).toThrow(
      "incomplete response",
    );
  });

  it("clamps valid percentages and drops malformed windows", () => {
    const result = sanitizeProviderLimitsResponse({
      readAt: "2026-08-09T00:00:00.000Z",
      snapshots: [
        {
          instanceId: "codex",
          driver: "codex",
          source: "provider-activity",
          updatedAt: "2026-08-09T00:00:00.000Z",
          windows: [
            { label: "7d", usedPercent: 125, resetsAtMs: null },
            { label: "bad", usedPercent: "not-a-number", resetsAtMs: null },
          ],
          credits: null,
          spendControl: null,
          planType: null,
          status: "warning",
        },
      ],
    });

    expect(result.snapshots[0]?.windows).toEqual([
      { label: "7d", usedPercent: 100, resetsAtMs: null },
    ]);
  });
});
