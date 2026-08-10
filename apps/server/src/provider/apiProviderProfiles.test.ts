import { describe, expect, it } from "vite-plus/test";

import { ApiProviderProfileId } from "@t3tools/contracts";
import {
  API_PROVIDER_PROFILES,
  API_PROVIDER_PROFILE_BY_ID,
  normalizeApiProviderSettings,
  resolveApiProviderProfile,
} from "./apiProviderProfiles.ts";

describe("API provider profile catalog", () => {
  it("has unique ids and complete transport metadata", () => {
    expect(API_PROVIDER_PROFILES.length).toBeGreaterThan(1);
    expect(API_PROVIDER_PROFILE_BY_ID.size).toBe(API_PROVIDER_PROFILES.length);
    for (const profile of API_PROVIDER_PROFILES) {
      expect(profile.id.length).toBeGreaterThan(0);
      expect(profile.displayName.length).toBeGreaterThan(0);
      expect(profile.defaultBaseUrl).toMatch(/^https:\/\//);
      expect(profile.apiKeyHeader.length).toBeGreaterThan(0);
    }
  });

  it("includes a configurable compatibility fallback", () => {
    expect(
      API_PROVIDER_PROFILE_BY_ID.has(ApiProviderProfileId.make("customOpenAICompatible")),
    ).toBe(true);
    expect(
      API_PROVIDER_PROFILE_BY_ID.has(ApiProviderProfileId.make("customAnthropicCompatible")),
    ).toBe(true);
  });

  it("uses SenseNova's documented token gateway as the default", () => {
    expect(
      API_PROVIDER_PROFILE_BY_ID.get(ApiProviderProfileId.make("sensenova"))?.defaultBaseUrl,
    ).toBe("https://token.sensenova.ai/v1");
  });

  it("covers every supported profile with an explicit protocol contract", () => {
    const protocols = new Set(API_PROVIDER_PROFILES.map((profile) => profile.protocol));
    expect(protocols).toEqual(
      new Set([
        "openai-responses",
        "openai-chat-completions",
        "anthropic-messages",
        "gemini-generate-content",
      ]),
    );
    for (const profile of API_PROVIDER_PROFILES) {
      expect([
        "openai-responses",
        "openai-chat-completions",
        "anthropic-messages",
        "gemini-generate-content",
      ]).toContain(profile.protocol);
      expect(profile.defaultBaseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("corrects legacy OpenAI Responses settings for SenseNova gateways", () => {
    const profile = resolveApiProviderProfile({
      profileId: "openai",
      baseUrl: "https://token.sensenova.ai/v1",
    });
    expect(profile?.id).toBe("sensenova");
    expect(profile?.protocol).toBe("openai-chat-completions");
    expect(
      normalizeApiProviderSettings({
        enabled: true,
        profileId: "openai",
        protocol: "openai-responses",
        baseUrl: "https://token.sensenova.ai/v1",
        apiKeyHeader: "",
        apiKeyPrefix: "",
        apiKeyEnvironmentVariable: "T3_API_KEY",
        organization: "",
        project: "",
        region: "",
        customModels: [],
      }).protocol,
    ).toBe("openai-chat-completions");
  });

  it("corrects a previously saved custom-compatible SenseNova setting", () => {
    const profile = resolveApiProviderProfile({
      profileId: "customOpenAICompatible",
      baseUrl: "https://token.sensenova.ai/v1",
    });
    expect(profile?.id).toBe("sensenova");
  });
});
