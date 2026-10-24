# Agent retirement coordination

Status: active. Owner: root coordinator. Started: 2026-10-13.

## Objective and finish line

Run the existing Duya product through the monorepo owners with no source,
package, build, asset, or runtime dependency on `packages/agent`, then remove
that directory. Preserve active tools, bot exposure, modes, workflows,
subagents, prompts, permissions, persistence, and Desktop/CLI behavior.
RunEngine remains the sole model/tool/next-turn loop owner.

This is an execution slice of 610, not another architecture program. No new
remote runtime, client, arbitrary recovery feature, or Session schema redesign.
Do not rename/copy the monolith into a replacement umbrella package. Move
responsibilities to existing owners and cut their real consumers.

## Isolation and inherited baseline

- Checkout: `.claude/worktrees/agent-retirement`, `codex/agent-retirement`.
- Base: `4fc047c5`; existing dirty changes copied before new implementation.
- Primary checkout is preserved. Worktree dependency overlays use its own
  workspace sources and shared third-party dependencies.
- Initial `npm test` stopped in pretest at capabilities build: TS7016 for
  picomatch. The existing declaration remains in the retiring package.
  Capture the full test failure set after resolving this prerequisite.
- A green compile or stub worker is insufficient evidence for retirement.

## Ownership and sequence

| Agent | Current exclusive slice | Required proof |
| --- | --- | --- |
| Luna host_worker | Concrete child-run binding and SubagentTool Host adapter after verified workflow runner/child/backend and modifier/Canvas cuts | Same Host engine driver, required factories, actual child result and cancellation; no second agent loop |
| Luna tools_domains | SendMessage, UpdateState, Plan, ManageRoutine and DuyaCli tools after verified subagent service slice | Cap executors with required effects, Host production binding; CLI command runner injected without Host-to-CLI cycle |
| Luna retirement_validation | BackgroundTask, Skill and mode-switch tools after verified session/room/interagent tools | Preserve task lifecycle, existing mode state transitions and skill IO; share the actual Host invocation registry |
| Root | Baseline, shared contracts, permissions/executor cut, manifests/lock/build order/policy, integration and all final acceptance | Single authorization consumption; package gates, real production worker/CLI/Desktop evidence |

Agents edit only the isolated checkout and their assigned paths. Shared files
are coordinator-owned. Report new ownership/dependency edges before widening
the slice. No commits, push, baseline re-recording or test weakening by agents.

Next waves: runtime tool executor and context/compaction adapters; remaining
domain/mode/prompt implementations and worker assembly; production worker and
Desktop launch cutover; remove compatibility consumers and old package.
Every wave updates this file with completed facts and outstanding consumers.

## Final acceptance

1. Source/import/build/asset consumers of old Agent are zero (historical docs
   may explain the retired path).
2. Production worker builds and loads with the old directory unavailable.
3. Same engine serves standalone Host/CLI and Desktop; multi-turn tool use,
   approval allow/deny, cancellation, durable result/replay, child runs and
   workflows preserve their existing contracts.
4. Required typecheck and architecture gates pass; compare full-suite failures
   by test identity/error against inherited baseline. Build/package entry and
   assets are verified, with real Electron checks for bridge changes.
5. Only then delete old source and remove package metadata. Removing a junction
   or worktree always follows the repository's documented safe teardown.

## Progress

- Three GPT-6 Luna max agents completed the initial dependency/ownership audit.
- Independent Host/CLI execution exists; worker still resolves the old bundle.
- Frozen inherited baseline (separate checkout, plus the picomatch typing
  prerequisite): 14,565 tests, 14,314 passed, 157 failed, 94 pending; 43 failed
  file records. Failure identities/errors are saved for regression comparison.
- Initial architecture baseline: 1,588 tolerated findings, zero new violations;
  no baseline rewrite. New package entry points must be declared, not baselined.
- First cut: Host owns worker DB and OS context; Runtime owns the contextual
  fragment. Nine focused files / 85 tests and Host typecheck passed. Desktop
  OS callers now use the Host subpath and inject Main logging.
- Browser/OS capability build passed; behavioral suites are moving with their
  implementation and mock paths are being checked against actual owner modules.
- Runtime invocation decision binding plus the production approval/pipeline
  regression passed two files / 16 tests. Runtime/Host builds and Agent
  compatibility typecheck passed together after the first wave.
- Workspace context/activity tools named by AGENTS are unavailable in this
  session; coordinator messages and this document carry the shared handoff.

### Verified ownership cuts as of 2026-10-14

- Core owns message projection, reminders, wake/preemption, usage accounting,
  pinned-manifest verification and mode tracker contracts. Protocol owns
  attachment and worker wire DTOs. Core strict build passed.
- Runtime owns contextual permission evaluation, invocation decision binding,
  catalog registry/snapshots, MCP source guard and real tool execution pipeline.
  Runtime execution verification: 3 files / 31 tests, including four actual
  RunEngine model/tool/result/next-model tests. Compaction closure is verified below.
- Capabilities owns Browser/OS/CUA and connector tools through injected effects.
  Browser/CUA verification: 30 files / 292 tests. Connector tools: 40 tests;
  MCP lifecycle/conformance and config/guard cuts: 45 tests plus 26 adapter tests.
- Host owns worker DB/transport/logger, skill filesystem services and assets,
  prompts/AGENTS loading, attachments, hooks, task/journal services, managed
  shell, connector assembly and product mode coordination. Prompts: 11 files /
  157 tests; managed shell: 7 files / 80 tests; Goal/Research: 5 files / 70 tests.
- Twenty-three Desktop consumer references use the actual new owners. Launch
  selectors, worker bootstrap and final composition still depend on Agent.
- Compatibility exports remain temporary. The old package has not been retired.
  No current full-suite, production worker absence test or Electron acceptance
  has passed yet. Final acceptance above remains mandatory.
- Full-suite inherited failures are recorded by identity for later comparison.
  Shared manifest/export/build integration stays coordinator-owned. The import
  gate now resolves declared workspace exports; mutation checks proved it still
  rejects a forbidden Runtime-to-Host edge and a private deep import.
- Tests use a worktree-local E-drive temporary directory after C-drive temp
  exhaustion. This infrastructure failure is separate from behavioral failures.
- Context/compaction closure: 230 Runtime/Host tests, 197 old caller tests and
  50 real engine compaction integration tests passed. Product coordinator now
  belongs to Host; neutral engine-port adaptation belongs to Runtime. Durable
  tool ledger belongs to Host. After these final owner cuts, five focused files
  / 74 tests passed. One old coordinator cooldown assertion remains a recorded
  inherited failure with the same test identity and error.
- Discovery meta tools and real deferred dispatcher now belong to Runtime.
  MCP dispatch preserves the model-call context, binds a distinct invocation
  identity to the actual deferred tool/arguments and reuses explicit consent.
  Persisted approval is consumed once across gate/dispatcher/MCP source guard.
  Approval suites: 49 tests; Runtime execution regression: 31 tests, all passed.
- Turn assembly, immutable turn context and call-streak tracking now belong to
  Runtime; 66 contract/product/producer tests passed. A stale inherited producer
  assertion was updated to trace driver -> Host executor -> engine constructor.
- Profile storage/config are Host-owned, pure bot toolset and agent mentions
  Core-owned, tool visibility Runtime-owned, skill/plugin injections Host-owned.
  Eight focused files / 83 tests passed. Optional vision configuration/client
  now belongs to Host. Prompt asset build source now comes from Host.
- Host owns the optional tool worker pool and its concrete shell child entry.
  A self-contained child bundle plus the real pool started a child, received its
  ready frame, executed PowerShell via IPC and observed the expected tool output
  with exit code zero. This verifies that child path, not the main agent worker.
  The child producer in the existing bundle script now points to Host source.
- Durable approval-card persistence/surface handling moved to Host: 6 tests
  passed. Runtime request identity/schema-budget/visibility and Core timestamp
  rendering suites: 21 tests passed; Core and Runtime strict builds passed.
- Code census confirmed four live synchronous image attachment reads in the
  main worker. These bypass the IPC path and open their own main DB handle.
  The bounded remaining cut adds image reads to the existing local attachment
  API, merges Main/Core image rows through their existing owners and makes the
  worker await that facade. The parsed-document and modern session/timeline
  routes stay on their existing Host services.
- Local reference checks: Codex centralizes policy/reviewer routing under
  `core/src/tools/approvals.rs` and dispatch lifecycle in `tools/registry.rs`;
  Pi has a provider-neutral loop calling supplied tool executors. Duya's cut
  follows the same responsibility distinction: concrete tool effects in
  Capabilities, invocation gate/loop in Runtime, product approval UI/persistence
  in Host/Data. Package names are not treated as proof of runtime ownership.
- Main image hydration now uses the existing Host attachment API and Main/Core
  handles. Protocol/Core/Capabilities/Runtime/Data builds and 41 focused tests
  passed. No extra SQLite opener was introduced; the old SQL module remains
  pending final caller retirement.
- Product run options and invocation context are Host assembly contracts; the
  neutral tool descriptor and child definition reuse Runtime/Core contracts.
  Host owns conditional-skill registry assembly and the bound permission,
  executor, compaction and MCP services. Actual product/child-engine regression:
  35 tests passed after these service cuts.
- Widget tool is a capability with a required review port; Host owns headless
  rendering, vision wiring and image generation configuration/provider effects.
  Thirty behavior tests passed. A real independent Chromium rendered and
  disposed a 720x240 PNG; the artifact was visually inspected.
- Modifier/Canvas cut: 89 tests passed. Workflow runner, child transport and
  GUI/browser backends now belong to Host and require explicit execution ports;
  18 files / 290 workflow tests passed. Old child entry remains an adapter until
  the production bootstrap is rewired.
- Session search/management, room messaging, agent management and direct-message
  tool cuts: 9 files / 72 tests passed. The worker's old invocation-registry
  path re-exports the same Host map used by the moved tool; three owner tests
  verify nonce/terminal correlation and local timeout cleanup.
- Main run composition and driver now belong to Host and depend on an explicit
  product-session interface rather than the Agent class. The old driver path is
  a re-export. Driver/composition/child/progress batch: 41 of 42 tests initially
  passed; the remaining ownership assertion was updated to follow the actual
  Host driver and its old shim, then the real-agent proof suite passed 20/20.
  The product session class and main entry are still required remaining cuts.

### Coordinator checkpoint at 2026-10-14 19:39+ Asia/Shanghai

- WorkerSession product state/assembly is now in Host, with required registry
  construction. Host builtin/bot registries require explicit CLI command
  services; CLI worker-services composes the existing descriptor runner without
  introducing a Host-to-CLI dependency. Host/CLI package build and Host strict
  checking passed for these slices.
- Goal/Research child execution and computer-use mode effects are explicitly
  bound in WorkerSession rather than relying on legacy mode adapters.
- Real-estimator test suites moved to Host's production context-model port:
  22 files / 230 tests passed. Architecture checking passed with zero new
  violations, without baseline/policy edits. Later selector edits still need
  a fresh gate after the new producer exists.
- Main-worker persistence wrappers use the existing message/attachment IPC
  APIs; 3 files / 12 tests verify append receipts and parsed-document fields.
- As of the user's cost/status request, the Host main worker entry, CLI thin
  worker bootstrap and new bundled worker artifact do not yet exist. Selector
  edits are partial and cannot be considered a completed production switch.
  Old-package absence, full-suite regression comparison and CLI/Desktop
  acceptance remain unverified. The old package is still present.
- Parallel agents were interrupted for this cost/status checkpoint. No new
  tests or background work are being dispatched during the status response.
  The goal remains incomplete; no commit, push or merge has been performed.

### Coordinator checkpoint: main worker entry and executable cut

- Host now owns `worker-process-entry.ts`, with required process assembly.
  CLI's `agent-worker-entry.ts` supplies command services and calls that same
  Host start path. The former Agent entry is only a temporary import adapter.
  WorkerSession exposes a typed provider-config snapshot rather than the entry
  reading private fields through an untyped Agent instance. Workflow execution
  ports retain their launch-time provider snapshot across worker re-init.
- The existing bundle producer emits `packages/host/bundle/worker-entry.js` and
  its shell child. Desktop resource configuration and after-pack/artifact checks
  target `harness-bundle/worker-entry.js`. Declared workspace exports resolve to
  this checkout's source, avoiding primary-checkout junction declarations.
- Final bundle dependency metadata has 2,174 input files and **zero** inputs
  under `packages/agent/src` or `packages/agent/dist`. A real child started,
  answered the actual ping command, cleaned up on parent disconnect and exited
  zero. This is startup/transport proof, not a complete provider/chat run.
- Eight owner/entry regression files passed all 53 tests. They cover the actual
  Host product driver, model/tool/result feedback, context producers, event
  normalization, terminal latch and command-loop import/start contract. Initial
  owner-test import/listener-order failures left by interrupted delegation were
  repaired without reducing assertions. Host/CLI strict checks passed.
- Architecture checking passed with zero new violations; no baseline or policy
  exemptions were added. Sandbox image prewarming remains a concrete shell
  capability effect, called from Host bootstrap. Staged artifact checking passed;
  installed-package/runtime checks remain explicitly unverified.
- Agents remain stopped. Remaining work: complete current CLI/Desktop runs with
  the old package unavailable, migrate/retire remaining old-package tests and
  build metadata, run full regression/gates, then remove the legacy package.
  Full typecheck:all, architecture:self-test, full-suite failure comparison and
  Electron/package acceptance have not yet passed for the complete retirement.
  No commit, push, PR, merge or legacy-directory deletion has been performed.

### Coordinator checkpoint: real standalone CLI with the legacy package absent

- The old Agent directory was temporarily moved outside `packages/` during both
  worker/CLI builds and the actual CLI -> standalone Host -> spawned worker run.
  It was restored after all verification child processes closed. Primary
  checkout and user configuration were not changed.
- The loopback OpenAI Chat Completions fixture emitted streaming tool previews,
  argument deltas and complete calls. The actual worker searched the catalog,
  executed the real filesystem `read` tool on a newly-created random marker file,
  delivered both results to later model HTTP requests and completed the CLI with
  exit zero. Three model requests covered catalog -> file read -> final answer.
  Evidence: `.migration-cli-absence-smoke.json`. This proves actual production
  CLI/Host/worker wiring with a local provider fixture, not a remote paid-provider
  run or Electron rendering.
- Actual execution exposed and fixed three production gaps rather than bypassing
  them: the standalone worker bridge now serves model-capability cache actions
  through the existing Host/Data API; Runtime announces tool previews without
  executing partial arguments; discovery bindings survive per-invocation options
  copies while staying isolated between turns. The provider-neutral ModelMessage
  also preserves tool-call correlation through Host/engine/provider conversions.
- Focused regression evidence: model-cache database roundtrip 1/1; preview and
  engine loop 23/23; discovery binding and cross-turn rejection 10/10; model
  correlation 1/1. Runtime and Host strict checks passed. Architecture checking
  again passed with no new violations and no baseline/policy exemptions.
- Worker logging now honors the existing data-root resolver so temporary runs
  keep their log files inside their isolated root.
- Remaining census is 248 confirmed textual old-package references outside the
  retiring directory. It includes build metadata, tests, historical ownership
  tables/comments and guard patterns; it is not a count of live imports. Desktop
  execution, package absence during complete build/gates, full-suite comparison,
  old test/source retirement and actual package deletion remain unfinished.
  Agents remain stopped; no commit, push, PR or merge has been performed.

### Coordinator handoff: Host worker bundle checkpoint

- The Host-owned worker entry and CLI worker bootstrap now feed the existing
  bundle producer. Desktop and standalone selectors target that bundle, and
  release/artifact checks look for the Host worker entry. The legacy
  `packages/agent` package remains in this checkpoint; its eventual deletion is
  still the final retirement step.
- A local-provider run completed through `duya chat` with the legacy package
  absent: catalog lookup, real filesystem read, both tool results returned to
  later model requests, and final answer observed. The loopback fixture used
  three model requests. The run did not use a remote provider.
- A separate Electron run with the legacy package absent exercised the real
  main process, preload, Agent Server HTTP route, Host worker, model/tool result
  loop, and durable `completed` run row. Renderer reload did not expose the
  generated thread title in the expected task view, so visible Desktop chat
  acceptance remains open.
- `npm run typecheck:all`, `npm run architecture:check`, and
  `npm run architecture:self-test` passed for this checkpoint. Focused Host
  worker tests passed 53/53 and 26/26 in the two migration groups. The full
  Vitest suite and its prior-failure comparison were not run for this cut.
- Handoff work remains: finish the visible Desktop chat path; reconcile the
  full-suite failure set; retire the remaining legacy tests/build metadata and
  textual references; then remove `packages/agent` and verify clean builds and
  packaged execution with the directory absent. Do not mark Host/Desktop
  runtime convergence complete from the CLI and worker proofs alone.

### Coordinator handoff: standalone Host db domains (PR #420)

- Branch `codex/fix-host-db-actions`, base `origin/master` (`aed0d13c`), head
  `984a4d5a`. PR #420 is OPEN and **not merged** — integration needs the user's
  authorization. Worktree:
  `E:\Projects\duya\.claude\worktrees\host-db-actions`. The shared checkout stays
  read-only.
- The standalone Host's worker db bridge answered 66 actions. Three domains the
  worker asks for fell through to the default branch and threw
  `WorkerDbBridgeError('unimplemented_domain')`; the worker answers a failed
  lookup with a warning and an empty result, so the gap was silent. This cut
  serves them:
  - **mailbox** (10 actions): the worker claims rows at every model checkpoint
    and applies them afterwards. Every claim failed, so every notification was
    lost. Reuses the Host's existing `localMailboxApi` over
    `core.stores.mailbox`. The Desktop's renderer broadcast and wake
    scheduling are deliberately not repeated — a standalone Host has no
    renderer, and the worker picks the row up at its next checkpoint anyway.
  - **`plugin:setup:list-all`**: the MCP loader expands `${setup.X}` in plugin
    manifests from these values; without them every reference expanded to
    nothing. Reuses the Host's existing `localPluginSetupApi` over
    `PluginSetupStore`.
  - **`plugin:registry:list`**: answered from `config.toml`'s `[plugins]`
    block — the only persisted source of the installed-plugin list. The
    composite `<pluginId>@<marketplace>` key is split into id and marketplace;
    `enabled` is reported, and an entry that omits it counts as enabled (the
    Desktop registry store's default). The entry carries **no install path**:
    the package files live under the Desktop's Electron `userData`, not under
    the shared data root a standalone Host reads. Plugin skills and
    plugin-declared MCP servers therefore stay unavailable here — exactly as
    before — but the action no longer fails and the enabled-plugin set the
    worker gates on is now served.
- `coreMailboxToIpcRow` moved to `@duya/host/ipc-row-adapters` so both bridges
  emit one legacy row shape; the Desktop re-exports it the way it already
  re-exports `coreSessionToIpcRow`. The mailbox and plugin setup APIs are each
  built once and shared by the HTTP surface and the bridge.
- Verification, all from the worktree root:
  `npx vitest run packages/host/tests/worker-db-bridge-{mailbox,plugin-setup,plugin-registry}.test.ts`
  → 17/17; `npm run typecheck:all` → exit 0; `npm run architecture:check` →
  exit 0 (2622 tolerated, no new violations); `npm run bundle:verify` → FRESH
  0/919; the desktop adapter suites → 126/126. The full
  `packages/host/tests` run had one failure,
  `worker-hooks/events.test.ts`'s `toBeLessThan(500)` wall-clock assertion
  (measured 521 ms) — a load-dependent flake in a file this cut does not
  touch; isolated re-run of that file together with `executor.test.ts` was
  57/57.
- Known gaps left open, each its own migration surface. The real count is
  **20** worker-used actions still missing from the bridge, not the 9 the PR
  body first claimed (that list came from a regex that missed multi-line
  client definitions; a line-by-line rescan of the worker call sites is the
  reliable count). This branch now covers 11 of them — the workflow run
  domain (create / updateStatus / finish / saveSnapshot / loadSnapshot /
  appendJournal / loadJournal), `turn-review:save`, `attachment:store` and
  the three `sendMessageState:*` writes. The session domain (see the third
  cut below) took `session:create` and `session:search`; **7 are left**:
  - `config:agents:create` / `config:agents:update` — the write side of
    `config.toml`'s `[agents.*]` still lives in
    `apps/desktop/src/main/config/agents.ts`; it has to move into packages.
  - `automation:cron:create` / `delete` / `list` / `update` — the Host has
    no automation API yet.
  - `channel:deliver` — outbound platform delivery, a gateway concern
    rather than a bridge one.
- The `sendMessageState:*` writes are best-effort by contract: the Desktop
  bridge swallows the store error and answers with a soft failure. The
  standalone Host keeps that contract, but the "the Host has not composed
  this API" failure stays OUTSIDE that catch — a misconfigured Host must
  fail fast and name the missing domain instead of looking like a store
  hiccup. The first draft of that case had the `require` inside the try,
  and the test caught it.
- CI run 40066793619 (head `3941cbad`): `architecture`, `typecheck` and `build`
  green; the `test` job red with **every affected test green** (82 files, 668
  passed, 6 skipped) plus one `Uncaught Exception: ENOENT ... /tmp/duya-cron-test-*/logs/app.log`
  originating in `apps/desktop/src/main/cli/handlers/crons.test.ts`. That is the
  known desktop logger defect fixed by PR #397 (`e269c53e`), which was still
  OPEN and CONFLICTING against master on 2026-10-24 — so every PR touching
  `packages/host/src` or `packages/data/src` hits it. This branch cherry-picks
  `e269c53e`; once #397 lands, one of the two copies can be dropped, since the
  content is identical and will not conflict.
- CI run 40067527772 (head `1bbd8844`): **all five jobs green** — `architecture`,
  `test scope`, `typecheck`, `test`, `build`. The cherry-pick removed the
  unhandled exception; the local CI-equivalent scope
  (`npx vitest run --changed=origin/master --maxWorkers=2`) was 210 files /
  2128 cases with 2119 passed and 9 skipped, exit 0.
- CI run 40068101938 (head `ca0eaee7`) and run 40069474501 (head `0bc45679`):
  **all five jobs green** — the workflow-run cut and its bundle reached
  master-base CI without a red job.

## Third cut — the session domain (`7a3ae41b`, `571540a8`)

The session domain was the next worker-facing surface that the standalone
Host did not serve, and the first one where the Host answered with the
WRONG SHAPE rather than with nothing:

- `session:create` — not served. The worker writes it when it spawns a
  sub-agent (`worker-subagents/service.ts`), so on the standalone Host the
  child session row never existed. The write is wrapped in a `catch` that
  only warns, so the run continued as if the row had been created.
- `session:search` — not served. The session-search tool
  (`worker-tool-services/session-search.ts`) then answered "no session
  matched" for every query.
- `session:list` — served, but with the raw core rows (`parentSessionId`,
  `workingDirectory`). The worker reads the legacy `parent_id` /
  `working_directory`, so its parent map was empty and the recent-session
  list was blank. The Desktop bridge answers the same action with
  `coreSessionToIpcRow` rows.
- `session:listByWorkingDirectory` — not served, although the worker client
  exposes it.

What the cut does:

- The bridge serves `session:create` (permission profile resolved through
  the Host session API, the working directory registered as a workspace, the
  spawn edge recorded), `session:search` (rows plus the matched snippet)
  and `session:listByWorkingDirectory`, and answers `session:list` in the
  legacy row shape by paging the local-session API.
- `ipcSessionToCoreCreate` moved to `@duya/host/ipc-row-adapters`; the
  Desktop re-exports it, the same way it re-exports `coreSessionToIpcRow`.
  Both bridges now map the same flat payload with one implementation.
- `local-host.ts` builds the local-session API once and shares it between
  the HTTP surface and the bridge, and passes the workspace registration
  API that the create path needs.
- A missing Host API fails fast and names the domain
  (`unimplemented_domain`), the same contract as the other cuts.

Verification, all from the worktree root:
`npx vitest run packages/host/tests/worker-db-bridge-session.test.ts` → 9/9;
the whole `packages/host/tests` run → 183 files / 1675 passed / 1 skipped,
exit 0; the nine `worker-db-bridge-*` files → 48/48; the Desktop adapter
suites (`core-db-adapters`, `db-handlers`) → 75/75;
`npm run typecheck:all` → exit 0; `npm run architecture:check` → exit 0
(2648 tolerated, no new violations); `npm run bundle:verify` → FRESH 0/919.

- Next action: review PR #420 and, once authorized, integrate it. PR #381
  (`codex/tui-perf-benchmark`) is still CONFLICTING with master — it needs the
  same authorization to sync master and rebuild its bundle before it can be
  integrated. Note that PR #381's head commit `08f8de89` has no check run at
  all (the last green run, 40063606946, covers `404103eb`); syncing master will
  re-trigger CI for it.
- The next worker surface after this one is the `[agents.*]` write side of
  `config.toml`, which still lives in
  `apps/desktop/src/main/config/agents.ts` and has to move into packages
  before `config:agents:create` / `config:agents:update` can be served.
  The automation (cron) API does not exist in the Host at all yet.
