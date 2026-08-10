# API provider implementation plan

This plan tracks the API-backed coding-agent runtime from transport through the
web client. Each phase is complete only after its focused tests and the
isolated web integration check pass.

## Phase 0: baseline and test harness

- [x] Use the repository-supported Node runtime.
- [x] Run the existing API-provider contract/profile/transport tests.
- [x] Add a disposable mock OpenAI-compatible server for deterministic E2E tests.
- [x] Keep live provider credentials out of tests and logs.

## Phase 1: canonical transport contract

- [x] Separate provider profile selection from protocol selection.
- [x] Normalize request, stream event, usage, error, and rate-limit shapes.
- [x] Support manual model IDs when model discovery is unavailable.
- [x] Preserve explicit capability states; provider model metadata remains a follow-up.
- [x] Add protocol-specific request/history/tool mappers.

## Phase 2: complete agent loop

- [x] Append assistant messages and tool calls/results to canonical history.
- [x] Continue tool rounds until a final assistant response.
- [x] Preserve provider-specific history formats for Responses, Chat, Anthropic,
      and Gemini.
- [x] Make tool-call IDs unique and avoid replaying a completed tool round.
- [x] Honor approval decisions and cancellation.

## Phase 3: session correctness

- [x] Return populated thread snapshots.
- [x] Make rollback update both visible turns and provider history.
- [x] Restore API sessions from persisted T3 thread state.
- [x] Remove capability claims that are not implemented.

## Phase 4: verification and UI

- [x] Make connection testing use the same transport contract as agent turns.
- [x] Test discovery, manual models, streaming, tools, usage, and failures.
- [x] Remove the duplicated web profile-choice catalog by sharing it from contracts.
- [ ] Ensure configured API providers are visible on web, desktop, and mobile; web/desktop are verified by compile and server integration, mobile has unrelated existing type errors.

## Phase 5: hardening and telemetry

- [x] Add request timeouts, retry-after handling, and bounded retries.
- [x] Protect custom endpoints and tool paths.
- [x] Persist usage atomically and record every LLM request.
- [x] Distinguish provider-reported and unavailable cost; pricing-catalog estimates remain a follow-up.
- [x] Capture rate-limit headers without pretending account billing is available.
- [x] Normalize API `x-ratelimit-*`/`ratelimit-*` headers into provider-limit
      windows, preserving the active model in the window label.
- [x] Decode SenseNova's nested `{ data: { usage } }` response envelope and
      include its knowledge-token component in input usage.
- [x] Expose API-provider rate-limit telemetry in Plans & limits and the chat
      context popover when the endpoint reports it, including absolute limit
      and remaining values.
- [x] Pass configured OpenAI organization/project headers and custom API
      authentication headers through the verification request.
- [x] Keep SenseNova dashboard-only account data distinct from the documented
      per-model quota: provider headers win when present; otherwise Plans &
      limits and the chat popover show an explicitly labelled T3-observed
      1,500-request/5-hour window from the persisted request ledger.

## Verification gate

- [x] Focused unit and contract tests pass.
- [x] Mock-provider agent task reads a file, performs the tool round, and completes.
- [ ] Wrong key, missing model, malformed stream, tool failure, cancellation,
      and context overflow are covered.
- [ ] Isolated web E2E verifies provider setup, model selection, a tool task,
      approval, interruption, and usage display; browser automation is unavailable in this session.

## SenseNova telemetry boundary

SenseNova's public Token Plan page describes a per-model 1,500-call/5-hour
window, and its API documentation describes token usage in responses and 429
over-limit errors. It does not document an API-key-authenticated endpoint that
returns the console's account-wide remaining-call dashboard. T3 therefore
reports provider rate-limit headers when present and otherwise derives a
durable, explicitly labelled T3-observed window from its own persisted request
ledger. It never presents that local count as the account-wide dashboard
balance or scrapes a dashboard session.
