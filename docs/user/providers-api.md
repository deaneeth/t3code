# API-key providers

T3 Code can connect directly to model APIs from Settings → Providers. Choose
API Provider, select the provider protocol, enter the key, and optionally set a
custom base URL, organization, project, or region.

Keys are stored as sensitive server-side provider environment values. They are
not returned to the client, model snapshots, usage records, logs, or errors.

The provider status card reports model discovery and runtime capabilities using
explicit states: verified, partial, unavailable, or stale. A missing quota or
billing endpoint is shown as unavailable; it is never treated as zero.

The OpenAI Responses, OpenAI-compatible, Anthropic, and Gemini profiles use
their native streaming formats, T3 tool execution when the selected model/API
advertises function calling, approval-required mode, session replay, and
per-request usage when the provider returns it. Image attachment translation
and structured user-input requests are supported through the T3 runtime;
capability remains partial because model vision access and provider-specific
input limits are account/model-specific.

SenseNova's documented Chat Completions API supports text/image input,
streaming, function tools, `tool_choice`, parallel tool calls, and streamed
usage. T3 therefore runs SenseNova through the same coding-agent loop as other
API providers: repository reads, file changes, shell commands, approvals,
tool-result follow-ups, session replay, and interruption are supported when the
selected model advertises tools. Its `sensenova-6.7-flash-lite` metadata is
used for the 256K context and 64K maximum output limits.

SenseNova U1 Fast is an image-generation model at `/images/generations`, not a
chat model. T3 excludes it from chat/agent model selection and reports a clear
validation error if it is entered manually.

SenseNova uses the OpenAI-compatible Chat Completions protocol. Existing
instances pointed at `token.sensenova.ai` or `token.sensenova.cn` are corrected
automatically if they were previously saved as the generic OpenAI Responses
profile.

Provider-reported token usage and rate-limit headers are displayed when the API
supplies them. SenseNova's documented 1,500-request/5-hour model quota is also
shown as a clearly labelled T3-observed window based on this server's persisted
API request ledger when quota headers are absent. It is not presented as an
account-wide dashboard balance. T3 does not claim an exact credit or billing
amount when the provider does not expose a verified billing API. API ledger
records are merged into the Usage page's API providers series; unpriced token
totals remain visible without being converted into fabricated cost.
