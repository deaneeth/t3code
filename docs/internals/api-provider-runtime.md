# API provider runtime

The `api` driver uses a profile registry rather than guessing a provider from a
secret. Profiles define the protocol, endpoint, authentication header, model
discovery behavior, and known capability boundaries.

The adapter normalizes OpenAI Responses, OpenAI Chat Completions, Anthropic
Messages, and Gemini responses into T3 runtime events. OpenAI-compatible and
Anthropic streams can emit text deltas and tool-call fragments. T3 executes
`run_command`, `read_file`, and `write_file` through server Effect services;
approval-required sessions suspend on a canonical approval request until the
client resolves it. Tool results are replayed into the provider conversation.

Usage is normalized from provider response events into
`thread.token-usage.updated`. Rate-limit response headers are retained and
published as `account.rate-limits.updated`. Credits and billing remain
explicitly unavailable unless a profile implements a verified provider
endpoint; token counts are not silently converted into cost.

The provider snapshot includes `apiCapabilities`, which is wire-safe and
contains no key material. Every capability includes a state, timestamp, and
human-readable provenance detail so stale or unsupported data is visible on
all clients.
