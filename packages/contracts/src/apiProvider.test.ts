import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ApiProviderCapability,
  ApiProviderProfileCatalog,
  ApiProviderProbeSnapshot,
} from "./apiProvider.ts";

const decodeCapability = Schema.decodeUnknownSync(ApiProviderCapability);
const decodeCatalog = Schema.decodeUnknownSync(ApiProviderProfileCatalog);
const decodeProbe = Schema.decodeUnknownSync(ApiProviderProbeSnapshot);

const capability = (state: "verified" | "partial" | "stale" | "unavailable") =>
  decodeCapability({ state, checkedAt: null });

describe("API provider contracts", () => {
  it("accepts a profile catalog without exposing credentials", () => {
    const catalog = decodeCatalog({
      readAt: "2026-08-09T00:00:00.000Z",
      profiles: [
        {
          id: "openai",
          displayName: "OpenAI",
          protocol: "openai-responses",
          defaultBaseUrl: "https://api.openai.com/v1",
          apiKeyHeader: "Authorization",
          apiKeyPrefix: "Bearer ",
          supportsCustomBaseUrl: true,
          supportsModelDiscovery: true,
        },
      ],
    });

    expect(catalog.profiles[0]?.id).toBe("openai");
    expect(catalog.profiles[0]).not.toHaveProperty("apiKey");
  });

  it("represents partial telemetry explicitly", () => {
    const probe = decodeProbe({
      instanceId: "api_openai",
      driver: "api",
      profileId: "openai",
      status: "partial",
      capabilities: {
        authentication: capability("verified"),
        modelDiscovery: capability("verified"),
        streaming: capability("verified"),
        toolCalls: capability("verified"),
        approvals: capability("verified"),
        attachments: capability("partial"),
        sessions: capability("partial"),
        perRequestUsage: capability("verified"),
        rateLimits: capability("unavailable"),
        credits: capability("unavailable"),
        billing: capability("unavailable"),
      },
      discoveredModelCount: 2,
      lastSuccessfulProbeAt: "2026-08-09T00:00:00.000Z",
      checkedAt: "2026-08-09T00:00:00.000Z",
    });

    expect(probe.status).toBe("partial");
    expect(probe.capabilities.rateLimits.state).toBe("unavailable");
    expect(probe).not.toHaveProperty("apiKey");
  });
});
