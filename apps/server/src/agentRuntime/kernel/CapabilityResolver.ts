/**
 * CapabilityResolver — universal provider capability negotiation.
 *
 * Calculates effective capabilities from the intersection of:
 * - Provider capabilities (what the provider supports)
 * - Protocol capabilities (what the API protocol supports)
 * - Model capabilities (what the specific model supports)
 * - Connection capabilities (what the current connection supports)
 *
 * The kernel never checks `provider === "senseova"`. It only uses
 * the resolved capabilities.
 *
 * @module agentRuntime/kernel/CapabilityResolver
 */

export interface ProviderCapabilities {
  /** Whether the provider supports tool use. */
  readonly tools: boolean;
  /** Whether the provider supports streaming. */
  readonly streaming: boolean;
  /** Whether the provider supports parallel tool calls. */
  readonly parallelTools: boolean;
  /** Whether the provider supports vision/image input. */
  readonly vision: boolean;
  /** Whether the provider supports reasoning/thinking. */
  readonly reasoning: boolean;
  /** Whether the provider supports structured output. */
  readonly structuredOutput: boolean;
  /** Whether the provider reports token usage. */
  readonly usageReporting: boolean;
  /** Whether the provider reports rate limits. */
  readonly rateLimitReporting: boolean;
  /** Maximum context window for this provider. */
  readonly maxContextTokens?: number | undefined;
}

export interface ModelCapabilities {
  /** Maximum output tokens. */
  readonly maxOutputTokens?: number | undefined;
  /** Whether this model supports extended thinking. */
  readonly extendedThinking: boolean;
  /** Whether this model supports vision. */
  readonly vision: boolean;
  /** Tokenizer family for accurate token counting. */
  readonly tokenizerFamily: "cl100k" | "o200k" | "gemini" | "unknown";
}

export interface ProtocolCapabilities {
  /** Whether the protocol supports streaming. */
  readonly streaming: boolean;
  /** Whether the protocol supports tool results in streaming. */
  readonly streamToolResults: boolean;
  /** Whether the protocol supports system prompts. */
  readonly systemPrompts: boolean;
  /** Whether the protocol supports temperature control. */
  readonly temperature: boolean;
}

export interface ConnectionCapabilities {
  /** Whether the connection is alive. */
  readonly alive: boolean;
  /** Whether the connection supports streaming. */
  readonly streaming: boolean;
  /** Latency in ms (if known). */
  readonly latencyMs?: number | undefined;
}

export interface EffectiveCapabilities {
  /** Whether tools are available. */
  readonly tools: boolean;
  /** Whether streaming is available. */
  readonly streaming: boolean;
  /** Whether parallel tool calls are supported. */
  readonly parallelTools: boolean;
  /** Whether vision is available. */
  readonly vision: boolean;
  /** Whether reasoning/thinking is available. */
  readonly reasoning: boolean;
  /** Whether structured output is available. */
  readonly structuredOutput: boolean;
  /** Whether usage is reported. */
  readonly usageReporting: boolean;
  /** Whether rate limits are reported. */
  readonly rateLimitReporting: boolean;
  /** Effective context window (minimum of provider and model). */
  readonly contextWindow: number;
  /** Maximum output tokens. */
  readonly maxOutputTokens: number;
  /** Tokenizer family. */
  readonly tokenizerFamily: "cl100k" | "o200k" | "gemini" | "unknown";
}

const DEFAULT_EFFECTIVE: EffectiveCapabilities = {
  tools: false,
  streaming: false,
  parallelTools: false,
  vision: false,
  reasoning: false,
  structuredOutput: false,
  usageReporting: false,
  rateLimitReporting: false,
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  tokenizerFamily: "unknown",
};

/**
 * CapabilityResolver computes effective capabilities.
 */
export class CapabilityResolver {
  private cache = new Map<string, EffectiveCapabilities>();

  /**
   * Resolve effective capabilities from all sources.
   */
  resolve(input: {
    readonly provider: ProviderCapabilities;
    readonly model: ModelCapabilities;
    readonly protocol: ProtocolCapabilities;
    readonly connection: ConnectionCapabilities;
  }): EffectiveCapabilities {
    const key = this.cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const capabilities: EffectiveCapabilities = {
      tools: input.provider.tools,
      streaming: input.provider.streaming && input.protocol.streaming && input.connection.streaming,
      parallelTools: input.provider.parallelTools,
      vision: input.provider.vision && input.model.vision,
      reasoning: input.provider.reasoning && input.model.extendedThinking,
      structuredOutput: input.provider.structuredOutput,
      usageReporting: input.provider.usageReporting,
      rateLimitReporting: input.provider.rateLimitReporting,
      contextWindow:
        (input.provider.maxContextTokens ?? DEFAULT_EFFECTIVE.contextWindow) ||
        DEFAULT_EFFECTIVE.contextWindow,
      maxOutputTokens:
        (input.model.maxOutputTokens ?? DEFAULT_EFFECTIVE.maxOutputTokens) ||
        DEFAULT_EFFECTIVE.maxOutputTokens,
      tokenizerFamily: input.model.tokenizerFamily,
    };

    this.cache.set(key, capabilities);
    return capabilities;
  }

  /**
   * Get a summary of capabilities for debugging.
   */
  summarize(caps: EffectiveCapabilities): string {
    const features: string[] = [];
    if (caps.tools) features.push("tools");
    if (caps.streaming) features.push("streaming");
    if (caps.parallelTools) features.push("parallel-tools");
    if (caps.vision) features.push("vision");
    if (caps.reasoning) features.push("reasoning");
    if (caps.structuredOutput) features.push("structured-output");

    return [
      `Capabilities: ${features.join(", ") || "none"}`,
      `Context: ${caps.contextWindow} tokens`,
      `Max output: ${caps.maxOutputTokens} tokens`,
      `Tokenizer: ${caps.tokenizerFamily}`,
    ].join("\n");
  }

  /**
   * Clear cache (e.g., when connection changes).
   */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(input: {
    readonly provider: ProviderCapabilities;
    readonly model: ModelCapabilities;
    readonly protocol: ProtocolCapabilities;
    readonly connection: ConnectionCapabilities;
  }): string {
    return [
      JSON.stringify(input.provider),
      JSON.stringify(input.model),
      JSON.stringify(input.protocol),
      JSON.stringify(input.connection),
    ].join("|");
  }
}
