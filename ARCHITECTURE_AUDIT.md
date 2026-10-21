# Architecture Audit

> Audited at commit `e1bc1650` (duya) and `9522711` (duya-website), 2026-10-01.
> Method: 5 parallel domain audits, cross-checked by the lead auditor. Raw reports: see "Provenance".
> Code references are `path:line` relative to the clean detached-HEAD worktree `.claude/worktrees/audit-head`, except
> website findings, which are relative to the separate repo `E:/Projects/duya-website`.

---

## 1. Verdict

This is a codebase whose *local* discipline is good and whose *global* contracts are unverified. Individual modules
are well factored, security-sensitive helpers are well written, i18n parity is exact, the git-review bridge honours its
read-only contract, and the memory vault encryption is sound. What it does not have is anything that checks the seams:
channel names, wire DTOs, permission gates and trust models are hand-maintained in two or three places, and a mistake at
any of those seams ships silently because esbuild does not typecheck and no gate runs the typechecker on that path. The
result is concrete, not theoretical: **an unrestricted local-file-read primitive reachable from model output, a
remote-MCP connect path that throws on every call at HEAD, four fully implemented user features that are unreachable
because a channel name lost a `db:` prefix, and a plugin trust model that computes capabilities nobody enforces.**

| Severity | Source findings | After dedup | Net change |
| --- | --- | --- | --- |
| P0 | 9 | **4** | −3 demoted to P1, −2 pair-merges |
| P1 | 34 | **34** | +3 demoted in, −4 absorbed merges |
| P2 | 57 | **54** | −3 absorbed |
| P3 | 17 | **15** | −1 absorbed, −1 reclassified as a verified-clean negative |
| **Total** | **117** | **107 defects** | 8 cross-domain merges, 1 reclassification |

Four distinct systemic root causes (§2). After dedup, **108** issues remain if the one reclassified negative
(`SITE-003`, an explicit "verified clean") is counted with the corpus rather than against it.

---

## 2. Systemic root causes

### RC-1 — A contract with no single source of truth, and nothing that verifies it

**What it is.** The renderer↔main contract is two hand-maintained lists of channel-name strings, plus a third
hand-copy of the payload types. The agent↔main `db:*` DTO is declared on both sides. The website is a fourth copy of
the version truth. None of these are generated, and nothing asserts they agree.

**Evidence that it is systemic** (three domains, independent):
- 40 of ~440 registered IPC channels are broken: 12 exposed via `contextBridge` with no handler, 28 registered with
  zero consumers in the entire repository — `electron/preload.ts:2033`, `electron/ipc/db-handlers.ts:478`,
  `electron/agents/agent-communicator.ts:131`. Four *fully implemented* features are unreachable because the
  registration and the invocation disagree on a `db:` prefix alone: handler `session:unarchive` at
  `electron/ipc/db-handlers.ts:605` vs invocation `db:session:unarchive` at `electron/preload.ts:2298`.
- The Git wire contract is declared **three** times: canonical at `electron/ipc/git-types.ts:27`, re-imported by
  `electron/preload.ts:19-32`, and hand-copied at `src/lib/git-ipc.ts:9-97` — under a comment
  (`src/lib/git-ipc.ts:3-7`) justifying the copy by a mechanism that no longer exists, since `src/global.d.ts:3`
  already imports `ElectronAPI` from `../electron/preload`.
- The agent child and main both declare the `db:*` DTO: `packages/agent/src/ipc/db-client.ts:47-52` (emitted, with
  `payload: unknown` and no validation) against `electron/agents/db-bridge.ts` (consumed). Across the repository the
  counter-example — one genuinely shared DTO — exists too: `@duya/agent/message`, imported by both
  `electron/db/core/message-log.ts:33` and `electron/ipc/db-handlers.ts:152`.

**Why it got this way.** Each contract was added at the speed of one feature. There was never a codegen step or a
contract test, so the drift is invisible to every existing gate. `AGENTS.md` describes a "bridge contract" that is in
practice a convention reviewed by reading a 3061-line file (`electron/preload.ts`).

### RC-2 — Nothing that can be checked automatically is checked

**What it is.** The build bundles with esbuild, which does not typecheck. `AGENTS.md` states the rule — "esbuild does
NOT type check. Always run `npm run typecheck:all` before committing" — but the rule is not enforced by CI or by a
pre-commit hook, so whole classes of defect reach HEAD as runtime `TypeError`s.

**Evidence that it is systemic** (three domains, independent):
- A shipped P0 is a pure type error: `RemoteSession` (`electron/services/app-connections/connectors/remote-mcp.ts:65-82`)
  declares no `ledger` member, yet `session.ledger.getSnapshot()`/`commitDiscovery()`/`hydrateFromCache()` are
  dereferenced at `:244`, `:317` and `:411`. TS2339; a runtime `TypeError` on every discovery.
- A second shipped break in the same file is TS2341/TS2554: `ensureSession` is `private`
  (`electron/services/app-connections/connectors/remote-mcp.ts:350`) and takes `(connectionId, provider, token)`, but
  is called as `ensureSession(target.id, config, scopes)` at
  `electron/services/app-connections/app-connection-service.ts:476` and `ensureSession(conn.id, provider, conn.scopes)`
  at `:561`. The tests pass because the double declares a *public* method
  (`electron/services/app-connections/__tests__/app-connection-service.test.ts:92`), so the real visibility and
  signature are never checked.
- The website repo has no test script and zero test files — `package.json:5-13` defines no `test` — which is how a
  17-entry redirect table in `vercel.json:12` shipped pointing at 17 slugs that do not exist
  (`lib/docs.ts:41` requires `/^([0-9]+-[a-z0-9-]+)\.([a-z]{2})\.md$/`).
- Disabling the checker is a live pattern: `@ts-nocheck` sits on four shipped Feishu adapter files, the largest
  758 lines (`packages/gateway/src/adapters/feishu/comment-handler.ts:1`).

**Why it got this way.** Typechecking is a locally-run, human-disciplined step. It has no CI job, so its absence is
invisible until a user hits the code path.

### RC-3 — Trust and permission models are declared in one layer and enforced in another, or nowhere

**What it is.** The codebase contains several explicit, well-specified policy models. In three independent domains,
the model is computed and displayed but never consulted at the point where the decision matters.

**Evidence that it is systemic** (three domains, independent):
- Plugin trust: `TRUST_LEVEL_CAPABILITIES` (`packages/plugin-core/src/security/trust-engine.ts:25-58`) has exactly one
  non-test consumer in the whole repository, and that consumer is
  `electron/ipc/plugin-handlers.ts:630` returning `{ trust, capabilities }` to the UI. `determineTrustLevel`
  (`trust-engine.ts:61-86`) awards `Verified` from the string `source === 'marketplace'`, and no signature
  verification exists anywhere in the plugin path. A UI that renders a security posture the runtime does not enforce
  is worse than no model.
- App-provider kill switch: the `[apps]` gate is checked in exactly one place, descriptor listing
  (`electron/services/app-connections/connector-service.ts:234`), never in `invoke` (`:353-520`) — and the setter
  (`electron/services/app-connections/policy-gate.ts:71`) has no IPC and no UI, so the gate is unreachable in practice.
- Plan-mode write barrier: `gateWriteTool` gates `edit`/`write`/`bash`/`powershell`/`module`
  (`packages/agent/src/modes/engine/coordinator.ts:120`) inside `canUseTool`
  (`packages/agent/src/agent/PermissionsGate.ts:187`) — but the `tool_invoke` dispatcher calls the raw policy engine at
  `packages/agent/src/agent/DuyaAgent.ts:1361`, skipping the gate entirely, under a comment at `:1339-1343` claiming the
  opposite.
- Same shape, main process: no `ipcMain.handle` anywhere validates its sender. The `_event` parameter across all 45
  registering files is either unused or read only to *identify* the sender, never to authorise it — representative:
  `electron/ipc/system-handlers.ts:48`, and `electron/ipc/system-handlers.ts:414-422`, which excludes the sender window
  from a broadcast and is easy to misread as an authorisation check.

**Why it got this way.** Each policy was introduced as a model plus a display surface, and the enforcement call site
was treated as follow-up work. The models are good; the wiring is missing.

### RC-4 — A security-relevant primitive exists in two copies, and the weaker copy is the one on the deciding path

**What it is.** Where a check has to cross a package or process boundary, it was copied rather than shared, and the
copies drift. This is not generic duplication: in every instance the deciding layer got the weaker version.

**Evidence that it is systemic** (three domains, independent):
- Command normalisation for security detection: the real implementation at
  `packages/agent/src/permissions/policy.ts:477` strips ANSI CSI/DEC/OSC escapes, NUL, NFKC and zero-width. The two
  copies — `packages/agent/src/tool/PowerShellTool/security.ts:92` and `packages/agent/src/utils/shell/intelligence.ts:47`
  — are byte-identical to each other and strip **only** `\x00` + NFKC + zero-width. The PowerShell gate is the one
  that decides `requiresApproval`, and it runs the weaker normaliser.
- Workspace containment: `packages/agent/src/tool/allowedRoots.ts:37` is the strong implementation (`realpathSync` on
  the root, `path.relative` so cross-drive escapes are rejected, re-check of the target's realpath to catch symlinks).
  `packages/agent/src/permissions/policy.ts:1047` is a separate, weaker regex scraper
  (`input.command.match(/cd\s+["']?([^"';\s]+)/)` at `:1066`) that drives the workspace auto-allow.
- Theme state: `src/hooks/useTheme.ts:3` (object return, `localStorage` first, observes all attributes) versus the
  private copy at `src/components/chat/WidgetRenderer.tsx:40` (bare-string return, `data-theme` only, filtered
  observer). The two can disagree mid-transition, and `WidgetRenderer` is the place that *pushes* theme to an iframe
  (`WidgetRenderer.tsx:317`).
- Cross-repo, same theme: `app/theme-provider.tsx:35` mirrors the resolved theme onto `data-theme`, while
  `components/ui/theme-provider.tsx:1` is a bare `NextThemesProvider` with no sync, and the two filenames collide
  case-insensitively.

**Why it got this way.** The abstraction is not shared across the boundary, so a copy is the path of least resistance
at every new call site.

---

## 3. Critical findings (P0)

Nine findings were filed as P0 across five domains. After merging, severity adjustment, and confidence review, four
survive. Each is one I am prepared to defend.

### P0-1 — Model-authored markdown triggers an unrestricted local file read via `duya-file:`

*Source: `MAIN-001` (main/memory) ≡ `RENDER-001` (renderer) — found independently by two auditors.*

**What breaks.** Any model-authored markdown media path becomes a `duya-file://` URL, and the main process serves it
with `fs.promises.readFile` and no root confinement. A model that emits
`![x](duya-file:///C:/Users/<u>/.config/duya/secrets.json)` gets the file bytes rendered into the transcript.

**The path, in order.**
1. `src/components/chat/MarkdownRenderer.tsx:236` — `PRESERVED_URL_RE = /^(?:duya-file:|blob:|data:image\/)/i` and
   `preserveLocalUrlTransform` (`:247-249`) deliberately bypass `react-markdown`'s `defaultUrlTransform` for
   `duya-file:`. The `javascript:` stripping still applies to everything else (`:264`).
2. `src/components/chat/markdownComponents.tsx:76-118` — `rewriteMediaSrc` **manufactures** the URL. Any
   model-written Windows-absolute path becomes `duya-file:///${src}` (`:81`, `:111`); any Unix-absolute path becomes
   `duya-file://${src}` (`:115`); any `file://` src is remapped (`:96-98`). The doc comment at `:70-73` states the
   cause plainly: "the finalAnswer prompt teaches the LLM to reference absolute paths with a `/abs/path` placeholder
   prefix."
3. `electron/main.ts:786-836` — the handler does drive-letter recovery (`:797-809`) and separator normalisation
   (`:810`), then `const data = await fs.promises.readFile(filePath);` at `:812`. There is **no allowlist anywhere in
   the handler**; the `catch` at `:833` only returns 404. The MIME table includes `.txt` and `.md` (`:824-825`), so the
   response is not limited to images.
4. `electron/main.ts:135-145` registers the scheme `standard: true, secure: true, supportFetchAPI: true, stream: true`.
   `secure` exempts it from the mixed-content and trustworthy-origin rules; `supportFetchAPI` means any renderer script
   can read the response as a normal body.
5. No main-window CSP exists: a repo-wide grep for `Content-Security-Policy` returns only `src/orb/index.html:5` and
   the conductor sandbox — never the main window.

**Aggravating factor.** The response is `Cache-Control: public, max-age=3600` (`electron/main.ts:831`), so the bytes
persist in the HTTP cache. LLM output is attacker-influenceable via any fetched page, MCP tool result, or file the
agent reads, and the model can be instructed to read a secret and print it back.

**Fix.** (a) In the main handler, `path.resolve` the target and reject unless it sits under an explicit root
allowlist — the active session working directory, `app.getPath('userData')`, `~/.duya`, conductor assets,
`resources/public`; return 403 otherwise. (b) Drop `supportFetchAPI` from the registration at
`electron/main.ts:139-142`. (c) Add a main-window CSP naming only those roots in `img-src`/`media-src`. (d) In the
renderer, remove `duya-file:` from `PRESERVED_URL_RE` and re-derive `duya-file://` URLs only from main-supplied
attachment metadata. Both layers matter: (d) is the thing that lets model text reach the protocol at all.

**Effort:** M.

### P0-2 — The remote-MCP connect path throws at HEAD (two independent type errors)

*Source: `CONN-001` + `CONN-002` (connectors) — one merged issue; `CONN-002` independently confirmed by the lead
auditor. The merge is justified because both defects are in the same method, both are type errors esbuild shipped, and
both make the connect path a no-op.*

**What breaks.** Remote MCP never establishes a session at all. `ensureSession` rejects, and every *initial connect*
fails fatally rather than degrading to the intended "keep last-known inventory and mark failed" behaviour.

**The path.**
1. `electron/services/app-connections/connectors/remote-mcp.ts:65-82` — the `RemoteSession` interface declares
   `inventoryRevision`, `discoveryStatus`, `pagesFetched`, `discoveredTotal`, `rediscoveryGeneration`, `listChangedTimer`
   flattened onto the session, and **no `ledger` member**. The object literal built at `:369-381` assigns no `ledger`.
2. `remote-mcp.ts:244` `?.ledger.getSnapshot()`, `:317` `session.ledger.commitDiscovery({...})`, `:411`
   `session.ledger.hydrateFromCache(...)` — three dereferences of an undeclared field. TS2339; `TypeError: Cannot read
   properties of undefined` on the normal discovery path. The agent-side equivalent does it correctly at
   `packages/agent/src/mcp/index.ts:92` (`private readonly ledger = new InventoryLedger()`).
3. Independently, `remote-mcp.ts:350` declares
   `private async ensureSession(connectionId, provider, token: {accessToken, tokenType})`, but
   `electron/services/app-connections/app-connection-service.ts:476` calls `ensureSession(target.id, config, scopes)`
   and `:561` calls `ensureSession(conn.id, provider, conn.scopes)`. `config` is a `ProviderClientConfig` where a
   `ProviderId` is expected; `scopes` is `string[]` where a token object is expected. TS2341 + TS2554.
4. The mismatch is *silently* non-fatal at runtime: `getProviderConfig(configObject)` returns `undefined`, the
   `if (!config?.remoteMcpUrl) throw` at `remote-mcp.ts:358` fires, and the callers swallow it —
   `trySilentReconnectRemoteMcp` returns `null` (`:488-500`), dropping the user into the browser OAuth flow the feature
   exists to skip; boot rehydrate logs a WARN per row and leaves the row in `error`
   (`app-connection-service.ts:570`).
5. The tests cannot catch this: they mock a connector with a **public** `ensureSession`
   (`electron/services/app-connections/__tests__/app-connection-service.test.ts:92`), so neither the real visibility nor
   the real signature is exercised.

**Consequence for exec-plan 580.** This is the most likely mechanism behind 580's unreproducible
`pages=N, total=M` under-report: discovery throws before totals are recorded, so a run that never completed discovery
reports a partial pair. This is the aggregator's best explanation; it is not proven — see §7.

**Fix.** (a) Add `ledger: InventoryLedger` to the interface and initialise it in the literal at `:369-381`; call
`beginDiscovery()` at the top of `discoverNow` and `failDiscovery()` in the failure path (both defined at
`electron/services/app-connections/inventory-ledger.ts:50,71`, currently never called from this connector, which is
why `discoveryStatus` sticks at `'refreshing'`). (b) Promote a real public API, e.g.
`ensureSessionForConnection(connectionId, provider)` resolving the provider config internally and taking the token
from the vault — matching `createStoredRemoteMcpOAuthProvider(vault, connectionId)` — and type the test double
against the real class. (c) Add the in-flight promise cache from `CONN-010` in the same change; it is the same method.

**Effort:** S.

### P0-3 — `tool_invoke` bypasses the plan-mode write barrier

*Source: `AGENT-001` (agent core).*

**What breaks.** While a plan-mode tracker is `canGateTools()`-active, the model can defeat the hard write barrier —
the one that produces the user-facing "only the session plan file may be written" denial — simply by reading a
deferred tool's schema through `tool_catalog` and executing it through `tool_invoke`.

**The path.**
1. `GATED_WRITE_TOOLS` at `packages/agent/src/modes/engine/coordinator.ts:120` is
   `['edit','write','bash','powershell','module']`.
2. The gate is enforced inside `canUseTool` at `packages/agent/src/agent/PermissionsGate.ts:187` — together with the
   plan-498 approval-ledger consume and the `alwaysAllowTools` grant at `:170-181`.
3. The `tool_invoke` dispatcher is wired at `packages/agent/src/agent/DuyaAgent.ts:1361` to
   `this.hasPermissionsToUseTool(toolName, args, permissionContext)` — the **raw policy engine**, below all three
   pre-checks.
4. `module` is registered with `exposure: 'deferred'` (`packages/agent/src/tool/builtin.ts:213`), and a deferred tool
   is only invocable through `tool_invoke` (`packages/agent/src/tool/ToolInvokeTool/dispatcherFromRegistry.ts:104-106`).
5. The comment at `packages/agent/src/agent/DuyaAgent.ts:1339-1343` asserts that "routing through the meta tool can
   never bypass the permission policy". For the plan gate, that claim is false.

**Why this is a P0 and not a P1.** The barrier is a *product* guarantee the user is shown, not an internal hardening
measure, and the bypass is reachable by ordinary model behaviour — the deferred catalogue is advertised in the system
prompt. No crafted payload is required.

**Fix.** Pass the already-built `guardedCanUseTool` (the inner `canUseTool` from `buildPermissions`,
`packages/agent/src/agent/DuyaAgent.ts:1300`) into `createToolInvokeDispatcherFromRegistry` instead of re-deriving a
permission call, so the `checkPermission` callback is a thin adapter over the single gate. Land `AGENT-002`'s
fail-closed fix in the same commit — the same callback is the third dispatch site (see `P1-A01`).

**Effort:** S.

### P0-4 — The plugin trust model is computed, displayed, and never enforced

*Source: `CONN-003` (connectors).*

**What breaks.** Any marketplace-sourced plugin is auto-promoted to `Verified` with no signature check, and even the
declared capability limits gate nothing. A third-party plugin runs with the same reach as a bundled one.

**The path.**
1. `TRUST_LEVEL_CAPABILITIES` at `packages/plugin-core/src/security/trust-engine.ts:25-58` defines a 4-level model
   with per-level `maxFileAccess`, `allowHttpHooks`, `allowAgentHooks`, `requirePermissionConfirmation`, `maxHooks`.
2. A repo-wide search for those field names, excluding `trust-engine.ts` and tests, returns exactly one non-test hit:
   `electron/ipc/plugin-handlers.ts:630`, `const capabilities = trustEngine.getCapabilities(trust)` — inside
   `ipcMain.handle('plugin:security:trust-info')`, which returns `{ trust, capabilities }` to the renderer. Nothing
   consults the model on any install, load, or execute path.
3. `determineTrustLevel` at `packages/plugin-core/src/security/trust-engine.ts:61-86` awards `Verified` purely from
   `source === 'marketplace' && marketplaceName`. A search for `.signature|verifySignature|gpg|minisign` across
   `*.ts` finds no signature verification anywhere in the plugin path; `PluginTrustInfo.signature` (`:12`) is
   write-nowhere, read-nowhere.
4. A plugin-declared stdio MCP server is spawned as a subprocess with the agent's filesystem reach
   (`packages/agent/src/mcp/index.ts:324`); the env allowlist at `packages/agent/src/mcp/security.ts:92-128` limits
   *environment* leakage only, not filesystem or network.
5. `PluginManager.installFromCatalog` records the manifest's requested permissions as *granted* with no user decision
   (`electron/plugins/PluginManager.ts:476-483`), so the grant table is not a record of consent the moment enforcement
   lands.

**Why this is a P0.** The trigger is user-mediated (installing a marketplace plugin), which is why it is not a
zero-click remote hole. But it is a supply-chain hole with **no signature verification at all**, and the UI actively
displays a security posture the runtime does not enforce — a false assurance, which is the failure mode hardest to
detect later.

**Fix.** Do one of the two halves properly, not half of each. (a) *Enforce*: call
`policyEngine.meetsMinimumTrustLevel(...)` and `trustEngine.getCapabilities(trust).maxFileAccess` in
`PluginManager.installFromCatalog` and in the MCP candidate collector, and drop to `Untrusted` when a `marketplace`
source has no verified signature. (b) *If enforcement is out of scope*: stop returning `capabilities` from
`plugin:security:trust-info` and mark the model advisory in the manifest schema, so the UI stops implying a boundary
that does not exist.

**Effort:** L for (a), S for (b).

---

## 4. High-severity findings (P1)

34 issues. `src` = source finding ID(s) in the raw reports. Effort: S / M / L.

### Agent core (`packages/agent`) — 7

| ID | Title | Source | Location | Effort |
| --- | --- | --- | --- | --- |
| P1-A01 | `ask` resolves differently on three dispatch paths; `tool_invoke` and `mcp/apply` fail **open** while `StreamingToolExecutor` fails closed | AGENT-002 + AGENT-020 | `tool/ToolInvokeTool/dispatcherFromRegistry.ts:170`; `tool/StreamingToolExecutor.ts:1751`; `mcp/apply.ts:535` | S |
| P1-A02 | Two god files (9,563 lines) own the whole runtime; the permission surface has 2 construction sites | AGENT-003 | `agent/DuyaAgent.ts` (4,904), `process/agent-process-entry.ts` (4,659) | L |
| P1-A03 | Three copies of command normalisation; the security copy is the weakest (no ANSI stripping) | AGENT-004 | `permissions/policy.ts:477`; `tool/PowerShellTool/security.ts:92`; `utils/shell/intelligence.ts:47` | S |
| P1-A04 | Two workspace-escape checkers with different guarantees | AGENT-005 | `tool/allowedRoots.ts:37`; `permissions/policy.ts:1047` | M |
| P1-A05 | Every `db:*` request leaks a 30 s timer; the handle is never captured or cleared | AGENT-006 | `ipc/db-client.ts:72-78` | S |
| P1-A06 | The stdout write queue is documented as bounded and is an unbounded array | AGENT-007 | `process/worker-protocol.ts:800-836` | S |
| P1-A07 | Deprecated `permissionMode` still crosses the worker boundary and is silently ignored | AGENT-008 | `process/worker-protocol.ts:47`; `process/agent-process-entry.ts:194` | S |

### Main process + memory (`electron/`) — 12

| ID | Title | Source | Location | Effort |
| --- | --- | --- | --- | --- |
| P1-M01 | `webviewTag: true` with no `will-attach-webview` guard (**demoted from P0**, see §7) | MAIN-002 | `core/window-manager.ts:149` | S |
| P1-M02 | 12 channels exposed via `contextBridge` have no handler anywhere | MAIN-003 | `preload.ts:2033,2295,2495,2613-2616` | S |
| P1-M03 | 4 implemented features unreachable: handler and preload disagree by a `db:` prefix | MAIN-004 | `ipc/db-handlers.ts:478,605,447,434` vs `preload.ts:2295,2298,2311,2313` | S |
| P1-M04 | 28 registered channels have zero consumers in the entire repository | MAIN-005 | `ipc/db-handlers.ts`; `agents/agent-communicator.ts:131,137`; `ipc/updater-handlers.ts:32` | M |
| P1-M05 | `agent:getProviderConfig` serialises the plaintext provider credential with no sender check and no callers | MAIN-006 | `agents/agent-communicator.ts:143,179,194` | S |
| P1-M06 | `app:create-project-folder` sanitises the wrong character set: `/` and `..` survive | MAIN-007 | `ipc/system-handlers.ts:345,354,358` | S |
| P1-M07 | RAG recall loads the entire corpus (content + embeddings) on every query, on the main thread | MAIN-008 | `memory/rag_search.ts:233-234,254-274` | L |
| P1-M08 | RAG keyword fallback: unbounded `LIKE '%term%'` full scan on 2-char CJK queries | MAIN-009 | `memory/rag_search.ts:148-160` | M |
| P1-M09 | Tier recall on the prompt hot path runs three unbounded `SELECT *` queries | MAIN-010 | `memory-state/tierIndex.ts:248-254,296-300` | M |
| P1-M10 | Schema validation effectively absent from the IPC layer (zod in 13 of ~200 electron files) | MAIN-011 | `ipc/db-handlers.ts:2002`; `agents/agent-communicator.ts:478`; `preload.ts:119-120` | L |
| P1-M11 | No sender or frame validation on any `ipcMain.handle` | MAIN-012 | `ipc/system-handlers.ts:48`; `main.ts:858`; `agents/agent-communicator.ts:143` | M |
| P1-M12 | `shell:open-path` / `shell:show-item-in-folder` accept any absolute path from the renderer | MAIN-014 | `ipc/system-handlers.ts:144-152,154-171` | S |

### Renderer (`src/`) — 5

| ID | Title | Source | Location | Effort |
| --- | --- | --- | --- | --- |
| P1-R01 | Full provider config including the plaintext API key logged to the renderer console (**demoted from P0**, see §7) | RENDER-002 | `lib/stream-session-manager.ts:192` | S |
| P1-R02 | Edit-rewind deletes transcript rows before the replacement send, with no rollback | RENDER-003 | `components/chat/ChatView.tsx:924-932`; `stores/conversation-store.ts:1112-1122` | M |
| P1-R03 | Widget iframe forwards a model-supplied href to `window.open` with no protocol check and no `noopener` | RENDER-004 | `components/chat/WidgetRenderer.tsx:291-295` | S |
| P1-R04 | Three dead `git diff` wrappers while preload still exposes the channels | RENDER-005 + RENDER-016 | `lib/git-ipc.ts:109,113,156`; `preload.ts:2601,2602,2609` | S |
| P1-R05 | `CodeReviewPanel.refresh()` has no cancellation guard: a slow earlier scope can overwrite a newer one | RENDER-006 | `components/layout/panels/CodeReviewPanel.tsx:395-460` | S |

### Connectors (`electron/channels|gateway|messaging|plugins|skills|import`, `packages/gateway`, `packages/plugin-core`) — 7

| ID | Title | Source | Location | Effort |
| --- | --- | --- | --- | --- |
| P1-C01 | Feishu webhook fails open when `x-lark-request-token` is absent (**demoted from P0**, see §7) | CONN-004 | `packages/gateway/src/adapters/feishu/webhook-server.ts:110-117` | M |
| P1-C02 | Browser bridge auto-approves the first WebSocket client claiming the extension name; the allowlist gate is unreachable | CONN-005 | `electron/services/browser/daemon.ts:135-140,436,508-544` | S |
| P1-C03 | The `[apps]` kill switch is unreachable **and** is not checked on the `invoke` path | CONN-006 + CONN-007 | `app-connections/connector-service.ts:234,353-520`; `app-connections/policy-gate.ts:63,71` | S |
| P1-C04 | Per-agent Telegram offset is in-memory only; restart replays up to 24 h of inbound messages | CONN-008 | `electron/channels/telegram-connector.ts:114,166` | M |
| P1-C05 | `connector-secret-store` validates `agentId` but not `platform` (**medium confidence**, see §7) | CONN-009 | `electron/channels/connector-secret-store.ts:28-41` | S |
| P1-C06 | `ensureSession` has no in-flight dedup: concurrent first-invokes duplicate sessions and leak transports | CONN-010 | `app-connections/connectors/remote-mcp.ts:350-423` | S |
| P1-C07 | Catalog cache is keyed on `connectionId` but never re-checks endpoint identity | CONN-011 | `app-connections/connectors/remote-mcp.ts:360,408-414`; `catalog-cache.ts:27-57` | S |

### Website (`duya-website`) — 3

| ID | Title | Source | Location | Effort |
| --- | --- | --- | --- | --- |
| P1-W01 | Two parallel auth systems: header UI gated on Clerk while accounts are Supabase; Clerk middleware enforces nothing | SITE-001 + SITE-002 | `components/ui/header.tsx:7,95-106`; `middleware.ts:1-10`; `app/layout.tsx:34` | M |
| P1-W02 | No security headers at all in the Next config | SITE-004 | `next.config.ts:3,8`; `vercel.json:2` | S |
| P1-W03 | All 17 leaf docs redirects in `vercel.json` 301 into a 404 | SITE-005 | `vercel.json:12,36,86`; `lib/docs.ts:41,77` | S |

---

## 5. Medium / low (P2 / P3)

54 P2 and 15 P3 issues. They are overwhelmingly **recurring shapes**, not isolated defects — the themes below are the
actionable unit. Counts are post-dedup; the source IDs named are representative, not exhaustive.

| Domain | P2 | P3 |
| --- | --- | --- |
| Agent core | 11 | 3 |
| Main process + memory | 9 | 4 |
| Renderer | 12 | 3 |
| Connectors | 10 | 1 |
| Website | 12 | 4 |
| **Total** | **54** | **15** |

**T1 — Dead code and unreferenced exports (≈11 P2, ≈3 P3).** Deprecated factories kept importable through barrels, so
a new caller would reach for them: `packages/agent/src/tool/ReadTool/ReadTool.ts:801` (`createReadTool`, re-exported by
three modules, called by none), `packages/agent/src/tool/BrowserTool/CDPClient.ts:1515` (deprecated wrapper, also the
module's `default` export). Two dead functions are kept alive only by tests that cannot fail
(`packages/agent/src/utils/bash/shellQuote.ts:151`, whose own test asserts `false` in all three cases). The most
misleading instance is `electron/services/overlay/sanitize.ts:23` — a 38-line module plus a 100-line test suite
documenting validation for a channel that is implemented nowhere.

**T2 — Duplicate abstraction where the copies have drifted (≈11 P2).** Covered in detail as RC-4. Beyond the
security-relevant pairs: two `InventoryLedger` state machines that are near-verbatim copies
(`electron/services/app-connections/inventory-ledger.ts:31` vs `packages/agent/src/mcp/inventory-ledger.ts:29`, whose
`failDiscovery` at `:71` contains a ternary with two identical arms and a comment claiming a distinction the code does
not implement); provider runtime config built twice, with the two copies already diverged
(`electron/agents/server/router.ts:1832` vs `agents/agent-communicator.ts:143-202`); three competing tool-catalog
snapshots per stream in `packages/agent/src/agent/DuyaAgent.ts:1323,1572,3780`.

**T3 — God files (≈4 P2, 1 P1).** `electron/agents/server/router.ts` (3,192), `electron/preload.ts` (3,061),
`electron/ipc/db-handlers.ts` (2,778), `electron/db/core/message-log.ts` (2,647), `electron/db/schema.ts` (2,605),
`electron/agents/db-bridge.ts` (2,569), `electron/gateway/message-bus.ts` (1,408),
`src/components/layout/panels/CodeReviewPanel.tsx` (1,067, 27 `useState` in one function),
`app/account/page.tsx` (663, eight handlers behind one `busy` flag). The preload and `router.ts` sizes are not merely
style — they are the mechanical cause of P1-M02/M03/M04.

**T4 — Boundary inversion (≈5 P2).** The main process imports 40+ modules from the renderer's `src/` tree, including
the entire provider-credential contract as *live* code, not `import type` —
`electron/services/providers/provider-store.ts:66-71`. All five verified DOM-free today, so there is no runtime break;
but a renderer-side edit introducing `window.` would break the main process **in packaged builds only, with no
typecheck error**, because of RC-2.

**T5 — Unbounded memory growth (≈5, spanning P1/P2).** No eviction or retention anywhere in the memory stores
(`electron/memory/rag_search.ts:233`; `electron/memory-state/tierIndex.ts:248-254`), so the unbounded read paths in
P1-M07/M08/M09 grow monotonically with lifetime usage rather than with the amount worth recalling.

**T6 — Theme token contract violated (≈2 P2).** Raw hex where `--review-*` tokens exist, in the same switch statement
(`src/components/layout/panels/CodeReviewPanel.tsx:95-96`), and a JS-level `isDark ? ... : ...` fork that duplicates
the decision `data-theme` already encodes (`src/components/chat/CodeBlock.tsx:33-44`). `AGENTS.md` is explicit that
borders use only the three tokens.

**T7 — Documentation drift (≈3 P2).** `packages/agent/ARCHITECTURE.md:520-528` documents eight subpath exports; four
exist in `package.json` `exports` and two of the documented ones do not exist as directories at all. The root
`tsconfig.json` `paths` mask it in typecheck, so it fails at runtime.

**T8 — Logging convention unenforced (≈1 P2, after merging).** `console.*` bypasses the mandatory structured logger
across both main and gateway: `electron/memory/curation_single_shot.ts` alone has 8 sites, `electron/gateway/message-bus.ts`
has 23, and `packages/agent/src/cli/slash-commands.ts` has 112. Because the default level is `WARN`, these never reach
`app.log` for support diagnosis at all.

**T9 — Encoding damage (≈1 P2, 2 P3).** 86 mojibake sequences in the most heavily-read file in the package
(`packages/agent/src/agent/DuyaAgent.ts`, first at `:327`), and the same double-encoding in
`electron/config/store-instance.ts:1` and `index.html:36`. Confirmed at HEAD: `DuyaAgent.ts:1341` renders the em-dash in
"routing through the meta tool can never bypass…" as three garbage characters. A Windows round-trip through a
mismatched code page is the mechanism; the affected comments are unreadable exactly where rationale is densest.

**T10 — Test gaps and disabled checks (≈3 P2).** The website repo has **no test script at all**
(`package.json:5-13`) — which is how a 100%-broken redirect table shipped. `CodeReviewPanel` itself is untested; only
its pure parser is covered (`code-review-diff.test.ts`, 78 lines). 25 `eslint-disable react-hooks/exhaustive-deps`
suppressions in non-test renderer code, several on data-fetch effects where a suppression *is* the bug
(`src/components/layout/panels/CodeReviewPanel.tsx:560-562`).

**T11 — Silent failure and recovery gaps (≈8 P2, 1 P3).** Handlers throw raw `Error`s so the renderer receives an
untyped string (`electron/ipc/db-handlers.ts:2037,1984,2506`); Feishu `onEvent` rejections after the 200 ack are
swallowed with **no log at all** (`packages/gateway/src/adapters/feishu/webhook-server.ts:119-128`); the client-side
GitHub fetch on the download page silently falls back to a build-time value that is five minor versions stale
(`scripts/fetch-latest-version.mjs:19` says `v0.1.3-beta.2`; the live value is `v0.8.1`).

**T12 — Repo hygiene (≈2 P2, 1 P3).** `tsconfig.tsbuildinfo` is tracked, so the working tree is permanently dirty;
11 `.playwright-mcp/` files are committed despite `.gitignore:23`; `scripts-tmp-shot.cjs` is tracked with ~63 untracked
siblings.

---

## 6. Cross-domain observations

**Contracts duplicated on both sides of a process boundary.**
- Git wire types: `electron/ipc/git-types.ts:27` (canonical) → `electron/preload.ts:19-32` (imports it) and
  `src/lib/git-ipc.ts:9-97` (hand-copies it, under a justification at `:3-7` that `src/global.d.ts:3` invalidated).
- `db:*` DTO: emitted by `packages/agent/src/ipc/db-client.ts:47-52`, consumed by `electron/agents/db-bridge.ts`,
  `payload: unknown` with no validation on either side.
- Permission vocabulary, defined three times with three different value sets: agent internal
  (`packages/agent/src/permissions/types.ts:25`), DB row mapped at
  `packages/agent/src/process/permission-profile-bridge.ts:15`, renderer UI (`src/types/index.ts:12`, duplicated again
  at `src/components/chat/ChatView.tsx:60` and `src/components/chat/MessageInput.tsx:385`). The bridge is the only
  correct translation point.
- The counter-example worth copying: `@duya/agent/message` is imported by *both* sides
  (`electron/db/core/message-log.ts:33`, `electron/ipc/db-handlers.ts:152`) with the path pinned at
  `electron/tsconfig.json:16`.

**Abstractions that exist twice, with named counterparts.**
- Command normalisation: `permissions/policy.ts:477` ↔ `PowerShellTool/security.ts:92` ↔ `utils/shell/intelligence.ts:47`.
- Workspace containment: `tool/allowedRoots.ts:37` ↔ `permissions/policy.ts:1047`.
- Theme: `src/hooks/useTheme.ts:3` ↔ `src/components/chat/WidgetRenderer.tsx:40`; and cross-repo
  `app/theme-provider.tsx:35` ↔ `components/ui/theme-provider.tsx:1`.
- Provider runtime config: `electron/agents/server/router.ts:1832` ↔ `electron/agents/agent-communicator.ts:143`.
- `InventoryLedger`: `electron/services/app-connections/inventory-ledger.ts:31` ↔
  `packages/agent/src/mcp/inventory-ledger.ts:29`. Note `packages/plugin-core` *is* importable from electron — it is
  already imported for `ledger-types` — so only the runtime-module boundary, not the type boundary, forces this pair.
- Git polling: `src/hooks/useGitRepo.ts:54-121` ↔ `src/hooks/useGitStatus.ts`, with the "one poller per cwd" invariant
  enforced only by a comment at `useGitRepo.ts:1-9`.
- Docs route trees: `app/manual/[...slug]/page.tsx:1` imports the `/docs` client, and both accept `basePath` — the
  duplication is self-inflicted.

**The same dead-code shape recurring.** Deprecated export kept importable through a barrel, referenced only by its own
test: `createReadTool` (`ReadTool.ts:801`), `splitCommand_DEPRECATED` (`utils/bash/commands.ts:79`),
`hasShellQuoteSingleQuoteBug` (`utils/bash/shellQuote.ts:151`), `createCDPClient` (`CDPClient.ts:1515`),
`getGitReviewDiff` / `getGitReviewFullDiff` / `getGitReviewScopedDiff` (`src/lib/git-ipc.ts:109,113,156`),
`setProviderEnabled` / `isProviderEnabledLive` (`policy-gate.ts:63,71`),
`sanitizeOverlayElements` (`overlay/sanitize.ts:23`), `HeroCanvas` / `HeroCrystalCanvas` / `docs-toc` (website),
`navItems` (`data/siteMetadata.ts:14`), `useShell` threaded through the entire MCP config pipeline
(`packages/agent/src/mcp/loader.ts:76`) and consumed by nothing. Eleven independent instances of one pattern: *the
barrel re-export is what makes dead code look wired.*

**A build-mutated tracked file creates a permanent-dirty-tree loop.** The website wires one script to three npm hooks
(`package.json:7,9,12`); `scripts/fetch-latest-version.mjs:65` writes to the **tracked** `lib/version.json`, so
`npm run dev` dirties the tree and a `fetched_at` bump eventually gets committed.

**A broken plan link at the audited commit.** `docs/exec-plans/README.md:77` links
`./active/580-mcp-capability-core-convergence.md`, which does not exist in `active/` at `e1bc1650` (27 files present;
the working tree has since restored it to 36). The audit trail for the plan-580 decisions cited throughout the connector
findings was missing at the commit under audit.

---

## 7. Contested / unresolved

**C1 — Is the Feishu webhook remotely exploitable? Downgraded, not dismissed.** `CONN-004` filed this P0 on the basis
that "any process that can reach the webhook port" can forge events. Spot-checking the bind: the default host is
loopback — `const host = this._config.webhook?.host || '127.0.0.1'`
(`packages/gateway/src/adapters/feishu/index.ts:362`, bound at `webhook-server.ts:136`). The fail-open itself is
**confirmed and real** (`if (headerToken && headerToken !== this._options.verificationToken)` — an absent header
short-circuits to pass), and no `encryptKey` signature verification exists anywhere. But with the shipped default
binding it is a **local**-attacker primitive, not remote. I therefore demoted it to P1 (`P1-C01`). *What would settle
it:* whether any documented deployment fronts this port with a reverse proxy or tunnel, which would restore P0.

**C2 — The Notion `pages=N, total=M` under-report: two incompatible explanations.** Auditor 04 **could not reproduce**
it statically and proposed a different mechanism: the `maxPages: 50` / `maxTools: 5000` truncation
(`packages/plugin-core/src/mcp/core/list-tools.ts:59-60`) marking a pass `stale` while the caller still uses the
partial `session.tools`, so a *truncated* pass is reported without its truncation flag reaching the UI. The lead
auditor's independently-confirmed `ledger` `TypeError` (P0-2) gives a second, simpler explanation: discovery throws
before totals are recorded. These are not mutually exclusive, but only one can be the mechanism for exec-plan 580's
observed run. *What would settle it:* the Phase 0 real-machine run that plan 580 already specifies.

**C3 — Is `webviewTag` a live P0? Downgraded.** `MAIN-002` filed `webviewTag: true` with no `will-attach-webview`
guard as P0, while conceding in the same finding that "the currently-rendered guests do not set those attributes, so
this is a missing defence-in-depth layer rather than a live exploit today." I agree with the concession and demoted it
to P1 (`P1-M01`). *What would settle it:* whether any shipped page or widget can attach a webview with
`webpreferences` it controls.

**C4 — Plaintext API key in the renderer console: severity, not fact.** `RENDER-002` is not in doubt —
`console.log('[stream-session-manager] Provider config:', config)` at
`src/lib/stream-session-manager.ts:192` logs the object typed with `apiKey: string` at `:178-186`, sourced from the
*unmasked* accessor per the comment at `:166`, while sibling logs at `:228,314,365` deliberately project fields. I
demoted it from P0 to P1 because the exposure is local-user-scope (DevTools console, and console output in a support
bundle) rather than a privilege-boundary crossing, and the key is already on disk in the user's own config. It is a
defect that must be fixed; it is not a P0 by this audit's standard.

**C5 — `CONN-009` (`platform` unvalidated in `connector-secret-store`) is medium-confidence and stays labelled.**
The missing guard is certain from the source (`electron/channels/connector-secret-store.ts:28-41` validates `agentId`
and interpolates `platform` straight into a path, with `mkdirSync` + `writeFileSync` at `:124-127`). What is *not*
established is reachability: the source auditor found the `secret:store` channel is **not** exposed in
`electron/preload.ts` at all, and every call site passes a literal or an on-disk `connection.json` platform.
*What would settle it:* whether any main-process caller can supply an attacker-influenced `platform`. If not, it
drops to P2 (defence-in-depth + inconsistency with the correct guard in `attachment-store.ts:35-45`).

**C6 — `MAIN-018` (memory retrieval takes no identity parameter) is medium-confidence and does not appear in the P1
table.** The auditor explicitly flagged that they did not read `rag_snippet.ts` / `rag_refresh.ts` and that the agent
may reach search through a path outside `electron/`. Reported here as an open question, not a finding.

**C7 — `RENDER-019` (`diffLoading` stuck true) is medium-confidence and stays P2.** The "no unconditional clear on the
success path" claim is solid from the source; the "stuck forever" conclusion is inferred from effect dependencies and
needs a runtime trace.

**C8 — `SITE-012` (docs slug traversal) is low-confidence by the source auditor's own label.** The missing guard
versus `lib/blog.ts:55,59-63` is certain; whether a multi-segment URL actually reaches `getDocBySlug` with traversal
intact depends on Next.js path normalisation and needs a running dev server.

**C9 — The IPC channel census, independently re-run.** Auditor 02 reported "40 broken channels out of 440 registered
(9%)": 12 exposed with no handler, 28 registered with no consumer. I re-ran the diff mechanically and got **434**
direct `ipcMain.handle|on` registrations and **406** preload-exposed names — a naive diff shows 18 with no handler,
but 6 of those (`import:detect|scan|apply|rollback|history` at `electron/import/import-handlers.ts:40-261`, plus
`capability-management:snapshot` at `electron/ipc/capability-management-handlers.ts:24`) **are** handled — through a
`register()` indirection a literal `ipcMain.handle` grep misses. After excluding them, the no-handler set is exactly
02's 12, including all four `db:`-prefix mismatches. 02's number is confirmed. I did not reproduce the "28 with zero
consumers repo-wide" figure by an independent whole-repo grep; my preload-scoped upper bound is 46, which includes
channels legitimately consumed only by non-renderer code.

**C10 — A shipped test suite asserting a signature the production class does not have.** `CONN-001`'s tests mock a
connector with a *public* `ensureSession` while the real class declares it `private`
(`electron/services/app-connections/connectors/remote-mcp.ts:350`). The suite is green and the signature is wrong.
This is not a disagreement between auditors; it is recorded here because it is the single clearest proof for RC-2.

---

## 8. What was verified clean

Load-bearing negative results. Do not re-audit these.

**Security — checked, sound.**
- **No SQL injection anywhere in the main-process scope.** Both interpolated sites are safe:
  `electron/ipc/db-handlers.ts:2007-2024` derives column names from a hardcoded `fieldMap` allowlist with bound
  `@params`; `:2534-2536` generates only `?` placeholders from array length. The FTS `MATCH` expression is a bound
  parameter and malformed input is caught and ignored (`electron/memory/rag_search.ts:120,127,143-145`).
- **External-URL policy is a strict allowlist.** `electron/ipc/url-safety.ts:20-41` rejects non-strings, over-length
  input, control characters *before* trimming, any scheme but `http:`/`https:`, protocol-relative and scheme-less
  input, and empty hostnames. All three `openExternal` call sites route through it
  (`ipc/system-handlers.ts:177`, `core/window-manager.ts:224,249`) and `setWindowOpenHandler` always denies
  (`window-manager.ts:228`).
- **No `dangerouslySetInnerHTML` and no raw-HTML markdown path, in either repo.** `grep` over `src/` returns no
  matches; `src/components/chat/MarkdownRenderer.tsx:2-3` uses `react-markdown` + `remark-gfm` only, with no
  `rehype-raw` / `allowDangerousHtml` / `skipHtml` anywhere, and `preserveLocalUrlTransform` falls through to
  `defaultUrlTransform` for every URL outside its allowlist (so `javascript:` is still stripped). Same in the website:
  no `dangerouslySetInnerHTML` anywhere, and `components/markdown-content.tsx:14` passes only `remarkGfm`.
- **Token storage at rest is correct.** `electron/services/app-connections/token-vault.ts`: whole-map `safeStorage`
  encryption, `mode: 0o600` + `chmod` (`:132-138`), `VaultUnavailableError` rather than a plaintext fallback
  (`:122-124`), atomic write. No plaintext refresh-token file exists in the connector domain.
- **Tokens never cross IPC.** `listDescriptorsForConnected` returns descriptors only; `toStatusDTO` is the sole
  renderer-facing shape; the `appConnection:*` handler list has no token-returning channel.
- **The Git marketplace clone is hardened.** `packages/plugin-core/src/marketplace/git-source.ts`: `spawn` with no
  shell (`:91`), `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` (`:95-96`), a 120 s timeout that kills the child
  (`:103-106`), and canonicalized containment checks (`:135+`). No argument-injection path.
- **Agent-side MCP hardening is a real layer.** `packages/agent/src/mcp/security.ts`: env allowlist with an explicit
  `forceInherit` opt-in (`:92-128`), credential-pattern redaction (`:147-165`), injection-pattern scanning
  (`:182-223`), sampling rate limiter (`:269-280`), applied before every `StdioClientTransport` (`mcp/index.ts:320-322`).
- **The MessagePort three-channel restriction is respected by construction on the agent side.** `AGENTS.md` restricts
  it to `config` / `toolExec` / `toolStream`; the agent package never constructs or posts on a MessagePort and never
  names `agentControl` (`git grep "MessagePort|postMessage" -- packages/agent/src` returns only two comments). *Caveat:*
  it is a convention, not a code check — see RC-3.
- **No secrets in `localStorage` (renderer).** All 40 call sites are UI preferences. Key material is fetched per turn
  and held in function scope.
- **No secret leaks in agent logging.** A grep for `apiKey`/`authToken` adjacent to `logger.*`/`console.*` returns one
  hit, `packages/agent/src/cli/imageCmds.ts:132`, which masks the value. The crash logger writes only `sessionId`,
  `origin` and a stack.
- **Website auth is genuinely enforced server-side.** `app/api/account/route.ts`: `runtime = "nodejs"` (`:3`),
  service-role key read only server-side (`:18`), `Bearer` token extracted (`:24-26`) and verified with
  `auth.getUser(token)` returning 401 on failure (`:39-42`) **before** the admin client is built (`:45`) and
  `deleteUser` called (`:59`). The browser client never receives the service key
  (`lib/supabase/browser.ts:10-13`). No open redirect; blog slug resolution has correct traversal guards
  (`lib/blog.ts:55,59-63`); `.env.local` is gitignored; no secret is committed.
- **The Git clone/review bridge honours its read-only contract in the renderer.** `CodeReviewPanel` exposes no
  stage / commit / push / reset / branch-mutation control — the only actions are read, display, copy-to-clipboard, and
  a chat-composer handoff. The 1 MB cap is enforced main-side (`electron/ipc/git-handlers.ts:14,253-255,284`) and
  `boundedPatchPart` correctly retains safe partial output when the child buffer is exhausted, as `AGENTS.md` requires.
- **Channel secret store has the correct guard, for contrast.** `electron/channels/attachment-store.ts:35-45` defines
  `assertSafeSegment` (rejects `path.sep`, `/`, `..`, `\0`) applied to owner/platform/name, with per-kind size caps
  and atomic writes. This is the model `connector-secret-store.ts` should follow (P1-C05).

**Correctness — checked, sound.**
- **i18n key parity is exact.** Scripted key extraction over `src/i18n/en.ts` and `src/i18n/zh.ts`: 2946 leaves each,
  0 keys unique to either file. No missing-key class of bug exists.
- **Listener lifecycle is clean in the renderer.** All 26 `duya:*` `window.addEventListener` call sites have a matching
  `removeEventListener`; all 22 IPC subscriptions use the `const unsubscribe = ...` + `return () => unsubscribe()`
  shape. The worker entry's three `setInterval` sites each have a matching `clearInterval` on every exit path
  (`packages/agent/src/process/agent-process-entry.ts:729,740,1234,3868,3871`).
- **Memory-handler idempotency is the correct pattern** — `electron/ipc/memory-handlers.ts:94,139,159` all call
  `ipcMain.removeHandler` before `handle`. This is the model for the rest of the layer.
- **The RAG rebuild is atomic.** `electron/memory/rag_index.ts:278-294` wraps the full `DELETE` + reinsert in
  `db.transaction()`. A crash mid-rebuild cannot lose data.
- **ConfigStore secret handling is sound** — secrets split out of `config.toml` into `secrets.json` (`:330-356`),
  atomic write with retry, never throws on persistence failure; the provider store refuses to persist a masked
  placeholder key and redacts secrets from validation errors. (One caveat, filed as `MAIN-022`: POSIX `0o600` is a
  no-op on Windows.)
- **CLI API server transport security is sound** — binds `127.0.0.1` on an OS-assigned port, checks the bearer token
  before routing, writes the runtime file only after a successful listen.
- **Main-process DB connections are configured correctly** — `journal_mode = WAL`, `busy_timeout = 5000`,
  `foreign_keys = ON` on both entry points, with a checkpoint on close.
- **The tier-index rebuild scoping is intentional, not an isolation break.** The hardcoded `agentProfileId: ''` at
  `electron/memory-state/tierIndex.ts:444` is scoped by `REBUILD_SCAN_ROOTS` (`:107`) to the legacy user-tier roots, so
  agent- and project-tier rows written by the Phase 3 writer are untouched.
- **Two retry layers are deliberately stacked and both correct.** Transport-level `withRetry` refuses to retry once a
  delta is yielded; the turn-level replay at `packages/agent/src/agent/stream-retry.ts:49-57` covers exactly that gap
  and reuses the shared `isRetryableError`. Backoff is capped (1s/2s/4s, max 8s), attempts capped at 3, and replay is
  suppressed once `turnCommitted` is true. This is the positive counter-example to P0-3's fail-open.
- **Inbound channel gating is well specified.** `inbound-filter.ts` is a pure decision function with allow/deny
  reasons and one documented fail-open; the Telegram poll loop advances the offset before handling, aborts cleanly,
  demotes repeated failures to DEBUG, and yields to the macrotask queue.
- **Remote-MCP OAuth storage is correct** — PKCE material stays inside the same encrypted vault, plaintext persistence
  is refused on vault failure, `openExternal` throws rather than opening a browser during a tool call, and `safeClose`
  prevents a failed `connect()` throwing a second exception.
- **Token refresh is correct** — 5-minute skew, single-flight dedup, rotation persisted, and `invalid_grant` maps to
  vault removal + `revoked` + a non-retriable `connection_revoked`.
- **`shared listAllTools` is well built** — cursor-loop detection, cross-page duplicate detection, shared deadline,
  truncation markers, generation guard.
- **No vacuous test suites in `packages/agent`.** A scan of every `*.test.ts` for files lacking both `expect(` and
  `assert.` returned zero files. A scan for `: any` in exported signatures across `packages/agent/src` returned zero.
  Renderer `any` usage in non-test code is 10 occurrences, all defensible.
- **The renderer is not a shadow architecture.** `src/data/` is one file with one importer; `src/contexts/` is one
  genuine React context; the panel registry at `src/components/layout/panels/registry.ts` is the single mount point for
  all 7 panels.

---

## 9. Recommended sequencing

The order is driven by **dependency and blast radius**, not by severity ranking. P0-4 (plugin trust) is the highest
severity in the list but is deliberately last among the P0s: it is an L-sized change, its trigger is user-mediated, and
fixing it correctly requires the contract work in Phase 2 to be done first or it will be redone.

**Phase 1 — Stop the bleed (P0s that are already reachable, plus the gate that would have caught them).**
Rationale: each item here is a live path with a known exploit, and all four are small except P0-4. The typecheck gate
is in this phase, not later, because P0-2 *is* a type error that shipped — every day the gate is absent, another one
lands. Land the gate first, then let it tell you whether the P0 fixes introduced new breakage.
1. Add the typecheck gate to CI on the esbuild path (RC-2). This is the single highest-leverage change in the audit:
   it mechanically catches P0-2 and P1-C06 with no judgement call.
2. P0-1 (`duya-file` root allowlist + drop `supportFetchAPI` + main-window CSP). M.
3. P0-2 (declare and initialise `ledger`; promote a real `ensureSession`; type the test double against the real class).
   S. **Also re-run exec-plan 580's Phase 0 baseline** — the throw may be what made it unreproducible (see C2).
4. P0-3 (thread `guardedCanUseTool` into the `tool_invoke` dispatcher). S. Land with P1-A01 — same callback.
5. P1-M03 (rename the four `db:`-prefixed registrations). **S — four lines, and it un-ships four broken features
   including the shipped Unarchive action, which currently deletes the row from the list and never restores it.** Do it
   first regardless of phase ordering: it is the cheapest user-visible win in the audit.

**Phase 2 — The IPC contract source of truth.**
Rationale: 40 broken channels and 4 unreachable features are all one root cause. Until a single manifest exists,
Phase 1's fixes are new strings added to two hand-maintained lists, and Phase 3's enforcement work has nothing to
hang off. This phase is the dependency for Phase 3.
6. Generate a declarative channel manifest; derive both `preload.ts` and the handler registrations from it. L.
7. Add the contract test that asserts every exposed name is handled and every handler is exposed — the one change that
   prevents P1-M02/M03/M04 from recurring. M.
8. Reconcile the Git contract triplication: delete the hand-copied interfaces at `src/lib/git-ipc.ts:9-97` and
   re-export from `electron/ipc/git-types.ts`, the precedent `src/global.d.ts:3` already set. S. Then decide the fate
   of the three dead `git diff` wrappers (P1-R04) and the four `git:*` write channels that have no handler (P1-M02).
9. Delete the 28 dead registrations (P1-M04) and the 12 phantom preload methods, **or** implement them. Decide once,
   as a policy — the current state is neither.

**Phase 3 — Root causes: enforcement and shared primitives.**
Rationale: these are the findings that stop the *classes* rather than the instances, and each needs Phase 2's manifest
as scaffolding.
10. One permission entry point: fix P1-A01, then collapse the three `ask` dispatch paths into one `resolveAsk` helper
    (P1-A01 + AGENT-020). S then M. The gate in item 4 is what makes this durable.
11. One workspace-escape checker and one command normaliser (P1-A04, P1-A03) — export the strong implementations and
    delete the weak copies. M. Do these together: both are "the deciding layer got the weaker copy".
12. `assertTrustedSender` wrapped into the registration helper in `electron/main.ts` so it cannot be forgotten (P1-M11),
    plus the zod schema per channel family (P1-M10) — the schema work is L but it is the natural companion to the
    manifest from item 6.
13. P0-4 plugin trust: **enforce or stop claiming**. Shipping the UI half with no enforcement is the current state and
    is worse than either alternative. Depends on item 12's sender validation, since the enforcement call sites are
    themselves IPC-reachable.
14. The `[apps]` gate on `invoke` (P1-C03), the browser-bridge allowlist inversion (P1-C02), and the Feishu mandatory
    token check + `encryptKey` signature (P1-C01) — all three are "the model exists, the call site does not".

**Phase 4 — P2 hygiene, batched by shape rather than by file.**
Rationale: none of these is an active risk; they are 54 issues that will keep producing new instances of the same
shapes. Batch them so the review cost is amortised.
15. One dead-code sweep across all five domains (T1, T2): delete the barrel-exported deprecated factories, collapse
    the duplicate abstractions, and fix the copy that is on the deciding path. This batch alone retires the majority of
    the 54.
16. Unbounded memory reads + retention (T5, P1-M07/M08/M09): move embeddings to a `BLOB` table, add `LIMIT` and a
    2-gram FTS table for short CJK, add a retention pass on the existing 5-minute sweep. M each; do them as one PR
    because they are one design.
17. `eslint` / typecheck enforcement sweeps: 25 `exhaustive-deps` suppressions on fetch effects, 112 `console.*` in
    the agent CLI, `@ts-nocheck` on four Feishu files, a lint rule banning non-type `src/` imports from `electron/`
    (T4, T8, T10).
18. God-file extraction, one file per PR, largest first: `electron/preload.ts` (done as a side effect of item 6),
    `electron/agents/server/router.ts`, `electron/ipc/db-handlers.ts`, `electron/gateway/message-bus.ts`,
    `CodeReviewPanel.tsx`.
19. Encoding: add `.editorconfig` / `.gitattributes` pinning UTF-8 and sweep the 86 mojibake sequences in
    `DuyaAgent.ts` **as part of** whichever PR next rewrites that file (T9) — doing it standalone is wasted work.
20. Website track, independent and parallelisable: security headers (P1-W02, S), the redirect table (P1-W03, S), the
    Clerk/Supabase split (P1-W01, M), a `test` script with the redirect-destination assertion that would have caught
    P1-W03 (M), and repo hygiene (T12).

---

## Provenance

| Domain | Scope | Raw report | Findings | Independent corroboration |
| --- | --- | --- | --- | --- |
| Agent core | `packages/agent` (god files, permission layer, tool-invoke dispatch, process boundary, retry, exports) | `.tmp-validation/architecture-audit/01-agent.md` | 23 (P0 1 / P1 7 / P2 12 / P3 3) | `db:*` DTO duplication flagged to main; MessagePort restriction, retry layering, secret handling, worker interval lifecycle and test-quality negatives are its own — no cross-domain duplicate |
| Main process + memory | `electron/main.ts`, `preload.ts`, `ipc/`, `core/`, `services/`, `agents/`, `db/`, full memory subsystem | `.tmp-validation/architecture-audit/02-main-memory.md` | 27 (P0 2 / P1 12 / P2 9 / P3 4) | **`duya-file:` P0 ≡ renderer RENDER-001**; `console.*` count overlaps connector CONN-017; sent 7 cross-domain reconciliation questions to the other four auditors |
| Renderer | all 808 files under `src/`, deep on `git-ipc.ts`, `CodeReviewPanel.tsx`, `WidgetRenderer.tsx`, markdown pipeline, full i18n key diff | `.tmp-validation/architecture-audit/03-renderer.md` | 21 (P0 2 / P1 4 / P2 12 / P3 3) | **`duya-file:` P0 ≡ main MAIN-001**; theme-hook duplication ≡ website SITE-007; Git contract triplication confirmed against `electron/ipc/git-types.ts`; one partial-read claim (P5 in its cross-domain notes) self-labelled medium confidence and **not** carried into the findings tables |
| Connectors | `electron/{channels,gateway,messaging,plugins,skills,import}`, `packages/gateway`, `packages/plugin-core`, `packages/agent/src/mcp`, `extension/` | `.tmp-validation/architecture-audit/04-connector.md` | 24 (P0 4 / P1 7 / P2 11 / P3 2) | Remote-MCP `ledger` `TypeError` **independently confirmed by the lead auditor**; its Notion under-report non-reproduction is contested against the lead's mechanism (C2); its `console.*` count overlaps MAIN-015; `secret:store` reachability question referred to the main auditor |
| Website | `middleware.ts`, `app/**`, `components/ui`, `lib/**`, `vercel.json`, repo hygiene, secret scan — **separate repo** `E:/Projects/duya-website` @ `9522711` | `.tmp-validation/architecture-audit/05-website.md` | 22 (P0 0 / P1 4 / P2 13 / P3 5) | Theme-provider duplication ≡ renderer RENDER-008; two findings (SITE-001/SITE-002) merged as one issue by its own root-cause analysis; `SITE-003` filed as an explicit verified-clean negative and reclassified here |

**Lead-auditor confirmations carried into this report as given, not re-litigated:** the `duya-file` P0 (two independent
discoveries merged into P0-1) and the remote-MCP `ledger` P0 (independently reproduced here at
`electron/services/app-connections/connectors/remote-mcp.ts:65-82,244,317,411` and merged into P0-2).
