/**
 * Transport factory — instantiates the correct LLM transport.
 *
 * Provider ≠ Protocol separation: SenseNova, Groq, OpenRouter all use
 * OpenAIChatTransport; only OpenAI first-party uses OpenAIResponsesTransport.
 *
 * @module agentRuntime/transport
 */
import type { LLMTransport, TransportProviderKind } from "./LLMTransport.ts";
import { OpenAIChatTransport } from "./OpenAIChatTransport.ts";
import { OpenAIResponsesTransport } from "./OpenAIResponsesTransport.ts";
import { AnthropicTransport } from "./AnthropicTransport.ts";
import { GeminiTransport } from "./GeminiTransport.ts";

/**
 * Determine the provider kind from a base URL.
 * Provider ≠ Protocol: SenseNova, Groq, OpenRouter all use OpenAI-compatible
 * Chat Completions, so they are "openai" for transport purposes.
 */
export function detectProviderKind(baseUrl: string): TransportProviderKind {
  const url = baseUrl.toLowerCase();

  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("generativelanguage.googleapis.com") || url.includes("googleapis.com")) {
    return "gemini";
  }
  if (url.includes("openai.com")) return "openai";
  // SenseNova, Groq, OpenRouter, Together, etc. all use OpenAI-compatible
  if (
    url.includes("openai") ||
    url.includes("groq") ||
    url.includes("together") ||
    url.includes("openrouter")
  ) {
    return "openai";
  }
  // Default: assume OpenAI-compatible
  return "openai";
}

export function createTransport(providerKind: TransportProviderKind): LLMTransport {
  switch (providerKind) {
    case "anthropic":
      return new AnthropicTransport();
    case "gemini":
      return new GeminiTransport();
    case "openai":
      // Use Responses transport only for first-party OpenAI URLs.
      // All other OpenAI-compatible providers use Chat Completions.
      return new OpenAIChatTransport();
    default: {
      const _exhaustive: never = providerKind;
      throw new Error(`Unknown provider kind: ${_exhaustive}`);
    }
  }
}

/**
 * Create a transport from a base URL, auto-detecting the provider kind.
 */
export function createTransportFromUrl(baseUrl: string): LLMTransport {
  return createTransport(detectProviderKind(baseUrl));
}

export type {
  LLMTransport,
  TransportProviderKind,
  TransportBuildInput,
  TransportResponse,
  TransportError,
  TransportUsage,
  TransportAttachment,
  TransportHistoryEntry,
  TransportStreamEvent,
} from "./LLMTransport.ts";
