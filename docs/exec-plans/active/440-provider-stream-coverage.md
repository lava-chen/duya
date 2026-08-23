# Plan 440: Provider stream parsing coverage — degrade, never drop

> **Goal**: Close the gap between what the four `@duya/ai` stream parsers
> consume and what the provider APIs can actually emit. Order phases by
> blast radius: fix the live silent-failure path first (refusal → empty
> reply), then defuse the replay-correctness landmines (server-side tool
> blocks, encrypted reasoning), then telemetry capture, then new formats.

---

## Context

Audit of 2026-08-23 (grep-verified across `packages/ai`, zero-hit claims
re-checked line by line). The parsers are the four files in
[packages/ai/src/api/](../../../packages/ai/src/api/):
`anthropic-messages.ts`, `openai-completions.ts`, `openai-responses.ts`,
`ollama-chat.ts`.

Ignoring unknown event types is a **deliberate** current design —
[openai-responses.ts:674](../../../packages/ai/src/api/openai-responses.ts)
says "Unhandled event types are ignored". This plan upgrades that policy to
*degrade to a visible placeholder*, because silent drops are not free:

| # | Gap | Verified evidence | Severity |
|---|-----|-------------------|----------|
| 1 | Chat Completions `delta.refusal` unread | delta dispatch handles reasoning×3 / content / tool_calls / finish_reason only ([openai-completions.ts:696-756](../../../packages/ai/src/api/openai-completions.ts)) | **P0 — live bug**: a refusing model produces an empty assistant message |
| 2 | Anthropic server-side blocks unparsed (`server_tool_use`, `web_search_tool_result`, `code_execution`, `text_editor_*`) | `content_block_start` recognizes only thinking/redacted_thinking/text/tool_use ([anthropic-messages.ts:1065-1089](../../../packages/ai/src/api/anthropic-messages.ts)); grep = 0 | **P1 landmine**: once any server tool is enabled, dropped blocks break history replay — the Messages API requires `server_tool_use`/result pairs to round-trip |
| 3 | Responses output items beyond reasoning/message/function_call ignored (`web_search_call`, `code_interpreter_call`, `mcp_call`, `image_generation_call`, `file_search_call`) | [openai-responses.ts:514-528](../../../packages/ai/src/api/openai-responses.ts); :674 ignore comment | P1 landmine (same class as #2) |
| 4 | Responses `encrypted_content` not captured | grep = 0; only plaintext `response.reasoning_text.delta` (:605) and summary (:615) read | P1: required for reasoning replay with `store:false` |
| 5 | `annotations` / citations uncaptured | grep = 0 | P2: search-preview citations invisible |
| 6 | `logprobs` / `service_tier` / `safety_check` uncaptured | grep = 0 | P2: telemetry only |
| 7 | Audio input zero coverage | grep = 0 | **Won't fix by design**: voice pipeline (plans 410/427) is STT→text; no audio blocks intended |
| 8 | `ApiFormat` declares 7 values, 4 implemented | [types.ts:22-29](../../../packages/ai/src/types.ts); gemini/bedrock/vertex missing | P3 |

Two audit corrections baked in above: `output_item.added` handles **three**
item types (reasoning/message/function_call), not two; and "only Anthropic
multimodal works end-to-end" holds **only for tool_result inline images**
([types.ts:131-139](../../../packages/ai/src/types.ts),
[openai-completions.ts:369](../../../packages/ai/src/api/openai-completions.ts))
— user-message images already work on all three formats
(:308 `image_url`; responses :188 `input_image`; anthropic :1533 native).

## Design

### Principle: degrade, never drop

Every parser gains one shared escape hatch instead of four ad-hoc ignores:

```ts
// packages/ai/src/api/degrade.ts (NEW)
interface ProviderBlockContent {
  type: 'provider_block';
  /** api format that produced this block */
  origin: 'anthropic' | 'openai-chat' | 'openai-responses';
  kind: string;            // e.g. 'server_tool_use', 'web_search_call'
  payload: unknown;        // verbatim provider shape
}
```

- **Inbound**: unknown block/item types become `provider_block` (plus a
  short text summary appended to the visible stream so users see *something*
  happened).
- **Outbound** (`transform-messages.ts`): a `provider_block` is forwarded
  verbatim only when target format === origin AND the block round-trips;
  otherwise downgraded to a one-line text placeholder. This keeps replay
  valid without pretending a server-executed call is a local `tool_use`
  (mapping it to `ToolUseContent` would make StreamingToolExecutor try to
  execute it locally — explicitly rejected).
- One generic carrier beats seven new union members; per-type unions can be
  introduced later if a consumer needs typed access.

### Phase-scoped decisions

- **P0 refusal**: `delta.refusal` (and non-streaming `message.refusal` if
  that path exists) flows through the normal `appendText` path — refusal
  text IS user-visible text. No new stop reason; `end_turn` stands.
- **P2 encrypted reasoning**: extend `ThinkingContent` with optional
  `encrypted?: string` — same pattern as the existing
  `textSignature`/`thoughtSignature`/`thinkingSignature` passthrough props
  ([types.ts:36-75](../../../packages/ai/src/types.ts)). Outbound: when the
  request runs with `store:false`, re-emit as the encrypted reasoning item.
- **P2 annotations**: `TextContent.annotations?: unknown[]` capture-only;
  rendering citations is frontend work, tracked separately (not here).
- **P2 logprobs/service_tier**: attach to response-level metadata
  (alongside usage), never into content.
- **P3 formats**: bedrock/vertex are expected to reuse the
  `anthropic-messages` protocol layer behind different auth/baseURL — the
  phase starts with a diff-verification task before any code. Gemini-native
  is a real parser; if it outgrows this plan it splits into `440a`.

## Files

- [packages/ai/src/types.ts](../../../packages/ai/src/types.ts) — add
  `ProviderBlockContent` to the `MessageContent` union; optional
  `encrypted` on `ThinkingContent`; optional `annotations` on `TextContent`.
- [packages/ai/src/api/degrade.ts](../../../packages/ai/src/api/degrade.ts)
  **NEW** — carrier type + `degradeUnknownBlock()` + outbound
  forward-or-downgrade rule, shared by all parsers.
- [packages/ai/src/api/anthropic-messages.ts](../../../packages/ai/src/api/anthropic-messages.ts)
  — `content_block_start`/`_delta`/`_stop`: unknown types → carrier (#2).
- [packages/ai/src/api/openai-responses.ts](../../../packages/ai/src/api/openai-responses.ts)
  — `output_item.added`/`done`: remaining item types → carrier (#3);
  capture `encrypted_content` (#4); replace the :674 ignore-comment policy.
- [packages/ai/src/api/openai-completions.ts](../../../packages/ai/src/api/openai-completions.ts)
  — `delta.refusal` → appendText (#1); annotations capture (#5);
  logprobs/service_tier → metadata (#6).
- [packages/ai/src/api/transform-messages.ts](../../../packages/ai/src/api/transform-messages.ts)
  — outbound carrier rule (forward iff same-origin, else placeholder).
- Tests (packages/ai/test/, run from repo root — root vitest config owns
  `setupFiles`): `refusal.test.ts` **NEW**, `degrade.test.ts` **NEW**
  (round-trip: serialize → transform → assert no unknown types reach any
  upstream payload), plus cases added to `anthropic-robustness.test.ts`,
  `openai-completions-robustness.test.ts`, and a **NEW**
  `openai-responses.test.ts` (currently no coverage at all).
- After union changes: update [ARCHITECTURE.md](../../../ARCHITECTURE.md).

Out of scope: audio blocks (#7, won't-fix by design); citation rendering
UI; actually *enabling* server-side tools (a separate feature plan — 440
only makes streams safe when they appear anyway).

## Status

- [x] **Phase 0 (P0)** — refusal: completions stream (+non-stream if
      present) → appendText; `refusal.test.ts` ✅ 2026-08-23 (f8e820d1)
- [x] **Phase 1 (P1)** — degradation policy: `degrade.ts` carrier +
      outbound rule; anthropic server-side block pairs; responses remaining
      item types; round-trip replay test; kill the silent-ignore comment
      ✅ 2026-08-23 (0658daf6)
- [x] **Phase 2 (P2)** — `encrypted_content` replay; annotations capture;
      logprobs/service_tier metadata; `openai-responses.test.ts` baseline
      ✅ 2026-08-23 (2a2ef7ba, tsc fixes 74020a7d). Deviation: the Responses
      event switch was extracted into an exported `parseResponsesEvent`
      (mirrors `parseAnthropicEvent`) to give the new baseline tests a
      protocol-level seam.
- [ ] **Phase 3 (P3)** — bedrock/vertex diff-verification then auth
      adapters over `anthropic-messages`; gemini-native parser (split to
      440a if large)
- [x] Each merged phase: `npm run typecheck:all` + root-level vitest green
      — ai suite 289/289 (30 files); typecheck verified per-surface
      (web/agent in-chain, cli/conductor/voice standalone after an
      environment-only npm crash at the cli step); `build:ai` clean

## Decision log

- 2026-08-23 — Carrier (`provider_block`) chosen over per-type union
  members and over faking `tool_use`: fakes would trigger local execution;
  unions ripple through persistence/rendering for data nothing consumes yet.
- 2026-08-23 — Refusal maps to plain text, not a new stop reason: it is
  user-visible prose, and a new reason would leak into every consumer switch.
- 2026-08-23 — Audio marked won't-fix: product routes voice through STT→text
  (plans 410/427); audio blocks would be dead code.
