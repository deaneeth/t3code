import { describe, expect, it } from "@effect/vitest";

import type { OrchestrationReadModel, ServerProvider } from "@t3tools/contracts";

import {
  latestProviderLimitSnapshots,
  providerLimitSnapshotFromRateLimits,
} from "./ProviderLimits.ts";

const provider = (instanceId: string, driver: string): ServerProvider =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-09T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

const readModel = (threads: unknown[]): OrchestrationReadModel =>
  ({ threads }) as unknown as OrchestrationReadModel;

describe("latestProviderLimitSnapshots", () => {
  it("normalizes API rate-limit headers and does not fabricate a quota without headers", () => {
    const snapshot = providerLimitSnapshotFromRateLimits({
      provider: provider("sensenova-api", "api"),
      rateLimits: {
        model: "sensenova-6.7-flash-lite",
        "x-ratelimit-limit-requests": "1500",
        "x-ratelimit-remaining-requests": "1498",
        "x-ratelimit-reset-requests": "2026-08-10T14:00:00.000Z",
      },
      updatedAt: "2026-08-10T13:00:00.000Z",
      source: "provider-activity",
    });

    expect(snapshot).toMatchObject({
      driver: "api",
      windows: [{ label: "sensenova-6.7-flash-lite · Requests", usedPercent: 0.13333333333333333 }],
    });
    expect(
      providerLimitSnapshotFromRateLimits({
        provider: provider("sensenova-api", "api"),
        rateLimits: { model: "sensenova-6.7-flash-lite" },
        updatedAt: "2026-08-10T13:00:00.000Z",
        source: "provider-api",
      }),
    ).toBeNull();
  });

  it("preserves explicitly marked SenseNova local quota observations", () => {
    const snapshot = providerLimitSnapshotFromRateLimits({
      provider: provider("sensenova-api", "api"),
      rateLimits: {
        model: "sensenova-6.7-flash-lite",
        telemetrySource: "local-observation",
        "sensenova-quota-limit-requests": "1500",
        "sensenova-quota-remaining-requests": "1498",
        "sensenova-quota-reset-at": "2026-08-10T18:00:00.000Z",
      },
      updatedAt: "2026-08-10T13:00:00.000Z",
      source: "provider-activity",
    });
    expect(snapshot).toMatchObject({
      quality: "local-observation",
      windows: [{ label: "sensenova-6.7-flash-lite · Requests", limit: 1500, remaining: 1498 }],
    });
  });

  it("normalizes a direct Codex account quota read as provider API telemetry", () => {
    const snapshot = providerLimitSnapshotFromRateLimits({
      provider: provider("codex", "codex"),
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1_786_836_872 },
      },
      updatedAt: "2026-08-09T04:00:00.000Z",
      source: "provider-api",
    });

    expect(snapshot).toMatchObject({
      driver: "codex",
      source: "provider-api",
      windows: [{ label: "Weekly", usedPercent: 5, resetsAtMs: 1_786_836_872_000 }],
    });
  });

  it("keeps the newest provider-reported windows per configured instance", () => {
    const snapshots = latestProviderLimitSnapshots(
      [provider("codex", "codex")],
      readModel([
        {
          modelSelection: { instanceId: "codex" },
          activities: [
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T01:00:00.000Z",
              payload: { rateLimits: { primary: { usedPercent: 10 } } },
            },
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T02:00:00.000Z",
              payload: {
                rateLimits: {
                  planType: "plus",
                  primary: { usedPercent: "85", resetsAt: 1_786_239_600_000 },
                  credits: { balance: "$4", hasCredits: true, unlimited: false },
                },
              },
            },
          ],
        },
      ]),
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      instanceId: "codex",
      driver: "codex",
      planType: "plus",
      status: "warning",
      windows: [{ label: "Primary", usedPercent: 85 }],
      credits: { balance: "$4", hasCredits: true, unlimited: false },
      source: "provider-activity",
    });
  });

  it("does not fabricate telemetry for malformed or unsupported provider events", () => {
    const snapshots = latestProviderLimitSnapshots(
      [provider("custom", "custom-driver"), provider("claudeAgent", "claudeAgent")],
      readModel([
        {
          modelSelection: { instanceId: "custom" },
          activities: [
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T01:00:00.000Z",
              payload: { rateLimits: { weekly: { usedPercent: 50 } } },
            },
          ],
        },
        {
          modelSelection: { instanceId: "claudeAgent" },
          activities: [
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T01:01:00.000Z",
              payload: { rateLimits: { rate_limit_info: { utilization: "bad" } } },
            },
          ],
        },
      ]),
    );

    expect(snapshots).toEqual([]);
  });

  it("normalizes Codex weekly payloads and merges Claude windows", () => {
    const snapshots = latestProviderLimitSnapshots(
      [provider("codex", "codex"), provider("claudeAgent", "claudeAgent")],
      readModel([
        {
          modelSelection: { instanceId: "codex" },
          activities: [
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T02:00:00.000Z",
              payload: {
                rateLimits: {
                  plan_type: "plus",
                  primary: {
                    used_percent: 5,
                    window_minutes: 10080,
                    resets_at: 1786836872,
                  },
                },
              },
            },
          ],
        },
        {
          modelSelection: { instanceId: "claudeAgent" },
          activities: [
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T03:00:00.000Z",
              payload: {
                rateLimits: {
                  rate_limit_info: {
                    rateLimitType: "seven_day_opus",
                    utilization: 0.25,
                  },
                },
              },
            },
            {
              kind: "account.rate-limits.updated",
              createdAt: "2026-08-09T03:01:00.000Z",
              payload: {
                rateLimits: {
                  rate_limit_info: {
                    rateLimitType: "five_hour",
                    utilization: 0.5,
                  },
                },
              },
            },
          ],
        },
      ]),
    );

    expect(snapshots.find((snapshot) => snapshot.driver === "codex")).toMatchObject({
      planType: "plus",
      windows: [{ label: "Weekly", usedPercent: 5, resetsAtMs: 1786836872000 }],
    });
    expect(snapshots.find((snapshot) => snapshot.driver === "claudeAgent")?.windows).toEqual([
      { label: "Weekly · Opus", usedPercent: 25, resetsAtMs: null },
      { label: "5-hour", usedPercent: 50, resetsAtMs: null },
    ]);
  });
});
