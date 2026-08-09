import { describe, expect, it } from "@effect/vitest";

import type { OrchestrationReadModel, ServerProvider } from "@t3tools/contracts";

import { latestProviderLimitSnapshots } from "./ProviderLimits.ts";

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
});
