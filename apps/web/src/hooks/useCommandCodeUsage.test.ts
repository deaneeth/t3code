import { describe, it, expect } from "vite-plus/test";
import { sanitizeCommandCodeResult } from "./useCommandCodeUsage";

describe("sanitizeCommandCodeResult", () => {
  it("round-trips a valid response unchanged", () => {
    const input = {
      plan: {
        id: "pro",
        displayName: "Pro",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 5 * 86400000).toISOString(),
        daysToRenewal: 5,
      },
      cycle: {
        totalRemaining: 12.5,
        monthlyRemaining: 10,
        purchasedRemaining: 2.5,
        freeRemaining: 0,
        totalSpent: 7.5,
        totalPool: 20,
        usagePercent: 62.5,
        totalRequests: 134,
      },
      windowLimits: {
        limited: true,
        fiveHour: {
          used: 20,
          cap: 30,
          percentage: 66.67,
          exceeded: false,
          resetAtMs: Date.now() + 3600000,
          resetsIn: "unknown",
        },
        weekly: {
          used: 60,
          cap: 100,
          percentage: 60,
          exceeded: false,
          resetAtMs: Date.now() + 86400000,
          resetsIn: "unknown",
        },
      },
    };

    const result = sanitizeCommandCodeResult(input);
    expect(result.plan.displayName).toBe("Pro");
    expect(result.plan.status).toBe("active");
    expect(result.cycle.totalRemaining).toBe(12.5);
    expect(result.cycle.usagePercent).toBe(62.5);
    expect(result.windowLimits.limited).toBe(true);
    expect(result.windowLimits.fiveHour.percentage).toBe(66.67);
    expect(result.windowLimits.weekly.percentage).toBe(60);
  });

  it("survives a completely malformed payload without crashing", () => {
    expect(sanitizeCommandCodeResult(null)).toEqual(
      expect.objectContaining({
        plan: expect.objectContaining({ displayName: "Command Code", status: "inactive" }),
        cycle: expect.objectContaining({ totalRemaining: 0, usagePercent: 0 }),
        windowLimits: expect.objectContaining({ limited: false }),
      }),
    );
    expect(sanitizeCommandCodeResult("garbage")).toEqual(
      expect.objectContaining({
        plan: expect.objectContaining({ displayName: "Command Code" }),
      }),
    );
    expect(sanitizeCommandCodeResult(42)).toEqual(
      expect.objectContaining({
        cycle: expect.objectContaining({ totalRequests: 0 }),
      }),
    );
    expect(sanitizeCommandCodeResult({})).toEqual(
      expect.objectContaining({
        windowLimits: expect.objectContaining({ limited: false }),
      }),
    );
  });

  it("fills required defaults when plan fields are missing", () => {
    const result = sanitizeCommandCodeResult({
      plan: { id: "free" },
      cycle: {},
      windowLimits: {},
    });
    expect(result.plan.id).toBe("free");
    expect(result.plan.displayName).toBe("Command Code");
    expect(result.windowLimits.fiveHour.percentage).toBe(0);
    expect(result.windowLimits.weekly.percentage).toBe(0);
  });

  it("clamps negative and NaN numbers", () => {
    const result = sanitizeCommandCodeResult({
      plan: {},
      cycle: { totalRemaining: -5.5, usagePercent: NaN, totalRequests: -3 },
      windowLimits: {
        fiveHour: { percentage: 200, exceeded: false, resetAtMs: 0 },
        weekly: { percentage: -10, exceeded: false, resetAtMs: -100 },
      },
    });
    expect(result.cycle.totalRemaining).toBe(0);
    expect(result.cycle.usagePercent).toBe(0);
    expect(result.cycle.totalRequests).toBe(0);
    expect(result.windowLimits.fiveHour.percentage).toBe(100);
    expect(result.windowLimits.weekly.percentage).toBe(0);
    expect(result.windowLimits.fiveHour.resetsIn).toBe("resetting soon");
  });

  it("preserves declared daysToRenewal when period end is unparseable, recomputes it otherwise", () => {
    const result = sanitizeCommandCodeResult({
      plan: { daysToRenewal: 3, currentPeriodEnd: "" },
      cycle: {},
      windowLimits: {},
    });
    expect(result.plan.daysToRenewal).toBe(3);

    const end = new Date(Date.now() + 6 * 86400000).toISOString();
    const recomputed = sanitizeCommandCodeResult({
      plan: { daysToRenewal: 999, currentPeriodEnd: end },
      cycle: {},
      windowLimits: {},
    });
    expect(recomputed.plan.daysToRenewal).toBe(6);
  });

  it("keeps provided boolean and string fields", () => {
    const result = sanitizeCommandCodeResult({
      plan: { displayName: "Enterprise", status: "active" },
      cycle: {},
      windowLimits: { limited: true },
    });
    expect(result.plan.displayName).toBe("Enterprise");
    expect(result.plan.status).toBe("active");
    expect(result.windowLimits.limited).toBe(true);
  });
});
