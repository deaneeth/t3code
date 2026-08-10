import {
  ApiProviderProfileId,
  type ApiProviderProfileDescriptor,
  type ApiProviderProfileCatalog,
  type ApiProviderSettings,
} from "@t3tools/contracts";
import { buildAuthHeaders } from "./apiProviderTransport.ts";

/**
 * First-party API profiles. Profiles describe transport and discovery
 * metadata only; account data is obtained by probing with the instance's
 * server-side secret.
 */
export const API_PROVIDER_PROFILES: readonly ApiProviderProfileDescriptor[] = [
  {
    id: ApiProviderProfileId.make("openai"),
    displayName: "OpenAI",
    protocol: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: ApiProviderProfileId.make("anthropic"),
    displayName: "Anthropic",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    apiKeyHeader: "x-api-key",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.anthropic.com/en/api",
  },
  {
    id: ApiProviderProfileId.make("googleGemini"),
    displayName: "Google Gemini",
    protocol: "gemini-generate-content",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyHeader: "x-goog-api-key",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: ApiProviderProfileId.make("xai"),
    displayName: "xAI",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.x.ai/docs",
  },
  {
    id: ApiProviderProfileId.make("openrouter"),
    displayName: "OpenRouter",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: ApiProviderProfileId.make("mistral"),
    displayName: "Mistral",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.mistral.ai/api",
  },
  {
    id: ApiProviderProfileId.make("groq"),
    displayName: "Groq",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://console.groq.com/docs",
  },
  {
    id: ApiProviderProfileId.make("deepseek"),
    displayName: "DeepSeek",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://api-docs.deepseek.com",
  },
  {
    id: ApiProviderProfileId.make("together"),
    displayName: "Together AI",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.together.ai/reference",
  },
  {
    id: ApiProviderProfileId.make("fireworks"),
    displayName: "Fireworks AI",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.fireworks.ai",
  },
  {
    id: ApiProviderProfileId.make("perplexity"),
    displayName: "Perplexity",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.perplexity.ai",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: false,
    docsUrl: "https://docs.perplexity.ai",
  },
  {
    id: ApiProviderProfileId.make("cerebras"),
    displayName: "Cerebras",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://inference-docs.cerebras.ai",
  },
  {
    id: ApiProviderProfileId.make("cohere"),
    displayName: "Cohere",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.cohere.com/compatibility/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://docs.cohere.com",
  },
  {
    id: ApiProviderProfileId.make("sensenova"),
    displayName: "SenseNova",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://token.sensenova.ai/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
    docsUrl: "https://platform.sensenova.cn/product/APIService/document",
  },
  {
    id: ApiProviderProfileId.make("customOpenAICompatible"),
    displayName: "Custom OpenAI-compatible API",
    protocol: "openai-chat-completions",
    defaultBaseUrl: "https://api.example.com/v1",
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: true,
  },
  {
    id: ApiProviderProfileId.make("customAnthropicCompatible"),
    displayName: "Custom Anthropic-compatible API",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.example.com/v1",
    apiKeyHeader: "x-api-key",
    supportsCustomBaseUrl: true,
    supportsModelDiscovery: false,
  },
];

export const API_PROVIDER_PROFILE_BY_ID = new Map(
  API_PROVIDER_PROFILES.map((profile) => [profile.id, profile] as const),
);

export function buildApiProviderAuthHeaders(input: {
  readonly settings: Pick<ApiProviderSettings, "apiKeyHeader" | "apiKeyPrefix">;
  readonly profile: ApiProviderProfileDescriptor;
  readonly apiKey: string;
}): Readonly<Record<string, string>> {
  const header = input.settings.apiKeyHeader.trim() || input.profile.apiKeyHeader;
  if (header.toLowerCase() === "none") return {};
  const prefix =
    input.settings.apiKeyPrefix.trim() ||
    (input.settings.apiKeyHeader.trim() ? undefined : input.profile.apiKeyPrefix);
  return buildAuthHeaders({
    apiKey: input.apiKey,
    apiKeyHeader: header,
    ...(prefix ? { apiKeyPrefix: prefix } : {}),
  });
}

/**
 * Resolve a profile while tolerating the old generic OpenAI setting that was
 * commonly used for OpenAI-compatible gateways. SenseNova accepts Chat
 * Completions, not OpenAI Responses; silently keeping the old protocol turns
 * a valid key into a misleading 404 at `/responses`.
 */
export function resolveApiProviderProfile(
  settings: Pick<ApiProviderSettings, "profileId" | "baseUrl">,
): ApiProviderProfileDescriptor | undefined {
  const explicit = API_PROVIDER_PROFILE_BY_ID.get(settings.profileId as never);
  let hostname = "";
  try {
    hostname = new URL(settings.baseUrl.trim()).hostname.toLowerCase();
  } catch {
    // The normal URL validation path owns the user-facing invalid URL error.
  }
  if (
    (hostname === "token.sensenova.ai" ||
      hostname === "token.sensenova.cn" ||
      hostname === "api.sensenova.cn") &&
    (explicit?.id === ApiProviderProfileId.make("openai") ||
      explicit?.id === ApiProviderProfileId.make("customOpenAICompatible") ||
      explicit === undefined)
  ) {
    return API_PROVIDER_PROFILE_BY_ID.get(ApiProviderProfileId.make("sensenova"));
  }
  return explicit;
}

export function normalizeApiProviderSettings(settings: ApiProviderSettings): ApiProviderSettings {
  const profile = resolveApiProviderProfile(settings);
  if (!profile) return settings;
  return { ...settings, profileId: profile.id, protocol: profile.protocol };
}

export function isApiProviderChatModel(profileId: string, model: string): boolean {
  return !(profileId === "sensenova" && model.trim() === "sensenova-u1-fast");
}

export function apiProviderProfileCatalog(readAt: string): ApiProviderProfileCatalog {
  return { profiles: API_PROVIDER_PROFILES, readAt };
}
