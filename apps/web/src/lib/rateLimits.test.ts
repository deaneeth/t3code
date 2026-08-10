import { describe, it, expect } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ProviderLimitSnapshot,
} from "@t3tools/contracts";
import {
  extractLatestRateLimitSnapshot,
  formatRateLimitReachedReason,
  formatRateLimitResetsIn,
  toProviderRateLimitSnapshot,
} from "~/lib/rateLimits";

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity> & { payload: unknown },
): OrchestrationThreadActivity {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}` as OrchestrationThreadActivity["id"],
    tone: "info" as const,
    kind: "account.rate-limits.updated",
    summary: "Rate limits updated",
    turnId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractLatestRateLimitSnapshot", () => {
  it("extracts API request headers by model and leaves missing quota data unavailable", () => {
    const result = extractLatestRateLimitSnapshot(
      [
        makeActivity({
          payload: {
            rateLimits: {
              model: "sensenova-6.7-flash-lite",
              "x-ratelimit-limit-requests": "1500",
              "x-ratelimit-remaining-requests": "1498",
            },
          },
        }),
      ],
      "api",
    );
    expect(result?.windows[0]).toMatchObject({
      label: "sensenova-6.7-flash-lite · Requests",
      usedPercent: 0.13333333333333333,
    });
    expect(
      extractLatestRateLimitSnapshot(
        [makeActivity({ payload: { rateLimits: { model: "sensenova-6.7-flash-lite" } } })],
        "api",
      ),
    ).toBeNull();
  });

  it("renders SenseNova's explicitly marked local observation with absolute counts", () => {
    const result = extractLatestRateLimitSnapshot(
      [
        makeActivity({
          payload: {
            rateLimits: {
              model: "sensenova-6.7-flash-lite",
              telemetrySource: "local-observation",
              "sensenova-quota-limit-requests": "1500",
              "sensenova-quota-remaining-requests": "1498",
              "sensenova-quota-reset-at": "2026-08-10T18:00:00.000Z",
            },
          },
        }),
      ],
      "api",
    );
    expect(result).toMatchObject({ quality: "local-observation" });
    expect(result?.windows[0]).toMatchObject({
      label: "sensenova-6.7-flash-lite · Requests",
      limit: 1500,
      remaining: 1498,
      usedPercent: 0.13333333333333333,
    });
  });

  describe("Codex rate limits", () => {
    it("returns null for non-codex providers", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: Date.now() + 3600000, windowDurationMins: 60 },
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "claude")).toBeNull();
    });

    it("extracts primary window from Codex", () => {
      const resetsAt = Date.now() + 3600000;
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 75, resetsAt, windowDurationMins: 60 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result).not.toBeNull();
      expect(result?.provider).toBe("codex");
      expect(result?.windows).toHaveLength(1);
      expect(result!.windows[0]!.usedPercent).toBe(75);
      expect(result!.windows[0]!.resetsAt).toBe(resetsAt);
      expect(result!.windows[0]!.windowDurationMins).toBe(60);
      expect(result!.windows[0]!.label).toBe("1hr");
    });

    it("extracts both primary and secondary windows", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: Date.now() + 1800000, windowDurationMins: 30 },
              secondary: {
                usedPercent: 80,
                resetsAt: Date.now() + 7200000,
                windowDurationMins: 120,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.windows).toHaveLength(2);
      expect(result!.windows[0]!.label).toBe("30min");
      expect(result!.windows[1]!.label).toBe("2hr");
    });

    it("extracts plan type", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              planType: "pro",
              primary: { usedPercent: 10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.planType).toBe("pro");
    });

    it("extracts credits", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              credits: { balance: "25.50", hasCredits: true, unlimited: false },
              primary: { usedPercent: 10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.credits).toEqual({
        balance: "25.50",
        hasCredits: true,
        unlimited: false,
      });
    });

    it("extracts unlimited credits", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              credits: { balance: null, hasCredits: true, unlimited: true },
              primary: { usedPercent: 10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.credits?.unlimited).toBe(true);
    });

    it("extracts spend control", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              individualLimit: {
                limit: "100.00",
                used: "45.00",
                remainingPercent: 55,
                resetsAt: Date.now() + 86400000,
              },
              primary: { usedPercent: 10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.spendControl).toEqual({
        limit: "100.00",
        used: "45.00",
        remainingPercent: 55,
        resetsAt: expect.any(Number),
      });
    });

    it("determines status as rejected when rate_limit_reached", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rateLimitReachedType: "rate_limit_reached",
              primary: { usedPercent: 100, resetsAt: Date.now() + 60000, windowDurationMins: 1 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.status).toBe("rejected");
    });

    it("determines status as warning when high usage", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 85, resetsAt: Date.now() + 60000, windowDurationMins: 1 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.status).toBe("warning");
    });

    it("determines status as allowed when low usage", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 30, resetsAt: Date.now() + 60000, windowDurationMins: 1 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.status).toBe("allowed");
    });

    it("returns null when no meaningful data", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {},
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "codex")).toBeNull();
    });

    it("returns latest activity when multiple exist", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: null, windowDurationMins: null },
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        }),
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 75, resetsAt: null, windowDurationMins: null },
            },
          },
          createdAt: "2024-01-01T00:01:00Z",
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.usedPercent).toBe(75);
    });
  });

  describe("Claude rate limits", () => {
    it("returns null for non-claude providers", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 },
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "codex")).toBeNull();
    });

    it("extracts five_hour window from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.6,
                resetsAt: Date.now() + 1800000,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result).not.toBeNull();
      expect(result?.provider).toBe("claude");
      expect(result?.windows).toHaveLength(1);
      expect(result!.windows[0]!.usedPercent).toBe(60);
      expect(result!.windows[0]!.label).toBe("5hr");
    });

    it("extracts seven_day window from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day",
                utilization: 0.3,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.usedPercent).toBe(30);
      expect(result!.windows[0]!.label).toBe("7d");
    });

    it("extracts seven_day_opus window from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day_opus",
                utilization: 0.4,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.label).toBe("Weekly · Opus");
    });

    it("extracts seven_day_sonnet window from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day_sonnet",
                utilization: 0.7,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.label).toBe("Weekly · Sonnet");
    });

    it("determines status as rejected", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "rejected",
                rateLimitType: "five_hour",
                utilization: 1.0,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result?.status).toBe("rejected");
    });

    it("determines status as warning", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed_warning",
                rateLimitType: "five_hour",
                utilization: 0.9,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result?.status).toBe("warning");
    });

    it("determines status as allowed", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.3,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result?.status).toBe("allowed");
    });

    it("returns null when no rate_limit_info", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {},
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "claude")).toBeNull();
    });

    it("handles overage status", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.5,
                isUsingOverage: true,
                overageStatus: "allowed_warning",
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty activities", () => {
      expect(extractLatestRateLimitSnapshot([], "codex")).toBeNull();
    });

    it("returns null for null provider", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, null)).toBeNull();
    });

    it("returns null for unsupported provider", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "cursor")).toBeNull();
    });

    it("skips activities with invalid payload", () => {
      const activities = [
        makeActivity({ payload: null }),
        makeActivity({ payload: "invalid" }),
        makeActivity({ payload: 123 }),
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.usedPercent).toBe(50);
    });

    it("handles missing optional fields gracefully", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.resetsAt).toBeNull();
      expect(result!.windows[0]!.windowDurationMins).toBeNull();
    });

    it("displays 'Window' label when windowDurationMins is 0", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 50, resetsAt: null, windowDurationMins: 0 },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.label).toBe("Window");
    });

    it("treats literal 'undefined'/'null' credit balance as absent", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              credits: { balance: "undefined", hasCredits: false, unlimited: false },
              primary: { usedPercent: 10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result?.credits?.balance).toBeNull();
    });

    it("coerces string-typed usedPercent from Codex", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: "75", resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.usedPercent).toBe(75);
    });

    it("clamps negative usedPercent to 0", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: -10, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.usedPercent).toBe(0);
    });

    it("clamps usedPercent > 100 to 100", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              primary: { usedPercent: 150, resetsAt: null, windowDurationMins: null },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "codex");
      expect(result!.windows[0]!.usedPercent).toBe(100);
    });

    it("clamps Claude utilization > 1 to 100%", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 1.5,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.usedPercent).toBe(100);
    });

    it("clamps Claude negative utilization to 0%", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: -0.5,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.usedPercent).toBe(0);
    });

    it("coerces string-typed utilization from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day",
                utilization: "0.4",
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result!.windows[0]!.usedPercent).toBe(40);
    });

    it("degrades gracefully for non-numeric utilization strings from Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day",
                utilization: "not-a-number",
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result).not.toBeNull();
      expect(result?.windows).toHaveLength(0);
    });

    it("Claude overage rejection overrides allowed status", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.5,
                overageStatus: "rejected",
                isUsingOverage: true,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result?.status).toBe("rejected");
    });

    it("Claude overage warning overrides allowed status", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.5,
                overageStatus: "allowed_warning",
                isUsingOverage: true,
              },
            },
          },
        }),
      ];
      const result = extractLatestRateLimitSnapshot(activities, "claude");
      expect(result?.status).toBe("warning");
    });

    it("handles missing rate_limit_info in Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              type: "rate_limit_event",
              rate_limit_info: null,
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "claude")).toBeNull();
    });

    it("handles missing rateLimitType in Claude", () => {
      const activities = [
        makeActivity({
          payload: {
            rateLimits: {
              rate_limit_info: {
                status: "allowed",
                utilization: 0.5,
              },
            },
          },
        }),
      ];
      expect(extractLatestRateLimitSnapshot(activities, "claude")).toBeNull();
    });
  });
});

describe("toProviderRateLimitSnapshot", () => {
  it("keeps provider API weekly quota data available to the chat popup", () => {
    const snapshot = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      windows: [{ label: "Weekly", usedPercent: 7, resetsAtMs: 1_800_000_000_000 }],
      credits: { balance: "0", hasCredits: false, unlimited: false },
      spendControl: null,
      planType: "plus",
      status: "allowed",
      updatedAt: "2026-08-09T00:00:00.000Z",
      source: "provider-api",
    } satisfies ProviderLimitSnapshot;

    expect(toProviderRateLimitSnapshot(snapshot)).toMatchObject({
      provider: "codex",
      planType: "plus",
      windows: [
        {
          label: "Weekly",
          usedPercent: 7,
          windowDurationMins: 10080,
          resetsAt: 1_800_000_000_000,
        },
      ],
    });
  });
});

describe("formatRateLimitResetsIn", () => {
  it("returns empty string for null", () => {
    expect(formatRateLimitResetsIn(null)).toBe("");
  });

  it("returns a truthful state for a past timestamp", () => {
    expect(formatRateLimitResetsIn(Date.now() - 1000)).toBe("resetting soon");
  });

  it("returns minutes for short durations", () => {
    const resetsAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    expect(formatRateLimitResetsIn(resetsAt)).toBe("5m");
  });

  it("returns hours for medium durations", () => {
    const resetsAt = Date.now() + 2.5 * 60 * 60 * 1000; // 2.5 hours
    expect(formatRateLimitResetsIn(resetsAt)).toBe("2h 30m");
  });

  it("returns days for long durations", () => {
    const resetsAt = Date.now() + 3 * 24 * 60 * 60 * 1000; // 3 days
    expect(formatRateLimitResetsIn(resetsAt)).toBe("3d");
  });

  it("returns empty string for NaN", () => {
    expect(formatRateLimitResetsIn(NaN)).toBe("");
  });

  it("returns empty string for Infinity", () => {
    expect(formatRateLimitResetsIn(Infinity)).toBe("");
  });
});

describe("formatRateLimitReachedReason", () => {
  it("returns null for null input", () => {
    expect(formatRateLimitReachedReason(null)).toBeNull();
    expect(formatRateLimitReachedReason("")).toBeNull();
  });

  it("maps known reached types to readable reasons", () => {
    expect(formatRateLimitReachedReason("rate_limit_reached")).toBe(
      "Usage limit reached for this window",
    );
    expect(formatRateLimitReachedReason("workspace_owner_credits_depleted")).toBe(
      "Workspace credits depleted",
    );
    expect(formatRateLimitReachedReason("workspace_member_credits_depleted")).toBe(
      "Workspace credits depleted",
    );
    expect(formatRateLimitReachedReason("workspace_owner_usage_limit_reached")).toBe(
      "Workspace usage limit reached",
    );
    expect(formatRateLimitReachedReason("workspace_member_usage_limit_reached")).toBe(
      "Workspace usage limit reached",
    );
  });

  it("falls back to a readable message for unknown types", () => {
    expect(formatRateLimitReachedReason("something_weird")).toBe("Limit reached: something_weird");
  });
});
