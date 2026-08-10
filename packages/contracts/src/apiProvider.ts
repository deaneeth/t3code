import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Wire-safe protocol families implemented by an API provider profile. */
export const ApiProviderProtocol = Schema.Literals([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
]);
export type ApiProviderProtocol = typeof ApiProviderProtocol.Type;

/** Browser-safe profile choices shared by setup surfaces. Server-side probe metadata remains authoritative. */
export const API_PROVIDER_PROFILE_OPTIONS = [
  ["openai", "OpenAI Responses", "openai-responses"],
  ["anthropic", "Anthropic Messages", "anthropic-messages"],
  ["googleGemini", "Google Gemini", "gemini-generate-content"],
  ["xai", "xAI", "openai-chat-completions"],
  ["openrouter", "OpenRouter", "openai-chat-completions"],
  ["mistral", "Mistral", "openai-chat-completions"],
  ["groq", "Groq", "openai-chat-completions"],
  ["deepseek", "DeepSeek", "openai-chat-completions"],
  ["together", "Together AI", "openai-chat-completions"],
  ["fireworks", "Fireworks AI", "openai-chat-completions"],
  ["perplexity", "Perplexity", "openai-chat-completions"],
  ["cerebras", "Cerebras", "openai-chat-completions"],
  ["cohere", "Cohere", "openai-chat-completions"],
  ["sensenova", "SenseNova", "openai-chat-completions"],
  ["customOpenAICompatible", "Custom OpenAI-compatible", "openai-chat-completions"],
  ["customAnthropicCompatible", "Custom Anthropic-compatible", "anthropic-messages"],
] as const satisfies ReadonlyArray<readonly [string, string, ApiProviderProtocol]>;

/** Known first-party profiles. Custom profiles use the open slug contract. */
export const ApiProviderProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("ApiProviderProfileId"));
export type ApiProviderProfileId = typeof ApiProviderProfileId.Type;

export const ApiProviderCapabilityState = Schema.Literals([
  "verified",
  "partial",
  "stale",
  "unavailable",
]);
export type ApiProviderCapabilityState = typeof ApiProviderCapabilityState.Type;

export const ApiProviderCapability = Schema.Struct({
  state: ApiProviderCapabilityState,
  detail: Schema.optional(TrimmedNonEmptyString),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type ApiProviderCapability = typeof ApiProviderCapability.Type;

export const ApiProviderCapabilities = Schema.Struct({
  authentication: ApiProviderCapability,
  modelDiscovery: ApiProviderCapability,
  streaming: ApiProviderCapability,
  toolCalls: ApiProviderCapability,
  approvals: ApiProviderCapability,
  attachments: ApiProviderCapability,
  sessions: ApiProviderCapability,
  perRequestUsage: ApiProviderCapability,
  rateLimits: ApiProviderCapability,
  credits: ApiProviderCapability,
  billing: ApiProviderCapability,
});
export type ApiProviderCapabilities = typeof ApiProviderCapabilities.Type;

export const ApiProviderProbeStatus = Schema.Literals([
  "not-configured",
  "checking",
  "ready",
  "partial",
  "error",
]);
export type ApiProviderProbeStatus = typeof ApiProviderProbeStatus.Type;

export const ApiProviderProfileDescriptor = Schema.Struct({
  id: ApiProviderProfileId,
  displayName: TrimmedNonEmptyString,
  protocol: ApiProviderProtocol,
  defaultBaseUrl: TrimmedNonEmptyString,
  apiKeyHeader: TrimmedNonEmptyString,
  apiKeyPrefix: Schema.optional(Schema.String),
  supportsCustomBaseUrl: Schema.Boolean,
  supportsModelDiscovery: Schema.Boolean,
  docsUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ApiProviderProfileDescriptor = typeof ApiProviderProfileDescriptor.Type;

export const ApiProviderProfileCatalog = Schema.Struct({
  profiles: Schema.Array(ApiProviderProfileDescriptor),
  readAt: IsoDateTime,
});
export type ApiProviderProfileCatalog = typeof ApiProviderProfileCatalog.Type;

/** Ephemeral, non-persisted input for verifying a provider before saving it. */
export const ApiProviderTestInput = Schema.Struct({
  profileId: ApiProviderProfileId,
  protocol: ApiProviderProtocol,
  baseUrl: Schema.String,
  apiKeyHeader: Schema.optional(Schema.String),
  apiKeyPrefix: Schema.optional(Schema.String),
  apiKey: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
});
export type ApiProviderTestInput = typeof ApiProviderTestInput.Type;

export const ApiProviderTestResult = Schema.Struct({
  model: TrimmedNonEmptyString,
  response: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export type ApiProviderTestResult = typeof ApiProviderTestResult.Type;

export class ApiProviderTestError extends Schema.TaggedErrorClass<ApiProviderTestError>()(
  "ApiProviderTestError",
  {
    profileId: ApiProviderProfileId,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Status returned by the provider-specific probe. Secrets and raw responses
 * must never be included in this shape.
 */
export const ApiProviderProbeSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  profileId: ApiProviderProfileId,
  status: ApiProviderProbeStatus,
  message: Schema.optional(TrimmedNonEmptyString),
  accountLabel: Schema.optional(TrimmedNonEmptyString),
  keyFingerprint: Schema.optional(TrimmedNonEmptyString),
  capabilities: ApiProviderCapabilities,
  discoveredModelCount: NonNegativeInt,
  lastSuccessfulProbeAt: Schema.NullOr(IsoDateTime),
  checkedAt: IsoDateTime,
});
export type ApiProviderProbeSnapshot = typeof ApiProviderProbeSnapshot.Type;
