# Duya MCP Capability Audit

> **Scope.** What Model Context Protocol surface Duya actually implements,
> what it merely *remembers* it negotiated, and what is silently dropped.
> Every claim below is backed either by a `file:line` citation or by an
> automated test in this repo — not by inference.
>
> **Baseline.** `origin/master` @ `802df97c`, audited 2026-10-01.
> **Headline.** Duya implements the **tools plane** thoroughly and
> correctly. Every other MCP plane — resources, prompts, notifications,
> logging, progress — is **absent or decorative**. One P0 made the entire
> remote-MCP (App Connection) chain non-functional at runtime.

---

## 0. TL;DR

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| P0-1 | `RemoteSession.ledger` never declared/instantiated → **every remote-MCP connection throws on discovery** | **Critical** | **Fixed** |
| P0-2 | `degraded` transport status dropped at ingest → dead server invisible in UI, Reconnect button hidden | **High** | **Fixed** |
| P0-3 | `resources/list` returned **page one only**, silently | **High** | **Fixed** |
| P0-4 | `resources/read`, `prompts/list`, `prompts/get` had **no client API at all** | **High** | Partially fixed (client layer) |
| P0-5 | Boot restore + silent reconnect call a `private` method with a wrong signature — compile-broken | **High** | Reported, not fixed |
| P1-1 | Electron main process is **outside every typecheck gate** (897 errors) | **High** | Reported, not fixed |
| P1-2 | Connector error codes flattened to `provider_error`; the `MCP_*` taxonomy never reaches the agent | Medium | Reported |
| P1-3 | Resource/prompt notifications were dropped by the SDK (no handler) | Medium | **Fixed** (counted + logged) |
| P2-x | Inventory ledger / `inventoryRevision` never reach the renderer; `mcpTools` IPC is a stub | Low | Reported |

---

## 1. The two chains

Duya has **two independent MCP client stacks**. Any capability claim must
name a chain; they do not share an implementation (only the protocol-pure
primitives in `@duya/plugin-core/src/mcp/core/`).

| | **Chain A — direct MCP** | **Chain B — remote MCP** |
|---|---|---|
| Lives in | `packages/agent/src/mcp/index.ts` (worker) | `electron/services/app-connections/connectors/remote-mcp.ts` (main) |
| Entry | `MCPManager` / `MCPClient` | `RemoteMcpConnector` |
| Transport | stdio **and** streamable-HTTP (`index.ts:301-329`) | streamable-HTTP only (`remote-mcp.ts:360`) |
| Auth | env allowlist only (`security.ts`) | **OAuth 2.0 + PKCE** via the MCP SDK |
| Config source | user TOML, plugins, bundled | App Connections registry |
| Tool identity | `mcp__<server>__<tool>` (`index.ts:782`) | `remote_<provider>_<slug>_<tool>` (`alias.ts`) |
| Executed in | Agent worker process | Electron main; agent calls via `appConnection:invoke` |

Both chains share these primitives from `packages/plugin-core/src/mcp/core/`:
`listAllTools`, `createDeadlineClock`, `classifyMcpError`,
`allocateConnectionToolAlias`.

---

## 2. Capability matrix

Legend — **Y** implemented & tested · **P** partial · **D** declared but
decorative (captured, never acted on) · **—** absent

| MCP capability | Chain A | Chain B | Evidence / gap |
|---|:--:|:--:|---|
| `initialize` | Y | Y | `index.ts:367-371`, `remote-mcp.ts:383` |
| Capability negotiation — capture | Y | Y | `index.ts:373-381`, `remote-mcp.ts:390-397` |
| Capability negotiation — **act on** non-tool caps | P → **D** | D | **P0-4**: captured, never consumed |
| `tools/list` (paginated) | **Y** | **Y** | `listAllTools` + `paginateCursor`; 12 unit tests + conformance L1–L4 |
| `tools/call` | **Y** | **Y** | `index.ts:457-567`, `remote-mcp.ts:162-217` |
| Tool result blocks / `structuredContent` | Y | Y | `result-blocks.ts`; `index.ts:516-530` |
| `resources/list` | P → **Y** | — | **P0-3 fixed**: was page-one-only |
| `resources/read` | — → **Y** | — | **P0-4**: client API added |
| Resource templates (`resources/templates/list`) | — | — | absent |
| `resources/subscribe` / `updated` | — | — | absent (server advertises it; ignored) |
| `prompts/list` | — | — | **absent** — no client API, no test |
| `prompts/get` | — | — | **absent** |
| `notifications/tools/list_changed` | **Y** | **Y** | 500 ms debounce → transactional rediscovery |
| `notifications/resources/list_changed` | — → **P** | — | **P1-3 fixed**: now counted + logged |
| `notifications/prompts/list_changed` | — → **P** | — | **P1-3 fixed** |
| `notifications/progress` | — | — | absent; **no `progressToken` is ever sent** |
| `notifications/message` (logging) | — | — | absent, though `logging: {}` is advertised |
| `completion/complete` | — | — | absent |
| Client caps: `roots` | — | — | `capabilities: {}` on both chains |
| Client caps: `sampling` | — | — | `capabilities: {}` |
| Client caps: `elicitation` | — | — | re-auth is a synthesized error, not a real elicitation |

### 2.1 The "declared but decorative" problem

Duya **does** negotiate the full capability set — the probe recorded:

```
PROBE serverCapabilities = {"logging":{},"prompts":{"listChanged":true},
  "resources":{"subscribe":false,"listChanged":true},"tools":{"listChanged":true}}
```

Duya stores this (`MCPClient.getServerCapabilities()`), writes it to the
inventory ledger, and then **acts on none of it except `tools`**. A server
that advertises resources, prompts and logging gets exactly the same
treatment as one that advertises nothing. This is the single biggest gap
between "protocol support" and "usable capability" in the codebase.

---

## 3. The P0 findings

### P0-1 — Remote MCP (chain B) is dead on arrival · **Critical** · Fixed

`RemoteMcpConnector` read `session.ledger` in three places but the
`RemoteSession` interface never declared the field, and `InventoryLedger`
was imported but never instantiated.

```
electron/services/app-connections/connectors/remote-mcp.ts(244,45): error TS2339: Property 'ledger' does not exist on type 'RemoteSession'.
electron/services/app-connections/connectors/remote-mcp.ts(317,13): error TS2339: Property 'ledger' does not exist on type 'RemoteSession'.
electron/services/app-connections/connectors/remote-mcp.ts(411,17): error TS2339: Property 'ledger' does not exist on type 'RemoteSession'.
```

Line 317 is inside `discoverNow`, which every `ensureSession` calls. So
`session.ledger.commitDiscovery(...)` raised `TypeError: Cannot read
properties of undefined`, `ensureSession`'s catch tore down the client and
transport, and **every remote-MCP connection failed** — not just the
diagnostics path.

**Why it shipped:** see [§6](#6-cross-cutting-the-electron-process-is-not-gated).
**Fix:** declared `ledger: InventoryLedger` on `RemoteSession` and
instantiated it in `ensureSession`. `remote-mcp.ts` is now type-clean.

### P0-2 — `degraded` never reached the UI · High · Fixed

The agent transitions to `degraded` when a transport dies under a live
client (`index.ts:212-217`), and `MCPConnectionStatus` includes it
(`packages/agent/src/types.ts:620`). Then:

1. `setLastMCpStatusSnapshot` dropped the **entire server entry** because
   `degraded` failed its allowlist check — `mcp-runtime-store.ts:75-82`
2. `resolveMcpStatusFields` found no live entry and fell through to
   `lastIssue` or `'unknown'` — `cross-source.ts:348-365`
3. Neither renderer union contained `degraded` at all
   — `capability-management-types.ts:66-71`, `MCPSection.tsx:122`
4. `showReconnect` required `error | disconnected` — `MCPSection.tsx:672`

**User-visible result:** kill an MCP server's transport and the settings
page shows "Unknown", no error styling, and **no Reconnect button**. The
one state the architecture document calls out as lifecycle truth
(`ARCHITECTURE.md:423`) was the one state the UI could not represent.

**Fix:** accept `degraded` at ingest; map it to a distinct renderer status
(amber "Degraded — transport lost", deliberately not red — the
last-known tool inventory is still intact); surface the Reconnect
affordance; widen all four renderer unions.

### P0-3 — `resources/list` silently returned page one · High · Fixed

The old `MCPClient.listResources()` called `this.client.listResources()`
once and returned that page, with a comment deferring pagination "when an
MCP server actually returns more resources than fit in one page in
practice". Servers paginate by default, so this hid everything past the
first page with no error and no truncation marker.

Proven against a real server (3 resources, page size 2):

```
before: PROBE listResources() = ["file:///a.txt","file:///b.txt"]   (2 of 3)
after:  PROBE listResources() = ["file:///a.txt","file:///b.txt","file:///c.txt"]  (3 of 3)
```

**Fix:** extracted the cursor loop out of `listAllTools` into a shared,
protocol-pure `paginateCursor` primitive
(`packages/plugin-core/src/mcp/core/paginate.ts`) and built
`listAllResources` on it. `listAllTools` now delegates to the same
primitive, so the two cursors cannot drift again — and `resources/list`
inherits the full guard set: one deadline per pass, cursor-ring detection,
cross-page duplicate-URI detection, page/item caps, and a throw (never a
partial list) on mid-pagination failure.

### P0-4 — Resources/prompts had no client API · High · Partially fixed

`resources/read`, `prompts/list` and `prompts/get` did not exist anywhere
in the repository. `listResources()` was the only entry point and it was
**dead code** — the `ListMcpResourcesTool` / `ReadMcpResourceTool` that
once called it were removed in `be766fde` as part of a generic
"remove unused tools" cleanup, not as an MCP design decision.

**Fixed at the client layer:** `MCPClient.readResource(uri)`,
`supportsResources()`, `supportsPrompts()`, and capability gating so a
server without the capability is never sent a pointless round-trip
(a JSON-RPC `Method not found` costs a full request).

**Still open — see [§5](#5-what-is-still-not-usable).** The model cannot
reach any of this yet. Re-exposing it is a product decision, not a
protocol fix, so it is deliberately *not* done here.

### P1-3 — Non-tool notifications were dropped · Medium · Fixed

With no handler registered, the SDK discards notifications. A server
adding or removing a resource produced no observable effect whatsoever.
Chain A now subscribes to `resources/list_changed` and
`prompts/list_changed`, counts them (`getCapabilityChangeCount()`), and
logs them — explicitly **without** triggering a tool rediscovery, which
would be wrong.

---

## 4. What is genuinely strong

Credit where due — the tools plane is built to a high standard and the
audit found no defect in it:

- **Transactional discovery.** A failed pass never clears the last-known
  inventory (D6). Covered by conformance L4 and L9.
- **Pagination hardening.** Cursor-ring detection, cross-page duplicate
  detection, page/item caps, truncation marked `stale` rather than
  `complete`.
- **One deadline per request**, passed to the SDK as
  `{ timeout, signal }`. A single timed-out call never closes a transport
  that is serving parallel calls.
- **Two-level circuit breaking.** Connection-level and tool-scoped, with
  a three-way error taxonomy (`connection` / `tool-scoped` / `ignore`) so
  a slow tool cannot fuse a whole server. Covered by
  `breaker-decoupling.test.ts`.
- **Security layers.** Env allowlisting for spawned servers, secret
  redaction on error paths, prompt-injection scanning of tool
  descriptions.
- **Late-commit guards.** A superseded discovery loses to a newer
  generation.

---

## 5. What is still not usable

Honest accounting of what the fixes in this change did **not** deliver:

1. **The model still cannot read resources or prompts.** P0-4 added the
   client protocol layer; exposing it to the model (a tool, a catalog
   entry, a slash command) is a product decision. The tools were retired
   in a blanket cleanup, and re-adding them is a scope call for the
   owner, not an audit finding to unilaterally resolve.
2. **Prompts remain entirely unimplemented.** `prompts/list` and
   `prompts/get` have no client API, no tests and no UI. `prompts/list`
   is mechanically identical to `tools/list` and could reuse
   `paginateCursor` the moment there is a consumer.
3. **No progress or logging notifications.** No `progressToken` is ever
   sent, so servers cannot report progress and Duya cannot render it.
4. **Chain B still has no auto-reconnect** (explicit design decision,
   `remote-mcp.ts:385-386`), and its two recovery entry points are
   compile-broken (P0-5).
5. **`degraded` is now visible, but there is still no automatic recovery**
   from it — the user must press Reconnect.
6. **P0-5 is not fixed.** `app-connection-service.ts:476,561` call
   `RemoteMcpConnector.ensureSession`, which is `private` and takes
   `(connectionId, provider: ProviderId, token)`:
   ```
   app-connection-service.ts(476,28): error TS2341: Property 'ensureSession' is private and only accessible within class 'RemoteMcpConnector'.
   app-connection-service.ts(476,53): error TS2345: ... not assignable to parameter of type 'AppConnectorId'.
   app-connection-service.ts(561,32): error TS2341: Property 'ensureSession' is private ...
   app-connection-service.ts(561,55): error TS2345: ... not assignable to parameter of type 'AppConnectorId'.
   ```
   Boot restore and silent reconnect are dead code. Fixing it requires
   designing a public session-rehydration API — a real design task, out of
   scope for a high-certainty P0 pass, and left for the owner.

---

## 6. Cross-cutting: the Electron process is not gated

**This is the root cause of P0-1 and P0-5, and it is the most important
structural finding in the audit.**

- The root `tsconfig.json` **explicitly excludes** `electron/**`.
- An `electron/tsconfig.json` exists — but **no npm script references it**.
  `typecheck:all` runs `typecheck:web` (root tsc, electron excluded) plus
  `typecheck:agent` / `cli` / `conductor` / `voice`.
- `tsc -p electron/tsconfig.json --noEmit` reports **898 errors** on a clean
  `origin/master` (measured with `packages/agent/dist` built, otherwise
  ~30 further errors stay hidden behind an unresolved `@duya/agent`).

So an entire process — the one that owns OAuth, the Remote MCP connector,
the capability aggregator and the IPC surface — ships with **zero**
compiler enforcement. That is exactly how a one-line omission
(`ledger`) and two `private`-access violations reached `master` while CI
stayed green.

**Recommendation (not done here — it is a 900-error project):** add
`typecheck:electron`, land it as `|| true` or scoped to
`services/app-connections/**` first, and ratchet the count down. Until
then, treat "the build is green" as meaningless for `electron/`.

---

## 7. Verification

All MCP-adjacent suites, after these changes:

```bash
npx vitest run packages/plugin-core packages/agent/src/mcp \
  packages/agent/tests/mcp \
  packages/agent/tests/integration/mcp-conformance.test.ts \
  packages/agent/tests/integration/mcp-capability-conformance.test.ts \
  electron/services/capability-management electron/agents/mcp \
  electron/ipc/__tests__/mcp-handlers.test.ts \
  src/lib/mcp-inventory-ipc.test.ts src/components/chat/SlashCommandPopover.test.tsx \
  packages/agent/tests/unit/tool/builtin-surface.test.ts

# Test Files  1 failed | 38 passed (39)
#      Tests  1 failed | 505 passed (506)
```

The single failure is
`packages/plugin-core/tests/app-schema-marketplace-compat.test.ts`
(marketplace `.app.json` parsing), **verified pre-existing** by re-running
it on a stashed clean tree.

`packages/agent/tests/integration/RealTasks.test.ts` (13 failures) is also
pre-existing and environmental — it needs a real LLM model and API key.
Verified the same way on a clean tree.

Typecheck:

| Project | Before | After |
|---|---|---|
| `electron/tsconfig.json` | 898 errors | **894** errors, **0 new** |
| root `tsc --noEmit` (web/renderer) | 0 | **0** |
| `packages/agent` `tsc --noEmit` | 0 | **0** |
| `npm run -w @duya/agent build` | ok | **ok** |

The 4 errors the change removes are exactly the chain-B ones cited in
[P0-1](#p0-1--remote-mcp-chain-b-is-dead-on-arrival--critical--fixed)
(three `TS2339` on `RemoteSession.ledger`, one `TS2749` on `LogComponent`).

> Measurement note: the `electron` baseline is only meaningful once
> `packages/agent/dist` exists, otherwise `@duya/agent` fails to resolve and
> ~30 unrelated errors stay hidden. Both sides of the comparison above are
> taken with `dist` built.

Note that the `electron` project is the only one that moved: it is the
only one not currently gated (see §6), which is precisely why it was the
only one able to regress.

### New and extended tests

| File | Covers |
|---|---|
| `packages/agent/tests/integration/mcp-capability-conformance.test.ts` | **new** — R1 pagination, R2 cursor ring, R3 `resources/read`, R4 capability gating, R5 notification handling, C1 tools-plane regression, C2 capability capture |
| `packages/plugin-core/tests/mcp/core/list-resources.test.ts` | **new** — 13 cases mirroring the `listAllTools` defensive matrix |
| `electron/services/capability-management/__tests__/mcp-runtime-store.test.ts` | **extended** — `degraded` survives ingest; invalid statuses still rejected |

The data-plane suite drives the **real** `MCPClient` against a **real** MCP
SDK server over `InMemoryTransport`, injected through the `buildTransport`
seam the production class already exposes for exactly this purpose
(`index.ts:294-300`). No mocking of the client, no subprocess.

---

## 8. Recommendations, in order

1. **Gate `electron/`.** Highest leverage — it is the only fix that
   prevents the next P0-1 from shipping. Start non-blocking.
2. **Fix P0-5** (`ensureSession` public rehydration API) — it is what
   makes boot restore and silent reconnect actually work.
3. **Decide the resources/prompts product question.** The protocol layer
   now exists; the only thing missing is a decision about whether the
   model should see it. If yes, `prompts/list` is ~30 lines on top of
   `paginateCursor`.
4. **Send `progressToken`** on long-running tool calls and surface
   `notifications/progress` — the single highest perceived-quality win for
   slow MCP tools.
5. **Stop flattening connector errors.** `connector-service.ts:475-481`
   collapses everything to `provider_error`; the `MCP_*` taxonomy in
   `error-taxonomy.ts` already exists and is simply not applied.
6. **Surface the inventory ledger.** `inventoryRevision`,
   `discoveryStatus` and truncation are computed in both chains and thrown
   away before reaching the renderer.
