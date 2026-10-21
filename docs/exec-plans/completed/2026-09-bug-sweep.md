# Bug Sweep — 2026-09

> **Status:** completed (10 bugs fixed, 10 commits landed on `master`).
> Reference document — read this before any future bug-hunt pass
> and cross-check new diffs against the patterns listed here.

## Goal

Hunt down ~10 bugs in the existing tree, fix them, commit each one
with a clean Conventional Commits message, and document the patterns
so the next sweep starts with a checklist instead of a blank slate.

## Fixes

Each fix landed as its own atomic commit; the order below matches the
commit graph.

| # | Bug | Commit | Files |
|---|-----|--------|-------|
| 1 | Token-usage aggregator double-counts `cache_hit` on every turn (cache-exclusive providers re-report the whole cached prefix each round) | `2a148e3f` | `packages/agent/src/process/seed-token-usage.ts`, `src/hooks/useContextUsage.ts`, `src/lib/context-usage-utils.ts` |
| 2 | `ChannelBackgroundWakes.deliverToChannel` catch branch uses `!` on a `parseChannelAddress()` result that documents null-on-malformed | `b0692975` | `electron/wake/channels.ts`, `electron/agents/db-bridge.ts` |
| 3 | `session-spawn.e2e.test.ts` imports `SessionStore` from the wrong barrel (`../../db/core/stores` vs. the real `session-store.ts`) | `e888868e` | `electron/agents/__tests__/session-spawn.e2e.test.ts` |
| 4 | `agent-process-pool.test.ts` reaches into the private `pool.router` field — tsc silently fails on test files that aren't in the project include glob | `e457642a` | `electron/agents/process-pool/agent-process-pool.test.ts` |
| 5 | `botAgentConfigFor` calls `readConfigAgents()` without awaiting (returns `Promise<Record>`), indexes the Promise object — bot provider/model backfill always fell through | `3733d1bd` | `electron/agents/db-bridge.ts` |
| 6 | `useSettings` mcpServers save path silently no-ops when `setMcpServers` API is missing — caller sees a successful await | `deb59af6` | `src/hooks/useSettings.ts` |
| 7 | `probe()` returns `reachable: true` on `timeout`, so doctor re-times-out on every dependent check (turning one 30s timeout into many) | `198305cf` | `packages/cli/src/api/client.ts` |
| 8 | Runtime-file port validator accepts `port: 0` (kernel-assigned sentinel) — CLI then tries `http://127.0.0.1:0` and surfaces a confusing ECONNREFUSED | `6840e8b5` | `packages/cli/src/api/runtime-config.ts` |
| 9 | Context-usage breakdown grid's last-cell fullness formula simplifies to `1` for every input — the partial cell always renders full | `7f34ed00` | `src/lib/context-usage-utils.ts` |
| 10 | `extractNestedProviderErrorMessage` only strips the bare `429 ` prefix; Anthropic / OpenAI SDKs emit the verbose `HTTP 429 …` form and the unwrap leaves a dangling `HTTP` | `a49fbeac` | `src/lib/stream-session-manager.ts` |

## Bug pattern catalog

When reviewing a new diff, run through this list. The next sweep should
hit the same shapes again if any of these resurface.

### 1. Async return treated as a value

A helper is declared `async` (or its underlying dependency returns a
`Promise<T>`) but a caller uses the result synchronously — typically
by indexing it (`map[agentId]`) or calling a method on it (`.create(...)`)
before the `await`.

- Real example: `electron/agents/db-bridge.ts:51` (`botAgentConfigFor`)
- Detect with: tsc flags it as `TS7053`; lint rule that requires
  `await` on `*Async` symbols.

### 2. Non-null assertion masking a real null branch

A helper documents "returns null on malformed input" but the caller
uses `!` to feed the value into a downstream record. Today the null
branch is unreachable; tomorrow a relaxation makes it reachable and
the `!` crashes the failure path.

- Real example: `electron/wake/channels.ts:272` (`address!` in the
  failure-record queue)
- Detect with: ESLint `no-non-null-assertion` (default off — flip on
  for new modules); prefer explicit `if (!x) return / log` over `!`.

### 3. Import path that "looks right" but resolves to the wrong barrel

A test imports a symbol from a barrel module (e.g.
`../../db/core/stores`) that re-exports a subset of stores. tsc
reports `TS2305` — but only when the file is in the typecheck pipeline.

- Real example: `electron/agents/__tests__/session-spawn.e2e.test.ts:22`
  (`SessionStore` from `stores.ts`, which only owns TaskStore / etc.)
- Detect with: verify `tsconfig.json` `include` covers the test file.

### 4. Private field reached into from a test

A test reaches into a `private` member via plain dot-access. Vitest is
happy at runtime; tsc flags it but most repos don't typecheck test
files.

- Real example: `electron/agents/process-pool/agent-process-pool.test.ts:82`
  (`pool.router.broadcast`)
- Detect with: always run `tsc` over `__tests__` and `*.test.ts`;
  use the `as unknown as { field: T }` narrowing pattern instead of
  widening the public API.

### 5. Silent fall-through when an optional API is missing

A user-facing write path is gated by `if (api?.method) { ... }` with
no `else`. If the API is absent, the function resolves normally and
the caller thinks the save landed.

- Real example: `src/hooks/useSettings.ts:343` (mcpServers save)
- Detect with: every `if (api?.x)` write-path should pair with
  `else throw new Error(...)`; smoke-test the renderer with the API
  stubbed to omit the method.

### 6. Misleading `reachable` field on a transport timeout

A health-check helper returns `{ reachable: true, error: 'timeout' }`
when the request did not get an authoritative response. The caller
gates downstream probes on `!reachable`, so a slow-but-alive server
turns one timeout into N sequential timeouts.

- Real example: `packages/cli/src/api/client.ts:217` (`probe()`)
- Detect with: naming — `reachable` should be true only when an
  authoritative HTTP response came back; assert total runtime stays
  bounded in a "doctor under load" integration test.

### 7. Inclusive range that accepts a sentinel value

A validation check uses `0 <= x <= MAX` when the underlying contract
requires `1 <= x <= MAX` (or similar). The sentinel value sneaks
through and surfaces as a confusing downstream error.

- Real example: `packages/cli/src/api/runtime-config.ts:226` (port 0)
- Detect with: use protocol constants (`MIN_PORT`, `MAX_PORT`); fuzz
  validators with boundary values (`-1`, `0`, `1`, `MAX-1`, `MAX`, `MAX+1`).

### 8. Fractional-cell formula that always clamps to 1

A fractional-remainder calculation (`x - Math.floor(x - 1)` instead of
`x - Math.floor(x)`) always returns ≥ 1 for integer inputs, so the
visual "partial cell" indicator is always full.

- Real example: `src/lib/context-usage-utils.ts:504` (context grid)
- Detect with: a test that asserts the last cell is < 1 when tokens /
  squares has a fractional part; visual regression snapshots.

### 9. Regex that handles only one wire shape

A prefix-stripping regex assumes one format but the producer sometimes
emits a more verbose format. The parser partially matches, leaves a
dangling prefix, and the rest of the unwrap path silently fails.

- Real example: `src/lib/stream-session-manager.ts:825` (`429 ` vs.
  `HTTP 429 `)
- Detect with: test the unwrap against every observed wire shape
  (raw, HTTP-prefixed, bracketed, JSON-wrapped); capture provider
  `error.message` into a golden file.

### 10. Token-usage aggregator double-counts cache reads

A cache-aware token counter adds `cache_hit_tokens` to the running
"input" total on every call. On cache-exclusive providers the cached
prefix is re-reported every turn, so the session total inflates by
N× across N fully-cached rounds. The "only-new" volume should be
`input + cache_creation`; `cache_hit` is a re-read and must never
accumulate.

- Real example: `packages/agent/src/process/seed-token-usage.ts` +
  `src/hooks/useContextUsage.ts`
- Detect with: a regression test that constructs N fully-cached round
  trips and asserts the session total is `N × input + cache_creation`,
  not `N × (input + cache_hit + cache_creation)`.

## Review checklist

When reviewing a new diff, run through this list:

1. **Async propagation.** Every async helper has an `await` at every
   call site? If not, is there a deliberate `void`?
2. **Non-null assertions.** Every `!` papers over a real null branch?
   Prefer `if (!x) return` or `if (!x) log + skip`.
3. **Optional API gates.** Every `if (api?.method) { ... }` write
   path has an `else throw`?
4. **Validation ranges.** Boundary values (0, -1, MAX, MAX+1) all
   rejected where they should be?
5. **Fractional math.** `x - Math.floor(x - 1)` look weird? Should be
   `x - Math.floor(x)`.
6. **Wire-shape regexes.** Tested against every observed wire format?
7. **Cache accounting.** Anything accumulating `cache_hit` is a
   suspect — only-new volume is `input + cache_creation`.
8. **Public/private surface in tests.** Test accesses of private
   fields use `as unknown as { field: T }` narrowing, not widened
   production APIs.
9. **Misleading success signals.** A function that returns success
   when nothing happened is worse than one that throws.
10. **tsc coverage.** Test files are part of the typecheck pipeline,
    not just the runtime test runner.

