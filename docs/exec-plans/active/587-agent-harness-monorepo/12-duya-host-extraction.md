# 12 — Duya Host extraction and old-agent retirement

> Status: Active — user-directed architecture objective, 2026-10-11.
> This is an execution slice under plan 587, not a second architecture queue.

## Objective

Make Duya Headless-first and Local-first: one Electron-independent Host owns
Control Plane services, Worker lifecycle, and durable application data. CLI,
Desktop, and later Web are clients of that Host. The CLI may also compose the
same Host in-process for a standalone task. CLI and Desktop must execute runs
without importing the legacy `@duya/agent` package.

## Decisions

- Default user data root: `~/.duya` on every platform.
- Default databases: `~/.duya/duya-main.db`, sibling `duya-core.db`, and
  `memory-state.db`.
- Preserve explicit `storage.database_path` overrides.
- Migrate the prior Electron default database set into `~/.duya` without
  deleting the source. If migration fails, fail startup rather than silently
  opening a new empty database.
- One Host owns a data root and its SQLite handles/migrations. Workers use
  typed Host services; they do not open the application databases.
- Existing `agent-protocol`, `agent-core`, and `agent-runtime` remain the
  execution boundaries. Move host assembly and adapters out of Electron and
  the legacy `packages/agent` facade incrementally; do not rewrite the engine.
- Desktop supervises the local Host. CLI connects to it by default and can
  compose the same Host for standalone execution. Web/remote auth follows only
  after the local Run API is stable.

## Slices

1. **Data root** — resolve the default under `~/.duya`; safely migrate the old
   default DB files, including SQLite WAL/SHM companions; retain custom paths
   and test namespaces; prove the destination and migration behavior.
2. **Host-owned data** — move path resolution, SQLite construction, migrations,
   and domain stores behind an Electron-free Host/Data interface. Keep Main as
   an adapter until all consumers use the Host contract.
3. **Host process and Run API** — compose Control Plane, Worker Manager,
   Runtime, and durable stores outside Electron. Expose versioned health,
   session, run, cancellation, approval, and replay contracts over HTTP/SSE;
   keep IPC as a Desktop adapter where useful.
4. **CLI and Desktop cutover** — `duya serve` manages the Host; `duya chat`
   connects to it; standalone CLI uses the same composition; Desktop starts and
   supervises it. Prove all three paths use the same Run and persistence
   contracts.
5. **Retire legacy agent dependency** — move remaining production capabilities
   and assembly to their owning packages, remove `@duya/agent` from CLI/Desktop
   runtime dependency graphs, then delete compatibility exports when the
   consumer inventory is zero.

## Next implementation gate

The first standalone Host composition now opens `DatabaseHost`, `CoreDataHost`,
and the legacy importer outside Electron, then serves session/timeline, task,
and the first durable Agent Run ledger APIs over authenticated loopback HTTP.
`duya serve` starts that composition, and session and chat CLI paths can use it.
CLI chat now creates a Host Run row before dispatch and writes Runtime events
and the terminal through Host, but its executor still runs in the CLI process
through the legacy Agent package. Desktop Agent Server now sends every `run:*`
operation through the same Host Run API after Control Plane sender
authorization. The Desktop listener is still composed in Electron Main over
Main-owned handles. This is not independent Desktop Host ownership or shared
execution.

The shared `DatabaseHost` per-file owner lease already refuses a second process
opening either database. That is a useful safety invariant, not a Host
supervisor: Desktop still opens the handles in Electron Main and publishes an
HTTP adapter over those same handles. Do not start a second Host beside Main or
remove the lease to make that appear to work.

Use these gates in order:

1. **Finish the database caller cutover by domain.** Keep adding only the typed
   Protocol/Data/Host operations needed to remove an existing direct database
   caller. Migrate both Desktop IPC and Agent DB bridge callers in the same
   domain, then remove their synchronous `getDatabase()` / `getCoreStores()`
   dependency. Do not tunnel arbitrary SQL or hide asynchronous calls behind a
synchronous proxy. CLI and Desktop Agent Server now share the typed Host Run
API for all `run:*` commands. Continue the remaining CoreStores domains; Main
still owns the database handles, Control Plane composition, and Worker Manager.
2. **Move database startup and ownership.** Once Desktop startup and production
   callers no longer open either application database, move `DatabaseHost`,
   migrations, and the Host listener into the independent process. Desktop then
   supervises or attaches to that process and waits for its authenticated health
   endpoint before exposing client adapters. The owner lease remains the
   cross-process guard.
3. **Move execution ownership.** Compose Worker Manager and Control Plane in
   Host around the existing `@duya/agent-runtime` engine. The authenticated Run
   API now supports create, get/list, durable append, terminal settlement, and
   paginated event reads. `watchAgentRunEvents` now replays durable events over
   SSE with sequence IDs and reconnect cursors; durable sequences may skip
   non-durable events, and Host shutdown closes active streams. The API still
   does not start/cancel/attach to a Host-owned worker or resume a run. Add
   those operations with the production Worker Manager move.
   Extract provider, tool, and context adapters from `DuyaAgent`; do not replace
   the engine with a second turn loop.
4. **Cut clients over.** CLI chat currently opens or reuses the authenticated
   local Host for sessions and Run persistence, while the Agent executor remains
   in the CLI process. Make `duya chat` a Host Run API client by default and
   retain an explicit standalone composition of the same Host/Runtime contracts.
   Desktop must supervise the independent Host and use the same execution and
   data APIs. Only after these local paths share the contract should Web/remote
   auth, Workspace scoping, and approval forwarding be enabled.

The CLI control-plane package already speaks HTTP, but the chat CLI and Desktop
Agent Server still assemble production runs through `packages/agent`. Keep that
legacy dependency until the Host Run API has a real production Worker Manager
caller; a package diagram or compatibility adapter alone does not pass this
gate.

### Desktop database cutover constraint (source inventory, 2026-10-12)

The 2026-10-11 CodeGraph inventory found 74 production callers of
`getDatabase()` and 81 of `getCoreStores()`. Those exact call counts are now
historical. A 2026-10-12 source scan finds references in 30 production files
for `getDatabase()` and 21 for `getCoreStores()` at that earlier checkpoint;
that is a file count, not a caller count, and includes compatibility references
that need classification.
These are synchronous Main-process accessors, while an independent Host
boundary is asynchronous. Do not tunnel arbitrary SQL over HTTP or make a
proxy that hides asynchronous calls behind a synchronous shape. Migrate by
domain: define typed async query/command contracts in Protocol, implement them
over Data stores in Host, switch Desktop IPC and Worker DB bridge callers to a
Host client, and remove that domain's direct database access. Keep the
compatibility facade only for domains whose callers have not moved. The Host
may claim the shared data root only after Desktop startup no longer opens any
database file owned by that Host. The current session/timeline APIs are useful
first domains, but their Desktop listener still runs in Main and therefore does
not pass this cutover gate.

The session/timeline contract is client-safe and now preserves IDs, extensions,
parent/all/deleted queries, create-as-upsert, and updates without a precondition.
`@duya/data` owns the Workspace tables, migration, identity mapping, and path
resolver; Host resolves workspace/root IDs plus a relative path. Desktop
create/update/delete IPC now uses this service: local session creation and
working-directory changes register the selected directory through Host, then
write using an opaque Workspace reference. Metadata/extension updates, soft
deletes, and timeline appends also go through Host. Worker unregistered-path
changes and creates still use the compatibility store. Desktop get/list now use
Host for session selection and filtering, then the local IPC adapter rehydrates
legacy path/archive fields from Data rows.
`db:message:getBySession`, `session:loadMessages`, and the bot-direct
source-filtered transcript now read the projected message/compaction history
through Host. Desktop's session IPC now registers a local directory through
Host before create or working-directory update, then writes the session using
an opaque Workspace reference. Worker unregistered-path create/update and
project grouping/cron history still read or write through compatibility stores.
Parsed-document attachment read/write paths are now routed through the local
Host API; this remains a partial domain migration, not the database-owner
cutover.
The Desktop CLI's message list/show/count endpoints now use
`HostSessionApiV1.readMessages` and `countTimeline` rather than reading
`CoreStores.messageLog`. The CLI's numeric `offset` contract is preserved by
walking Host cursors and applying the existing full-history projection before
building the legacy DTOs. Room transcript reads, room session creation,
user-post appends, turn notices, and group-history reads now use the async Host
session API; the room-turn queue awaits notices before reading history. Mailbox
IPC, Agent DB bridge, wake, and agent-DM callers likewise use the typed Host
mailbox contract; the Control Plane's repository remains a Host-internal
Data-store caller.

Next, finish the session domain: Desktop session create and working-directory
updates now register locally selected directories through Host and write via
opaque Workspace references. Remaining Worker-side unregistered raw-path
create/update and direct Data reads/writes still use compatibility stores.
The Desktop CLI control-plane session create/list/show/import handlers now use
the authenticated Host session API; search uses a Host-scoped message query and
Host message reads to preserve legacy role/type matches, while export reads
through the Host message projection and local session projection. This removes
the CLI session handlers' direct `CoreStores` reads, but does not remove the
remaining Worker/Data compatibility paths below.
Archive/unarchive now run through the Host API, including
subtree lock preflight, rollout-file moves, and row/cache updates. Common
Worker session CRUD, bot session materialization, child-session
listing/metadata actions, and missing-session
creation before transcript append now use the Host HTTP API. Child sessions
with a registered Workspace also create through Host; unregistered raw-path
children still use the compatibility store. The IPC adapter rehydrates legacy
row fields from Data after Host reads, and project grouping/cron history still
have direct Data reads. Then continue the typed async domain cutover for
Desktop's direct CoreStores callers; the inventory still includes dozens of
synchronous Main callers, so the HTTP listener cannot claim the database while
they remain.
After Desktop no longer opens either application database, move the Host
listener and `DatabaseHost` into the independent process, make Desktop
supervise/connect to it, and add the durable Run API plus Host-owned Worker
Manager. The current CLI chat and Desktop Agent Server still execute through
legacy `DuyaAgent`; retire that dependency only after those production callers
use the shared Runtime composition.


## Completion evidence

- Host starts and serves a run without Electron or a renderer, with Host-owned
  Worker Manager execution; a durable ledger endpoint alone does not satisfy it.
- CLI-connected, standalone CLI, and Desktop runs persist and replay the same
  session/run/event semantics through Host-owned stores.
- Only Host opens/migrates the application SQLite databases; Worker and client
  packages have no database handle or Electron import.
- `~/.duya/duya-main.db` is the default active path; old default data is
  preserved and migrated; explicit database paths remain honored.
- Production CLI and Desktop dependency graphs contain no `@duya/agent` edge.
- Required package typechecks, architecture gates, targeted migration tests,
  and real Desktop/CLI smoke paths pass with scoped results recorded here.

## Current progress — 2026-10-11

- [x] Slice 1: added Electron-free `@duya/data` root/path resolution and safe
  copy migration for the old main/core/memory-state database set, including
  SQLite WAL/SHM companions. The source database files are retained.
- [x] Desktop config boot, database path resolution, startup migration, and
  memory-state path resolution consume `@duya/data`.
- [x] Aligned database-health, packaged-canvas repair, and database probe
  scripts with the shared `.duya` data root and `DUYA_DATA_ROOT` override.
  Their CommonJS resolver mirrors test namespaces; syntax checks and three
  default/override/namespace cases pass. No old platform-specific default DB
  path remains in the JavaScript maintenance scripts.
- [x] First data ownership extraction: `@duya/data` owns the reusable
  `CoreDatabase` connection/migration runner/WAL checkpoint and the durable
  `RunStore` (`runs` + `run_events`). Desktop keeps compatibility re-exports;
  the current Control Plane caller still constructs the store through its
  existing CoreStores composition.
- [x] Moved the Electron-free Task, PermissionLedger, Lock, Goal, SpawnEdge,
  Attachment, ModeState, Session, Mailbox, Project, Research, Conductor, and
  PendingWake durable store implementations into `@duya/data`. The old Desktop
  import paths for these modules are compatibility exports, so existing
  CoreStores callers still resolve. `@duya/data` now constructs these stores through
  `createCoreDataStores()` and owns their sorted migration collection; Desktop
  composes that result with MessageLog and WorkflowRunStore.
- [x] Moved the shared session todo `Task`/`TaskStatus` contract to
  `@duya/agent-protocol`; the old `@duya/agent` store and public barrel
  re-export it for compatibility. Desktop renderer components now import the
  contract from protocol, and its `@duya/agent` root TypeScript alias is gone.
- [x] Verification: data package build and typecheck pass; 6 data-path tests
  pass; 29 RunStore reopen/migration/idempotency tests pass through the
  Desktop compatibility entrypoint; full `electron:build` passes, including
  all workspace bundles, Vite renderer, and Electron packaging bundle. The
  protocol and legacy agent packages build, and Desktop renderer typecheck
  passes after the Task contract move.
- [x] New store move verification: `npm run -w @duya/data build` passes after
  moving these store implementations. Desktop Main typecheck remains red with
  the repository's existing error backlog; filtered output had no diagnostics
  in the moved-store shims or the changed CoreStores composer. The architecture
  gate still reports only the 9 existing dirty `@duya/agent -> @duya/agent-core`
  edges; no new data-package boundary violations were added.
- [x] Added `openSqliteDatabase()` to `@duya/data` and routed both the Desktop
  `duya-main.db` opener and `CoreDatabase` through its shared directory, WAL,
  timeout, and foreign-key setup. The Desktop singleton, schema, migrations,
  and shutdown lifecycle remain in Main.
- [x] Moved ToolApproval and SendMessage side-state persistence into
  `@duya/data`; Desktop's old module paths now re-export those stores so Main
  IPC and schema callers remain compatible.
- [x] Moved Workbench data-source and handler persistence into `@duya/data`;
  its row/config types now come from the data package while Desktop keeps the
  renderer broadcast contract and conductor service.
- [x] Moved the `duya-main.db` schema and numbered migrations into
  `@duya/data/main-schema`. Desktop keeps its schema import path as a
  compatibility adapter and injects its logger plus plugin connection-slug
  derivation port.
- [x] Added `MainDatabase` in `@duya/data` to own the `duya-main.db` handle,
  schema initialization/self-check, WAL checkpoint, and close semantics.
  Desktop now uses that owner; path resolution/validation, safe mode, the
  process-wide accessor, and shutdown coordination remain in Main.
- [x] Current verification: `npm run -w @duya/data build` passes. The full
  architecture scan reports no `@duya/data` boundary violations; it remains
  red on the same 9 dirty `@duya/agent -> @duya/agent-core` edges. Filtered
  Desktop Main typecheck still exits 2 on unrelated existing errors in
  `src/main/config/schema.ts` (lines 637 and 647). `MainDatabase` passed an
  in-memory open/schema/checkpoint/
  close smoke; the Data path suite plus Desktop database-path and slug-migration
  suites passed (19 tests).
- [x] The standalone chat CLI's legacy database path resolves under the same
  `~/.duya` root, including the existing namespace and environment overrides.
- [x] Moved the durable message-timeline type contract to the
  `@duya/agent-protocol/message-timeline` subpath and re-exported it through
  the legacy agent message facade for compatibility. `@duya/data` now owns
  MessageLog, rollout-event parsing, rebase projection, search, and crash
  repair. Desktop's old module paths are adapters that inject logger and bot
  path ports; Main still composes the store.
- [x] Verification for this extraction: protocol, Agent, and Data package
  builds pass; six existing focused MessageLog/rollout suites pass (77 tests).
  Filtered Desktop Main typecheck reports no diagnostics in the migrated files;
  the full Main typecheck still fails on the repository's existing migration
  backlog. The architecture scanner reports no Data boundary violations; it
  still exits 1 on the same 9 dirty `@duya/agent -> @duya/agent-core` edges.
- [x] Moved `WorkflowRunStore`, its migrations, and its construction into
  `@duya/data`. `JournalRecord` now has a shared protocol contract; the old
  Desktop store path remains a compatibility export. `createCoreDataStores()`
  now constructs workflow runs alongside the other durable stores.
- [x] Verification for the WorkflowRunStore move: protocol, Data, and Agent
  builds pass; the workflow store and handler suites pass (29 tests). Desktop
  Main typecheck remains red on the repository backlog, with no diagnostics
  in the moved store or its composition caller. Architecture scan still reports
  the same 9 dirty `@duya/agent -> @duya/agent-core` edges and no new
  Data/Protocol boundary violation. The migration-30 fixture was corrected to
  apply later schema migrations before exercising current writes.
- [x] Moved archive path policy and the legacy archived-row recovery migration
  into `@duya/data`; Desktop keeps compatibility exports and supplies its
  structured logger through a Data logger port.
- [x] Verification for archive recovery extraction: Data build passes; archive,
  workflow-store, and workflow-handler suites pass (42 tests). Filtered Desktop
  Main typecheck has no diagnostics in the moved modules or their caller.
  Architecture scan still reports only the same 9 dirty Agent-to-Core edges.
- [x] Added `CoreDataHost` in `@duya/data` to own the `duya-core.db` connection,
  migration ordering, `MessageLog`, archive-row recovery, and core store
  composition. Desktop Main starts that owner and retains its legacy import
  startup invocation and compatibility accessors around it.
- [x] Verification for `CoreDataHost`: Data package build passes; the focused
  reopen test passes (1 test); standalone chat CLI `--help` starts; full
  `electron:build` passes. Desktop Main typecheck still has the known broad
  backlog, with no diagnostics in the changed core connection or MessageLog
  adapter. The architecture gate remains red only on the same 9 dirty
  Agent-to-Core profile migration edges.
- [x] Unified Desktop CLI API discovery on the shared Data root:
  `runtime/cli-api.json` is written under `~/.duya` (or `DUYA_DATA_ROOT`) for
  normal runs, and `@duya/cli` probes that location before legacy Electron
  `userData` paths. Explicit CLI overrides remain supported; test runs stay
  isolated. CLI build and the focused runtime-config test pass; full
  `electron:build` passes. Architecture check now reports only the same 9
  existing dirty Agent-to-Core edges, with no new CLI-to-Data violation.
  Desktop Main typecheck remains red on its existing backlog, with no
  diagnostics in the changed runtime-config module. The current API is still
  Desktop-hosted, so this is service discovery alignment rather than the
  standalone Host cutover.
- [x] Added `DatabaseHost` to `@duya/data` to own the main/core database
  instances and their checkpoint/close lifecycle. Desktop's database modules
  now act as compatibility/composition adapters over one shared owner, and
  graceful shutdown closes the handles through that owner. Desktop still owns
  path resolution/validation, safe mode, legacy import startup invocation, rollout relocation,
  and shutdown ordering; CLI does not compose `DatabaseHost` yet.
- Verification for the `DatabaseHost` migration: `npm run -w @duya/data build`
  passes; Desktop Main typecheck exits 2 on its existing broad backlog, with
  no diagnostics in the changed database adapters, host, or shutdown module.
  `architecture:check` remains red on the 9 dirty Agent-to-Core edges and a
  sandbox `EPERM` in its core-io scanner; it reports no new DataHost boundary.
- [x] Added the protocol-only `HostSessionApiV1` async contract for session
  metadata and the append-only durable timeline. The wire union now includes
  message, compaction, and rollout events from the existing JSONL format;
  retries rely on stable entry IDs, matching `MessageLog.appendBatch` rather
  than promising an operation ledger or compare-and-swap replacement that the
  current store does not implement. Protocol and Data builds pass.
- [x] Added Electron-free `@duya/host` session service over injected Data
  session and MessageLog stores. Desktop CLI `POST /v1/sessions/import` now
  creates the session and appends its timeline through `HostSessionApiV1`.
  This is still a Main-process composition: the route remains Desktop-hosted,
  and it constructs the service from `getCoreStores()`; there is no standalone
  Host process or Host-owned HTTP listener yet.
- [x] Routed the Desktop Agent Server message `add` / `append` / `replace`
  bridge actions and renderer `db:message:add` / `replace` writes through
  `HostSessionApiV1.appendTimeline`. Batch append preserves its explicit
  `turnId` in the Data index; append receipts use indexed count/max-sequence
  queries rather than rescanning the full timeline. This is a service-boundary
  migration only: Main still supplies the stores, Data `MessageLog` remains
  the underlying writer, and other direct database writers remain.
- [x] Routed Agent Server and renderer timeline-count reads through
  `HostSessionApiV1.countTimeline`, preserving the existing zero result for an
  empty or unknown session.
- [x] Routed Desktop CLI `GET /v1/sessions` and `GET /v1/sessions/:id` through
  `HostSessionApiV1`. The list service supports offset compatibility and
  archived-session inclusion, and returns indexed timeline counts with each
  page item. CLI response fields and pagination validation remain unchanged.
- [x] Moved the pure persistence-message ingest codec from `@duya/agent` into
  `@duya/agent-protocol`, retaining the old `@duya/agent/message` re-export.
  Moved the read-only legacy core importer into `@duya/data`; Desktop keeps a
  compatibility export and still controls startup ordering and the source path.
  Data and Protocol build, and the Agent compatibility build passes. The
  targeted Vitest invocation was blocked before collection by the existing
  Windows `realpath` `EPERM`; no tests ran.
- [x] Moved message-origin classification and direct/group source filters into
  `@duya/agent-protocol/message-timeline`. Desktop IPC adapters, session-fork,
  and group-history callers now import the Protocol contract directly;
  `@duya/agent` keeps its compatibility re-export. Protocol and Agent builds
  pass. Desktop Main's full typecheck remains red on the existing backlog; the
  filtered run found no errors for the moved Protocol imports and still reports
  the unrelated `session-fork.ts` `rolloutLineTimestamp` error. No tests were run.
- [x] Interactive REPL/TUI and one-shot `-t`, `--print`, and `--headless`
  execution now create sessions and append transcript turns through
  `@duya/cli/host-session` and `HostSessionApiV1`. The chat CLI connects to the
  authenticated runtime descriptor published by Desktop, or starts the same
  local Host composition when no Host is running. Stable message IDs make
  repeated appends idempotent; compaction rebases are emitted when a transcript
  drops prior messages and retains a compaction summary. Session title updates
  use the Host API's `updatedAt` precondition. A headless script uses one
  session across its prompts. Writes happen at prompt/turn boundaries, not
  during streaming, and all execution still happens in the CLI process through
  legacy `DuyaAgent`; this is not a Run API.
- [x] CLI chat registers the explicitly selected launch directory through the
  authenticated loopback Host before creating a session. Host creates or reuses
  a writable Workspace root and the CLI sends only the opaque Workspace
  reference to session creation. This registration operation is not available
  on a remote Web surface.
- [x] Desktop session create and working-directory updates register the local
  directory through the authenticated loopback Host before writing. The Host
  resolves an existing binding or grants a verified directory as a Workspace;
  the session API receives only workspace/root/relative-path IDs. Renderer IPC
  return rows retain their legacy shape through local Data rehydration.
- Verification for Desktop Workspace-backed writes (2026-10-12):
  `npm run -w @duya/desktop typecheck:main` exits nonzero on the existing broad
  Main-process backlog; filtered output has no diagnostics in
  `db-handlers.ts` or `desktop-host-api.ts`. `git diff --check` passes for the
  changed source and plan files. No tests or Electron runtime smoke were run.
- [ ] Agent Worker creation/update under an unregistered path still falls back
  to direct local stores because those call sites do not carry an explicit user
  grant signal. Agent tools using other legacy persistence facades also remain
  outside Host services.
- [ ] Desktop still owns the compatibility database accessors, process-local
  `DatabaseHost` composition, path policy, safe mode, rollout relocation,
  memory-state migrations, and shutdown ordering. `duya serve` now composes a
  separate Host process over the same data root. A shared per-file owner lease
  now prevents concurrent opens through these `DatabaseHost` compositions, but
  Desktop does not yet attach to or supervise the active owner; the database
  writer cutover is incomplete.
- [x] Added an Electron-free local Host bootstrap that resolves the shared data
  root, preserves the old Electron database copy/import path, opens main/core
  databases, starts the authenticated loopback session/timeline server, and
  writes a runtime descriptor plus exclusive process lock. Added `duya serve`
  and Host-backed `duya session create/list/show` discovery.
- [x] Verification for the local Host slice: Host and CLI TypeScript builds
  pass; `build:cli-bundle` passes; an escalated local-loopback smoke created a
  session in a separate CLI process, restarted Host, and read the same session
  back from SQLite. Sandbox-only execution returned `EACCES` on `127.0.0.1`;
  the same smoke passed with loopback access. This does not verify Desktop
  supervision, Run API, worker execution, or single-writer behavior.
- [x] Added a per-database owner lease to the shared `DatabaseHost` used by
  Desktop and standalone Host. A second composition fails closed while the
  owner process is live; a stale lease is reclaimed only when its same-machine
  PID is confirmed dead. Unknown, malformed, or foreign-machine lease records
  fail closed. Data and Host package builds pass. This prevents two current
  `DatabaseHost` compositions from opening the same file, but Desktop still
  needs to attach to or supervise the owner instead of opening its own handles.
  Data and Host builds pass; a cross-process smoke verified live-owner refusal,
  reacquisition after release, and recovery after the owner process exits. The
  restricted shell denied native `realpath` with `EPERM`, so lock identity now
  falls back to normalized absolute paths only for that error.
- [x] Desktop now publishes the same authenticated Host session API and
  `runtime/host-api.json` descriptor used by `duya serve`, composed over its
  existing `getCoreStores()` handles. CLI session create/list/show therefore
  use the same `HostSessionApiV1` HTTP contract with either Desktop or the
  standalone Host. This is a protocol convergence step only: the listener is
  still inside Electron Main, and Main still owns the database handles.
- [x] Added explicit `@duya/host` build-output aliases to the agent bundle
  because the legacy chat CLI imports the Host-backed CLI session commands.
  Package builds, the agent bundle, and the Desktop CLI bundle complete.
- [x] Moved `RunIntent`, `BuiltRun`, and `buildRunManifest` into the
  Electron-independent `@duya/host/manifest-factory` subpath. The Agent Server
  Run Orchestrator now imports the Host package directly; the former Desktop
  module remains a compatibility export. Host build passes. Desktop Main
  typecheck still exits 2 on the existing backlog, with no diagnostics in the
  changed Run Orchestrator or compatibility module. `architecture:check` still
  reports the dirty Agent-to-Core profile edges and fails its core-io scan on
  temporary-file `realpath` `EPERM`; it reports no Host boundary finding.
- [x] Moved the production `RunOrchestrator` and worker execution-channel
  adapter implementation into `@duya/host/run-orchestrator`. Agent Server now
  injects its DB bridge, worker channel, and logger; the old server path is a
  compatibility re-export. This is a source-ownership move only: Desktop still
  constructs the orchestrator, and standalone Host still has no run executor.
  Verification (2026-10-12): Host build and `npm run typecheck:all` pass; the
  Electron ratchet has no new errors (245 known). `architecture:check` still
  exits 1 on its Windows Vite `realpath` `EPERM` and dirty-worktree boundary
  findings. No tests or live run were executed.
- [x] Moved the AI event-to-RunEngine `ModelPort` adapter module into
  `@duya/host/run-engine-model`. Production `run-composition.ts` imports the
  Host subpath directly; `packages/agent/src/process/run-engine-model.ts` is
  now a compatibility re-export. The Host package explicitly composes
  `@duya/ai` with `@duya/agent-runtime`; Runtime itself remains AI-free. This
  is an adapter ownership move: the production worker still constructs
  `DuyaAgent`, which supplies the client, context, and tool pipeline.
- [x] Moved CLI transcript normalization, stable-ID append selection,
  compaction rebase projection, and title updates into
  `@duya/cli/transcript-persistence`. The legacy chat entry calls this
  transport-only adapter and supplies the compaction-checkpoint suffix; the
  CLI package itself depends on Protocol and Host APIs, not `@duya/agent`.
- Verification for the adapter moves (2026-10-11): AI, Runtime, Host, Agent,
  and CLI package builds pass; `node scripts/build-agent-bundle.mjs` emits the
  Agent Server and chat CLI bundles after both moves. `architecture:check`
  exits 1 on the 9 dirty Agent-to-Core dependency edges and the existing
  core-io scanner `realpath` `EPERM`; it reports no Host or CLI boundary
  finding. No tests or live run were executed.
- Verification for this slice (2026-10-11): `@duya/host` build and `@duya/cli`
  build pass; Desktop Main typecheck reports no diagnostics in the changed
  files, but exits 2 on the existing broad Main backlog. `electron:build` builds
  all 17 packages, the agent bundle, and the CLI bundle, then stops in the
  unrelated gateway bundle with `Cannot read directory "../../node_modules":
  Access is denied.` No test suites or Electron runtime smoke were run.
- [ ] Desktop supervision, database writer cutover, and shared Run API/Worker
  Manager remain outstanding; CLI persistence is routed through Host, but
  CLI and Desktop still do not share Host-owned run execution.
- [ ] The Desktop Worker `chat:start` path now calls `driveRunWithEngine`, which
  constructs `RunEngineImpl` and executes the turn loop. This is the execution
  loop cutover, not retirement of the legacy package: the driver still requires
  `DuyaAgent` for run lifecycle, prompt-context production, transcript commit,
  tool/context/permission/compaction port assembly, and the live tool pipeline.
  The standalone chat CLI also constructs `DuyaAgent`; Electron and chat CLI
  builds still include `@duya/agent`. The remaining cutover is to move those
  mechanisms into Host/runtime-owned packages and route both clients through
  them so their production dependency graphs no longer include `@duya/agent`.
- Verification limits (2026-10-11): `npm run build:packages` passes for all
  17 workspaces, including Protocol → Data → Host. Desktop Main typecheck exits
  2 on the existing broad backlog; its diagnostics do not include the changed
  message bridge or IPC handlers. The targeted `db-handlers.test.ts` and
  `message-log.test.ts` suites fail before collection because Vitest cannot
  `realpath` `node_modules/vitest/dist/spy.js` (`EPERM`), so no tests ran.
  The follow-up protocol and Host builds pass, and a fresh Desktop Main
  typecheck still has no diagnostics at the changed message/count handlers.
  `architecture:check` exits 1 on nine dirty Agent-to-Core profile edges and
  the core-io scanner's temporary-file `realpath` `EPERM`; it reports no
  Host/Protocol/Data boundary finding. Earlier `node scripts/build-electron.mjs`
  could not finish because esbuild was denied access to `node_modules`; that
  attempt had cleaned `dist-electron` first.
- Verification for the interactive CLI persistence slice (2026-10-11):
  `@duya/cli` and `@duya/agent` builds pass; `node scripts/build-agent-bundle.mjs`
  completes and emits the chat CLI artifact with the Host-backed session
  connector. No tests or live HTTP write/reopen were run. This does not verify
  Desktop UI visibility, crash-time streaming persistence, workspace binding,
  or shared Run API execution.
- [x] Moved `ControlPlaneService`, `HostMap`, command and run receipts,
  repository ports, and the pure trusted-sender decision into Electron-free
  `@duya/host` public subpaths. Desktop Main now imports the Host contracts and
  service directly; old Desktop paths remain compatibility facades. The
  Desktop SQLite repository, `db:request` dispatcher, and worker process
  registry are still composed by Electron Main, so this does not yet move
  durable ownership or worker lifecycle to Host.
- Verification for the Control Plane ownership move (2026-10-11): Data and
  Host package builds pass. Desktop Main typecheck still exits 2 with 288
  existing diagnostics; none reference the moved Control Plane modules or
  Host subpaths. `architecture:check` reports no new Host boundary findings,
  and remains red on nine dirty Agent-to-Core edges plus the core-io scanner's
  `realpath` `EPERM`. No tests or Electron runtime smoke were run.
- [x] Moved `run:create`, `run:append`, `run:complete`, and run query action
  handling into `@duya/host/run-control-plane`, backed by an injected
  `RunRepository` and logger port. Desktop's production Control Plane now
  dispatches these actions through that Host service using its already-bound
  repository. The former Desktop `run-control-plane.ts` remains a compatibility
  adapter for legacy direct callers; no database handle is opened by Host code.
- Verification for the Host run-action move (2026-10-11): `@duya/host` build
  passes. Desktop Main typecheck exits 2 with 288 diagnostics, none in the
  changed Control Plane modules or new Host subpath. Architecture scan reports
  no new Host boundary violations; the existing nine Agent-to-Core edges and
  core-io scanner `realpath` `EPERM` remain. Tests and live run execution were
  not run.
- [x] Expanded `HostSessionApiV1` to preserve session IDs, project/status/draft
  fields, JSON extensions, direct-parent queries, all-session/deleted filters,
  create-as-upsert behavior, and updates without an `updatedAt` precondition.
  The Host service and authenticated HTTP client/server now carry those fields;
  pagination cursors are bound to their full filter set. Protocol and Host
  builds pass, and `@duya/cli` typecheck passes. At this checkpoint Desktop IPC
  still used its compatibility stores; the follow-on workspace and IPC routing
  work is recorded below. No tests ran.
- [x] Moved WorkspaceStore, workspace identity migration, lazy session binding,
  and path normalization into `@duya/data`; included workspace schema migration
  in the standalone Host's core migration collection. Host session create now
  resolves workspace/root IDs and a relative path without accepting a raw path
  over HTTP.
- [x] Routed pathless and known-root new-session creation, metadata/extension
  updates without a working-directory change, and soft deletes through
  `HostSessionApiV1`. Session get/list selection now uses Host as well; the IPC
  adapter rehydrates legacy row fields locally. Unregistered-root path
  creates/changes and those projection reads still use compatibility stores.
- Verification for workspace/session routing (2026-10-11): Data, Protocol, and
  Host builds pass. Desktop Main typecheck remains red on its existing broad
  backlog and emitted no diagnostics in `db-handlers.ts`; no tests or Electron
  runtime smoke were run.
- [x] Extended Host session creation to carry child-session spawn lineage
  (`type`, `reason`, and `turnId`) over the protocol and authenticated HTTP
  transport. Host records the idempotent spawn edge alongside the session
  create/upsert; Desktop no longer writes that edge separately on Host-backed
  creates. Unregistered raw-path compatibility creates retain their prior
  best-effort Data-store write until workspace binding is migrated.
- [x] Desktop session/timeline IPC and Agent Server bridge operations now use
  `HostSessionHttpClient` against the same authenticated loopback listener as
  CLI. Main starts that listener after CoreData is ready and before Agent
  Server startup; the later CLI API startup reuses the listener. Protocol and
  Host builds pass. Desktop Main typecheck still exits nonzero on the existing
  Main backlog (including untouched `db-bridge.ts` diagnostics); no errors were
  reported in the changed Host API adapter or IPC session handlers. This moves
  callers onto the shared transport, but the listener and database handles
  remain owned by Electron Main.
- [x] Added `HostSessionApiV1.readMessages` with stable Host pagination and the
  existing `includeSuperseded` behavior. Desktop's `db:message:getBySession`
  now reads this projection over the loopback client and converts it through
  the existing IPC row adapter. Bot-direct source filters now travel in the
  Host message query and are applied by `MessageLog` before pagination; its IPC
  adapter drains Host pages instead of reading the store directly. Agent
  Server's `message:getBySession` and `session:loadMessages` now use that same
  Host projection; parsed-document attachment reads remain in Main. Protocol
  and Host builds pass, and the CLI package typecheck passes. Desktop Main's
  full typecheck still fails on the existing backlog; the changed IPC files
  have no diagnostics. No tests were run.
- [x] Routed Agent Server Worker session CRUD and bot-session materialization
  through the Host HTTP client. Child-session listing and metadata actions now
  select through Host; registered-Workspace child creation and missing-session
  creation before `message:replace` also use Host. Unregistered raw-path
  creation/update remains on the compatibility store, and legacy IPC response
  fields are rehydrated locally. Project grouping and cron-history projections
  still have direct Data reads. The Session wire DTO now calls the stored
  `permissionMode` value a `SessionPermissionProfile` (`default | auto |
  full_access`), distinct from the Run API's `PermissionPolicyMode`, so HTTP
  validation preserves DB semantics.
- Verification for Worker session routing (2026-10-11): Desktop Main
  typecheck still exits nonzero on existing Main diagnostics. Protocol and Host
  builds and the CLI TypeScript check pass. The remaining `db-bridge.ts` errors
  are a nullable legacy database accessor and unrelated provider-config shape
  mismatches; there are no diagnostics in the changed Host session mapping
  blocks. `git diff --check` passes with existing CRLF normalization warnings.
  No tests were run.
- [x] Routed changes to a registered Workspace working directory through
  `HostSessionApiV1` using an opaque workspace/root/relative-path reference.
  Host resolves the path and transactionally updates the session row and its
  binding; clearing a working directory also clears the binding. An explicit
  local registration API now creates or reuses a Workspace root for CLI chat.
  Desktop/Worker unregistered-path writes remain local until those callers carry
  an explicit user grant signal.
- [x] Follow-up (2026-10-12): Desktop's local session IPC now uses the Host's
  local-directory registration endpoint for create and working-directory
  changes, then persists via the opaque Workspace binding. Worker raw-path
  compatibility writes remain unchanged.
- Verification for Workspace rebinding (2026-10-11): Protocol, Data, and Host
  builds pass; the CLI TypeScript check passes. Desktop Main typecheck remains
  red on the existing backlog (the changed session mapping block has no
  diagnostics; remaining `db-bridge.ts` errors are at the legacy database read
  and provider-config mapping). `git diff --check` passes with existing CRLF
  normalization warnings. No tests were run.
- [x] Added the local-only `HostWorkspaceRegistrationApiV1` and authenticated
  loopback endpoint for an explicitly selected absolute directory. Data
  canonicalizes and verifies the directory, then creates or reuses a
  `user_grant` Workspace root. CLI chat registers its effective working
  directory before creating a session, so CLI transcript persistence is now
  workspace-bound through the shared Host API.
- Verification for local Workspace registration (2026-10-11): Protocol, Data,
  Host, CLI, and Agent package builds pass. Desktop Main typecheck remains red
  on existing Main errors, with no diagnostics in the changed Host integration
  or workspace registration path. `architecture:check` remains red on the
  existing nine Agent-to-Core dependency edges plus the core-io scanner's
  temporary-file `realpath` `EPERM`; no new Host boundary finding was reported.
  No tests were run.
- [x] Moved the shared persisted Todo `Task` contract and `TaskStore` port into
  `@duya/agent-protocol`, added the authenticated Host task API over Data's
  durable task store, and routed CLI chat task operations through that API.
  Desktop serves the same API from Main's existing CoreStores; its Worker Todo
  path remains on IPC, so database ownership has not moved out of Electron.
- Verification for CLI task persistence (2026-10-11): Protocol, Data, Host,
  CLI, and Agent builds/typecheck pass. Desktop Main typecheck still exits 2 on
  its broad existing backlog; filtered diagnostics contain no errors in the
  changed Host task API/client, Desktop adapter, CLI task adapter, or Agent task
  store. `git diff --check` passes with existing CRLF normalization warnings.
  No tests or runtime smoke were run. CLI chat and Desktop Worker execution
  still use the legacy `@duya/agent` runtime.
- [x] Routed all Desktop Worker task bridge actions and Renderer `db:task:*`
  handlers through the authenticated `HostTaskApiV1` client. The Host task
  projection carries session/timestamp metadata needed by the legacy IPC row
  shape, and Host patch validation keeps nullable owner/active-form clears
  intact. Worker transport remains IPC, but Desktop task persistence no longer
  bypasses the Host API in Main.
- Verification for Desktop task routing (2026-10-12): Protocol and Host builds,
  plus Agent and CLI typechecks, pass. Desktop Main typecheck remains red on the
  existing broad backlog and reports no diagnostics in the new task bridge
  handlers or Host task-row adapter; unrelated `db-bridge.ts` diagnostics remain.
  No tests or Electron runtime smoke were run. Database handles and service
  listener are still owned by Electron Main.
- [x] Moved session archive/unarchive execution into the Electron-free Host
  session service and added authenticated HTTP routes. Host now owns subtree
  lock preflight, mirrored rollout-file moves, metadata rollback, legacy-file
  recovery, and rollout-path cache invalidation. Desktop IPC keeps its existing
  result shapes and calls the Host client; archived-session listing also uses
  Host selection. Both standalone and Desktop Host compositions pass their
  rollout root.
- Verification for Host archive routing (2026-10-12): Protocol, Data, and Host
  builds and CLI typecheck pass. Desktop Main typecheck remains red on the
  existing broad backlog; filtered diagnostics contain no errors in the
  changed archive/Host files. Architecture check remains red on the existing
  nine dirty Agent-to-Core edges and the core-io scanner's temporary-file
  `realpath` `EPERM`; no new Host boundary finding appeared. `git diff --check`
  passes. No tests or Electron runtime smoke were run. Database handles and
  the service listener remain owned by Electron Main.
- [x] Added a Desktop-only authenticated loopback `HostLocalSessionApiV1` for
  legacy IPC session projections. Desktop and Agent Server Host-backed
  session list/get/create/update paths now request `CoreSession` projections
  from Host instead of reading `sessions.get()` in Main. The standalone Host
  does not configure this route, and the public `HostSessionApiV1` remains
  path-free. Explicit unregistered-path compatibility paths and other direct
  session consumers remain to be migrated.
- Verification for local session projections (2026-10-12): `@duya/host` build
  passes. Desktop Main typecheck still exits 2 on its existing broad backlog;
  filtered output has no diagnostics in the changed projection handlers or
  Host adapter, while unrelated `db-bridge.ts` errors remain at lines 846,
  2136, 2138, and 2155. `git diff --check` reports pre-existing trailing
  whitespace in `AGENTS.md` plus line-ending normalization warnings. No tests
  or Electron runtime smoke were run. Main still creates the stores and owns
  the loopback listener, so the DB-owner cutover is incomplete.
- [x] Routed `db:message:add` readback through `HostSessionApiV1` after the
  Host append. This removes its remaining direct `MessageLog` read from the
  Desktop IPC handler; timeline truncation, fork, and delete still need Host
  operations before those paths can leave Main.
- Verification for the message-add readback cutover (2026-10-12): Desktop Main
  typecheck exits 2 on the existing broad backlog and reports no diagnostics
  in `db-handlers.ts`; scoped `git diff --check` passes. No tests or Electron
  runtime smoke were run. Electron Main still owns the stores and Host listener.
- [x] Routed Desktop timeline deletion and rewind reads through Host. The
  repaired/rebased projection now supports rewind and file restore; the IPC
  adapter restores file snapshots before appending an edit-resend rebase.
  Host timeline deletion clears the index while retaining rollout files, and
  append receipts return the number of newly indexed entries for bridge counts.
- [x] Fixed Workspace registration in the standalone ESM Host: `WorkspaceStore`
  used CommonJS `require()` to generate UUIDs, which failed at runtime. It now
  imports `randomUUID` from `node:crypto`.
- Verification for timeline and Workspace routing (2026-10-12): Data and Host
  builds and the CLI TypeScript check pass. An isolated loopback smoke passed
  local Workspace registration, bound session creation, idempotent timeline
  append, projected read, and index deletion; its temporary database was
  removed. Scoped `git diff --check` passes. Desktop Main's latest typecheck
  remains red on the existing broad backlog and had no diagnostics in the
  changed `db-handlers.ts` blocks. `architecture:check` remains red on the
  nine Agent-to-Core edges and the core-io scanner's temporary-file `realpath`
  `EPERM`; no baseline edits were made. No tests or Electron runtime smoke were run.
  Electron Main still opens the stores and owns the Host listener; other
  direct-store consumers, the Host process lifecycle, and the shared Run API
  remain unfinished.
- [x] Routed Desktop checkpoint forks through `HostSessionApiV1.forkAt`. The
  Electron-free Host reads the repaired source timeline, derives copied
  messages with fresh IDs, creates the child session, rebinds an existing
  Workspace grant, appends the seed, and records the fork lineage edge. The
  Desktop IPC adapter preserves its current response DTO.
- Verification for session-fork routing (2026-10-12): Protocol and Host builds
  and the CLI TypeScript check pass. A direct Host API smoke against an isolated
  SQLite store verified repaired-prefix seeding, fresh message/parent IDs,
  the child's `parentSessionId`, Workspace rebinding, and missing/archived-source
  rejection. The persisted spawn-edge row was not queried separately.
  The authenticated HTTP smoke could not connect to loopback in this sandbox
  (`EACCES`); no live Desktop/Electron smoke or unit tests were run. Desktop
  Main typecheck remains red on its broad existing backlog; the changed IPC
  handler has no diagnostic. The DB handles and Host listener still belong to
  Electron Main, so the database-owner and runtime cutovers remain incomplete.
- [x] Routed `db:rollout:reconcile` through `HostSessionApiV1`. Reconcile now
  rebuilds the `message_index` projection from the Host's configured rollout
  root; Desktop no longer calls `MessageLog.reconcileAll()` directly.
- Verification for rollout reconciliation (2026-10-12): Protocol and Host
  builds pass. A direct Host API smoke deleted a session's index rows and
  confirmed reconciliation restored one row from the durable JSONL file.
  Desktop Main typecheck remains red on the existing backlog; the changed
  handler has no diagnostic. HTTP loopback and Electron runtime checks remain
  unverified in this sandbox.
- [x] Routed local rollout import through `HostLocalRolloutApiV1`. Desktop IPC
  now sends restore/continue requests through the authenticated local Host
  transport, and standalone `duya serve` composes the same local capability.
  The Host keeps the path-bearing import surface local-only; a future remote
  API must accept uploaded data instead of server filesystem paths.
- Verification for rollout import (2026-10-12): Protocol and Host builds pass;
  Desktop Main typecheck remains red on the existing backlog and reports no
  diagnostic in `db-handlers.ts` or `desktop-host-api.ts`. An isolated SQLite
  smoke verified restore, duplicate continue idempotency, and 1-based invalid
  JSONL diagnostics returned as a Host 400. Authenticated HTTP/Electron smoke
  remains unverified because loopback sockets are blocked in this sandbox.
- [x] Routed `db:rollout:export` through `HostLocalRolloutApiV1` as well.
  Desktop IPC no longer obtains `MessageLog` to write a rollout export; local
  Host validates the destination directory and returns the existing export DTO.
- Verification for rollout export (2026-10-12): Protocol and Host builds pass.
  The isolated SQLite smoke covers import/continue and validation; export's
  transport route was typechecked with Host but not exercised over HTTP because
  loopback sockets are blocked in this sandbox.
- [x] Added `WorkflowRunApiV1` as a typed async Host contract and composed it
  from the shared Data store in standalone Host and Desktop's Host adapter.
  Protocol now owns the wire DTOs; Data re-exports the names from its legacy
  module path for existing consumers.
  Workflow-run DB bridge actions, workflow IPC reads/cancel writes, and startup
  crash reconciliation now go through the authenticated Host client instead of
  reaching into `getCoreStores().workflowRuns`.
- Verification for workflow-run routing (2026-10-12): Protocol, Data, and Host
  builds pass. Desktop Main typecheck still fails on the broad pre-existing backlog;
  filtered diagnostics show no errors in the changed workflow IPC or DB bridge
  cases. Existing workflow handler fixtures were adapted to the async Host
  contract, but unit and authenticated HTTP/Electron smoke tests were not run.
  Electron Main still opens the underlying DB and owns this listener, so this
  migrates the API boundary without completing Host process/database ownership.
- [x] Added `HostGoalApiV1` and moved session-goal DTO ownership into Agent
  Protocol. Data re-exports the existing goal types and implements idempotent
  per-session `getOrCreate`; Host composes the API for standalone and Desktop
  hosts, with authenticated HTTP/client routes for reads, creation, budget
  deltas, status changes, and status-filtered lists. Desktop IPC and Agent DB
  bridge goal actions now use the Host client and preserve the existing IPC DTO.
- Verification for goal routing (2026-10-12): Agent Protocol, Data, and Host
  builds pass. Desktop Main typecheck remains red on existing `db-bridge.ts`
  model/provider diagnostics outside the goal actions; no diagnostic was
  reported in the new Protocol/Data/Host goal surfaces or `db-handlers.ts`.
  Goal unit, authenticated HTTP, and Electron runtime checks were not run.
  Desktop Main still owns the SQLite handles and listener, so this migrates the
  goal API boundary without completing Host process/database ownership.
- [x] Added the typed `HostModeStateApiV1` contract. Agent Protocol owns the
  durable row and upsert DTO; Data re-exports the legacy row type; standalone
  Host and Desktop compose the same adapter and authenticated HTTP client.
  Agent `modeState:*` bridge actions and Desktop's cold-load mode snapshot IPC
  now use Host instead of accessing `CoreStores.modeState` directly.
- Verification for mode-state routing (2026-10-12): Agent Protocol, Data, Host,
  and Agent builds pass. Desktop Main typecheck remains red on unrelated
  `db-bridge.ts` null/model-provider diagnostics; filtered output has no errors
  in the mode-state, Host composition, or `db-handlers.ts` changes. Tests and
  authenticated HTTP/Electron runtime checks were not run. Electron Main still
  owns both database handles and this listener, so the data-owner cutover and
  legacy Agent runtime retirement remain incomplete.
- [x] Added Host-owned session and message search APIs. Session metadata and
  rollout-text search now execute in `@duya/host`; Desktop search IPC and Agent
  DB bridge calls use authenticated Host routes and keep their legacy result
  shapes through the local session projection.
- Verification for Host search (2026-10-12): Agent Protocol, Data, Host, and
  Agent builds pass. Desktop Main typecheck still exits 2 on the existing
  null/provider diagnostics in `db-bridge.ts`; filtered output has no errors
  in the changed search handlers or Host transport. The architecture scan
  could not realpath its temporary core-I/O entry and reported the existing
  Agent-to-Agent-Core boundary debt; no baseline changes were made. Search
  behavior tests and authenticated HTTP/Electron smoke checks were not run.
  Electron Main still owns the Host listener and database handles.
- [x] Moved child-session card persistence reads behind Host. The session row
  now comes from Host's local projection; `ChatTurnReviewStore` in `@duya/data`
  aggregates `chat_turn_reviews`, and Host exposes the typed stats endpoint.
  The cancel action still targets Desktop's existing runtime controller.
- Verification for session-card data (2026-10-12): Agent Protocol, Data, and
  Host builds pass. Desktop Main typecheck remains red on its existing broad
  diagnostics; filtered output contains no errors in the changed card handler,
  Host composition, or transport. No unit or runtime smoke was run. Main still
  opens the databases and owns the listener; Worker Manager remains in Desktop.
- [x] Added `HostPermissionRequestApiV1` for the durable interactive
  `permission_requests` ledger. Standalone Host and Desktop compose the same
  Data-backed service; authenticated HTTP/client routes now serve create, get,
  and resolve. Desktop permission IPC and the Agent DB bridge use the Host
  client and preserve the legacy snake_case row shape. This does not replace
  the distinct Run Protocol permission events or move the database owner.
- [x] Added `HostToolApprovalApiV1` for approval-card create/get/list,
  first-wins decision CAS, one-shot consume, and scoped grant rules. Standalone
  Host and Desktop compose the same Data-backed service; Desktop's Worker DB
  bridge and approval IPC now use authenticated Host HTTP. Existing row shape,
  CAS behavior, card broadcast, and continuation wake are preserved. This
  moves the API boundary, not the physical database owner.
- The Control Plane `ApprovalRepository` is now async and uses the same Host
  permission and tool-approval APIs; its SQLite binding no longer reaches either
  approval table. Desktop Main still creates the Host listener over its own DB
  handles. Move those handles and listener with Host-owned Run execution. The
  interactive request ledger and approval-card ledger remain distinct facts.
- Verification for permission-request routing (2026-10-12): Agent Protocol,
  Data, and Host builds pass. Desktop Main typecheck remains red on existing
  diagnostics; filtered output contains no diagnostics in the permission
  handlers, bridge branches, adapter, or Host transport. No tests or live
  HTTP/Electron smoke were run. Electron Main still owns the database handles
  and listener, and the broader runtime cutover remains incomplete.
- Verification for tool-approval routing (2026-10-12): Agent Protocol, Data,
  and Host builds pass. Desktop Main typecheck remains red on broad existing
  diagnostics; no errors point to the changed Host adapter, approval IPC, or
  async card resolver. `db-bridge.ts` still reports four unrelated errors at
  lines 858, 2042, 2044, and 2061. No tests or live HTTP/Electron smoke were
  run. Electron Main still owns Desktop's handles and listener, and Agent
  execution remains outside the independent Host.
- [x] Added `HostLockApiV1` and moved the durable `LockOrigin` contract into
  Agent Protocol. Standalone and Desktop Host compositions expose the same
  authenticated API; Agent DB bridge lock actions, renderer lock IPC, bot-send
  busy checks, and wake-dispatcher busy/preemption checks use the Host client.
  The in-memory turn epoch and pending-wake scheduler remain Desktop-owned.
- Verification for lock routing (2026-10-12): Protocol, Data, and Host builds
  pass. Desktop Main typecheck remains red on the existing broad backlog; the
  filtered output has no diagnostics in the new API, transport/composition,
  bridge, IPC, bot-handler, or wake-dispatcher changes. A source scan finds no
  remaining direct `LockStore` calls in Desktop Main. No tests or runtime HTTP/
  Electron smoke were run. Main still owns the listener and SQLite handles.
- [x] Routed Desktop CLI control-plane session create/list/show/import/search/
  export through authenticated Host session and timeline APIs. The bounded
  search filter preserves the current visible-session scope; Host message
  projections preserve role/type fields in the legacy CLI result, and the
  local session projection supplies the legacy export shape. These handlers no
  longer open `CoreStores` directly.
- Verification for CLI session routing (2026-10-12): Protocol and Host builds
  and CLI typecheck pass. Desktop Main typecheck remains red on the existing
  broad error backlog; filtered diagnostics contain no errors in the changed
  session handler, CLI router, Host client, or IPC adapter. Scoped diff check
  passes. `architecture:check` remains blocked by Windows `realpath` `EPERM` in
  the temporary core-I/O entry and reports existing dirty Agent-to-Agent-Core
  edges, with no new Host/Protocol finding. No tests or runtime smoke ran.

## Host extraction — durable Agent Run ledger API for CLI (2026-10-12)

Added `HostRunApiV1` for Agent Run creation, durable event append, terminal
settlement, and paginated event reads. The Host adapter uses Data's existing
`RunStore` idempotency, `(runId, seq)` conflict detection, and terminal CAS. The
authenticated loopback transport is exposed by both standalone Local Host and
Desktop's current Main-owned listener. CLI interactive REPL, TUI, task, print,
and headless script paths now create the run row before `RunController`
dispatches, then persist events and terminal state through that Host API.

This does not move execution into Host: CLI still runs the legacy `duyaAgent`
executor in its own process, and Desktop's Agent Server still runs its legacy
worker path. Desktop Main still owns the database handles, listener, and
Control Plane composition. The API does not yet own worker start/cancel, live
event streaming, reattachment, or run resume. Do not count this ledger cutover
as Host execution ownership or legacy `@duya/agent` retirement.

Verification: `npm run build:agent` passes all 17 workspace package builds,
including Protocol, Host, Agent Runtime, CLI, and Agent. Desktop Main typecheck
still exits 2 on the existing broad backlog; a filtered run has no diagnostics
in the changed Host adapter, transport, Desktop Host composition, or Agent/CLI
run paths. `architecture:check` exits 1 because Windows Vite `realpath` fails
with `EPERM` in the temporary core-I/O entry and the dirty worktree contains
nine Agent-to-Agent-Core edges absent from the baseline; it reports no new
Host/Protocol edge. No tests or HTTP/Electron runtime smoke were run.

## Desktop Agent Server — shared Host Run API (2026-10-12)

The trusted Agent Server still sends its existing `run:*` command vocabulary
through the Main-process Control Plane. After sender authorization, Desktop now
adapts create, append, settle, events, single-run reads, and session-run lists
to the same authenticated `HostRunApiV1` client used by CLI. Protocol owns the
typed run-record DTO; the Desktop bridge maps it back to its legacy row shape.
Event reads page through Host so terminal-event repair can find the last
durable sequence. Terminal settlement accepts omitted metrics for abandoned
starts, matching the existing call shape.

This aligns CLI and Desktop Agent Server persistence calls but does not move
the listener, SQLite owner, Control Plane composition, Worker Manager, or Agent
execution out of Electron Main / the legacy Agent package. `ControlPlaneService`
still has a Main-composed repository binding for ownership operations.
Verification: `npm run build:agent` passes all 17 packages. Desktop Main
typecheck exits 1 on the existing backlog; filtered output has no diagnostics
in the changed Host Run adapter or Host API files. No tests or live
HTTP/Electron smoke were run.

## Agent DB bridge — session writes through Host (2026-10-12)

Agent DB bridge session create and update now register selected working
directories through the local Host workspace capability, then persist session
metadata, extensions, and spawn lineage through `HostSessionApiV1`. Session-tool
child creation follows the same route. The owned-child summary now reads its
diff statistics through the Host session API, and project grouping reads the
Host's paginated local session projection. The persistence handlers no longer
call `CoreStores` directly; `resolvePermissionProfile` still reads the parent
profile and default setting through Main's synchronous database accessors and
remains a follow-up in the session domain.

An inaccessible or invalid selected directory now fails workspace registration
and the session request instead of falling back to a raw-path SQLite write.
Other Agent DB bridge domains still use Main-owned stores, including mailbox,
research, attachments, and cron-run history; this is a session-path cutover,
not database-owner migration.

Verification: `npm run build:agent` passes all 17 workspace packages and the
scoped `git diff --check` passes. Desktop Main typecheck remains red on the
existing backlog; filtered diagnostics in `db-bridge.ts` are limited to the
unrelated provider-config `baseURL` / `apiKey` shape at lines 1983–2002, with no
diagnostic in the migrated session paths. No tests or live HTTP/Electron smoke
were run. Main still owns the SQLite handles and Host listener.

## Session permission profile — move resolution behind Host (2026-10-12)

Added `HostSessionApiV1.resolveSessionPermissionProfile` to Protocol and the
authenticated loopback HTTP client/server. Host now applies the existing
rules: valid explicit profile for a root session, setting default when no
explicit profile exists, parent-profile inheritance for derived sessions, and
the trusted internal override. The default setting is read through Data's
`MainSettingsStore`, so the SQL is inside `@duya/data`; Desktop IPC and Agent DB
bridge no longer call the synchronous Main permission resolver. The endpoint
accepts trusted overrides only on the current local-token/loopback Host and
must not be exposed directly by a future remote API.

Path source check: `resolveDataRoot()` returns the user's `~/.duya` directory
outside namespaced tests, and `resolveDatabasePaths()` places
`duya-main.db`, `duya-core.db`, and `memory-state.db` in that directory.
Desktop boot config uses this resolver for its production default and retains
the old Electron path as the migration source; explicit database paths remain
supported.

Verification: `npm run build:agent` passes all 17 workspace packages. Desktop
Main typecheck still fails on the broad existing backlog; the filtered
diagnostics in `db-bridge.ts` are the unrelated provider-config `baseURL` /
`apiKey` shape errors, with no diagnostic in permission API, transport,
composition, or migrated handlers. `git diff --check` passes. No tests or live
Host/IPC smoke were run. Electron Main still owns Desktop's database handles,
and CLI/Desktop execution still imports the legacy Agent package.

## Local parsed-document attachments — move reads and writes behind Host (2026-10-12)

Added a typed local-only attachment contract to Protocol and authenticated
loopback HTTP client/server routes. `@duya/data` now owns the compatibility
reader for parsed documents still present in Main's `message_attachments`
table. Host merges those rows with the file-backed Core `AttachmentStore`,
deduplicating by attachment ID, and routes new writes to the Core store. Desktop
Agent DB bridge actions for save/session/message reads and `session:loadMessages`
now use this Host API instead of direct SQL or synchronous CoreStores access.
The returned local file path stays on the `/v1/local/...` surface; it is not
part of the public session DTO. This removes attachment call sites from the
bridge but does not move database handle ownership out of Main.

Verification: `npm run build:agent` passes all 17 workspace packages.
`npm run -w @duya/desktop typecheck:main` remains red on the existing backlog;
filtered diagnostics in `db-bridge.ts` are the unrelated provider-config
`baseURL` / `apiKey` shape errors at lines 1933–1952, with no errors in the new
attachment routes or composition. `architecture:check` reports nine
unbaselined `@duya/agent` → `@duya/agent-core` edges outside this slice. The
workspace-wide `git diff --check` is blocked by trailing whitespace in the
existing `AGENTS.md` edits; the scoped check for this slice passes. No tests or
live Host/IPC smoke were run.

## Renderer project-group session reads — route through Host (2026-10-12)

Changed `db:project:getGroups` to page through the existing local Host session
projection instead of calling `getCoreStores().sessions.list()` in the IPC
handler. It preserves the handler's active-session filter and grouping fields.
The Agent DB bridge already reads sessions through Host, but still consults the
memory-state project catalog for multi-path grouping; scheduler CRUD/execution
and other cron history surfaces remain follow-up work.

Verification: filtered Desktop Main typecheck reports no diagnostics in
`db-handlers.ts` or the attachment API/composition. The command still exits 2
on the broad existing Main backlog (including unrelated provider-config shape
errors in `db-bridge.ts`). No tests or runtime smoke were run.

## Agent settings — route DB bridge reads and writes through Host (2026-10-12)

Extended Data's `MainSettingsStore` with typed get-all and upsert operations.
The authenticated local Host now exposes get-one, get-all, and set operations;
Agent DB bridge and Desktop settings IPC `get`, `set`, `getAll`, `getJson`, and
`setJson` use that API. Gateway-scoped keys continue to use ConfigStore, as
before. The settings surface stays under `/v1/local/...` because values can
contain credentials. Session permission-profile resolution and Agent settings
share the same Host-composed Data store. This moves these settings SQL
statements out of Electron adapters; it does not yet move the Main database
handle or every other settings consumer.

Verification: `npm run build:agent` passes all 17 workspace packages.
Filtered Desktop Main typecheck reports no diagnostics in the settings routes,
store, composition, or bridge actions; the command still exits 2 on unrelated
provider-config `baseURL` / `apiKey` errors at `db-bridge.ts:1926–1945` and the
broader existing backlog. The scoped `git diff --check` passes. No tests or
live Host/IPC smoke were run.

## Cron-run session summaries — route Agent DB bridge through Host (2026-10-12)

Added a local Host session-summary query for sessions under an ID prefix.
`automation:cron:runs` now reads `cron:<id>:` summaries over authenticated
Host HTTP instead of calling `CoreStores.sessions.listByPrefix()` in the Agent
DB bridge. Data retains the literal-prefix escaping, `status != deleted`
filter, updated-time ordering, and limit/offset behavior. This moves that
history read; scheduler CRUD/execution and the separate MemoryState project
catalog remain outside Host ownership.

Verification: `npm run build:agent` passes all 17 packages. Filtered Desktop
Main typecheck reports no diagnostics in the new Protocol/Host route or bridge
call; it still exits 2 on existing provider-config errors at
`db-bridge.ts:1921–1940` and the wider backlog. `architecture:check` is blocked
by Windows Vite `realpath` `EPERM` in the temporary core-I/O entry and reports
nine dirty Agent-to-Agent-Core dependency edges; no new Host/Protocol finding
was reported. The scoped `git diff --check` passes. No tests or live
Host/IPC smoke were run.

## Mailbox — route client persistence through Host (2026-10-12)

Added a versioned local mailbox contract to Agent Protocol and an authenticated
Host HTTP client/server surface for enqueue, idempotent edit, guide, queued
promotion, cancellation, list/read, claim, apply, and agent cancellation. Both
standalone `duya serve` and Desktop's current Main-composed Host bind the same
Data `Mailbox` state machine. Desktop renderer IPC, Agent DB bridge operations,
spawn-completion notifications, idle-wake lease checks, and agent-DM hop lookup
and auto-return now use the Host client. The compatibility snake_case IPC rows,
mailbox broadcasts, and wake dispatch remain at the Main boundary. The Control
Plane's SQLite repository still calls the Data mailbox store internally; that
is the Host repository adapter, not a client-side database path. Electron Main
still owns the listener and SQLite handles, so process ownership remains a
later gate.

Verification: `npm run build:agent` passes all 17 workspace packages. Desktop
Main typecheck exits 2 on the broad existing backlog; filtered diagnostics in
the touched production paths show only the three existing provider-config
`baseURL` / `apiKey` shape errors in `db-bridge.ts:1921–1940`, with no mailbox,
IPC, Host composition, or wake-adapter errors. `architecture:check` exits 1 on
nine unbaselined `packages/agent` → `@duya/agent-core` edges; no Host/Protocol
edge was reported. Scoped `git diff --check` passes. No tests or live Host/IPC
smoke were run.

## Shared-room persistence — route session and history through Host (2026-10-12)

Room session creation, user posts, lifecycle notices, transcript reads, and
group-history reads now use the async `HostSessionApiV1` client. The room turn
queue waits for any interruption notice append before reading history, and the
GroupChatOrchestrator accepts an async history provider. Electron Main still
owns the orchestration and Agent wake dispatch; this cutover moves the room's
persistent session data behind Host without retiring its legacy Agent imports.

Verification: `npm run -w @duya/agent typecheck` passes. Desktop Main
typecheck remains blocked by the existing repository-wide error backlog; a
filtered run reports no diagnostics in `group-turn-dispatcher.ts` or
`group-handlers.ts`. The existing `groupTurn.test.ts` invocation could not
collect because Windows denied `realpath` on `node_modules/vitest/dist/spy.js`
with `EPERM`; no tests ran. The production source inventory now finds 30 files
using `getDatabase()` and 21 using `getCoreStores()`.

## Shared-room orchestration — move pure turn logic into Host (2026-10-12)

Moved the dependency-injected room turn state machine and its pure mention,
prompt, and round-robin rules from `packages/agent` into
`packages/host/src/group-turn.ts`, exposed as `@duya/host/group-turn`.
Desktop's room dispatcher and `PostToRoomTool` now consume that Host contract.
The old Agent path remains a compatibility re-export for existing callers.
The Host module has no database, filesystem, Electron, or process dependencies;
its runtime seams remain injected. Electron Main still owns the dispatcher and
worker lifecycle, so this does not yet make the Host independently runnable.

Verification: Host build/typecheck and Agent typecheck pass. Desktop Main
typecheck still fails on the existing repository-wide error backlog; no
diagnostics point to the changed room dispatcher or `PostToRoomTool`.
`architecture:check` remains blocked by Windows Vite `realpath` `EPERM` in the
Core I/O scanner and reports the nine existing unbaselined Agent-to-Agent-Core
edges; it reports no new room-turn dependency. No tests were run for this
slice.

## Agent DM wire contract — move shared envelope out of Agent (2026-10-12)

Moved the Agent DM envelope types, intent taxonomy, digest and shape validator,
JSON codecs, message clamp, and dedupe helpers into
`packages/agent-protocol/src/agent-dm.ts`. The digest retains the existing
JSON key order and SHA-256 bytes, using Protocol's dependency-free hash. The
old `packages/agent/src/agent/dm/` modules now re-export the shared contract
for Agent-internal callers. Desktop's mailbox dispatcher and automatic DM
reply path import Protocol directly; Agent-specific wake-prompt construction
and run scheduling remain in their existing owners.

Verification: Protocol build/typecheck and Agent typecheck pass. A built-output
Node smoke check confirms encode/decode and a legacy digest vector. Vitest
could not collect the focused tests because Windows denied `realpath` on
`node_modules/vitest/dist/spy.js` (`EPERM`); no tests ran. Desktop Main
typecheck remains blocked by the existing repository error backlog; filtered
output has no diagnostics for the changed DM adapter files. The broader Host
ownership and run-execution gates above remain open.

## Persisted session IDs — share bot and room identity across layers (2026-10-12)

Moved the stable `bot:` and `room:` session-ID prefixes, constructors, and
parsers into `packages/agent-protocol/src/session-ids.ts`. `@duya/data`,
Desktop Main, and the renderer now use the Protocol implementation instead of
duplicating literals or importing the old Agent module. Compatibility exports
remain for existing Agent and UI callers. The persisted strings are unchanged,
so existing database rows need no migration.

Verification: `npm run build:agent` passes all 17 workspace packages;
Protocol, Data, Host, Agent, CLI, and Desktop Renderer typechecks pass. A
built-output Node smoke check covers Protocol, the Agent compatibility export,
and Data's prefix export. Desktop Main typecheck remains blocked by the existing
repository-wide backlog; filtered diagnostics show no errors in the changed
session-ID/DM paths. No Vitest run was made for this slice.

## Desktop CLI cron history — read session summaries through Host (2026-10-12)

The `/v1/crons/:id/runs` and `/v1/crons/:id/logs` handlers now query the
existing authenticated local Host session-summary API instead of reading
`CoreStores.sessions` or probing `getDatabase()` in the CLI adapter. Prefix,
limit/offset, sort order, and response DTO mapping stay unchanged. The Host
listener and SQLite handles are still composed in Electron Main; this removes
two synchronous database callers but does not move database ownership.

Verification: `git diff --check` passes for the changed handlers and route.
Desktop Main typecheck still exits nonzero on the existing backlog; filtered
diagnostics in `crons.ts` are the pre-existing nullable schedule fields and
`cron.dedupe` audit-kind mismatch, with no diagnostics in the changed handler
lines or `extra2.ts`. No tests or live Host/CLI smoke were run.

## Wake and Agent DM session data — route reads and marker writes through Host (2026-10-12)

Wake execution now reads a session's local working directory and model through
the Host local-session projection. Agent DM sender/replier display names use
the same projection, and receiver marker messages append through the Host
timeline API before the existing renderer broadcast. The marker broadcast is
skipped when an idempotent append reports that the row already existed. Bot
session get-or-create now uses the Host session API too; DM, Bot IPC, Connector,
Group Turn, and Scheduler callers await that operation. The bot-session path no
longer accesses `CoreStores` directly.

Verification: Desktop Main typecheck exits nonzero on the existing repository
backlog; filtered diagnostics show no errors in the changed bot-session,
`wake-run.ts`, or `agent-dm-return.ts` paths. `connector-runtime.ts` still has
the unrelated existing private-member and connector-shape errors. The
bot-session test now mocks the Host API but was not run. Scoped
`git diff --check` passes. No live Host/IPC smoke was run.

## Wake contracts — move shared work items to Protocol (2026-10-12)

Moved the transport-neutral wake item, payload, source, and lane contracts plus
their pure dedupe/preemption helpers into `@duya/agent-protocol`. The old Agent
module remains a compatibility re-export. Desktop Main and Wake tests now
import the contract from Protocol directly, removing Desktop's direct deep
imports from `packages/agent` for these values. The per-session wake queue,
persistence, and execution are still owned by Electron Main.

Verification: Protocol build and Agent typecheck pass. Desktop Main typecheck
still fails on the existing repository-wide backlog, including the unrelated
`wake-rearm.ts` pending-wake row field/type mismatches at this stage; the
following pending-wake persistence slice resolves those DTO mismatches. No
tests or live Host smoke were run.

## Pending-wake persistence — route queue markers through Host (2026-10-12)

Added a typed local pending-wake API to Protocol and implemented it over the
Data-owned `PendingWakeStore` in Host. Both standalone Host and Desktop's
authenticated Host listener expose get, persist, clear, list, and stale-prune
operations. Desktop's wake rearm, marker persistence, inbound-envelope
read/modify/write, and channel-marker timeline append now use the Host client;
pending-wake writes are serialized per session, and the drain waits for
accepted marker writes before dispatch so concurrent inbound envelopes are not
dropped and persist/clear order is kept. The Data row query now aliases SQL
columns to its declared camel-case DTO.
Electron Main still composes the
Desktop listener over its own database handles, so database ownership has not
moved yet.

Verification: Protocol, Data, and Host builds plus Agent typecheck pass.
Desktop Main typecheck remains blocked by 269 repository-wide diagnostics; the
filtered output has no diagnostics in the changed wake, Host API, or pending
wake files. `git diff --check` passes. No tests or live Host/IPC smoke were
run.

## Project metadata — route Desktop CRUD through Host (2026-10-12)

Added a Protocol `HostProjectApiV1`, authenticated HTTP routes/client, and the
same Data-backed implementation to standalone `duya serve` and Desktop's
current Main-composed Host. Desktop `projects:list/get/register/update/delete`
IPC now uses that client for the `duya-core.db` project rows. Local project
directory seeding/reconciliation remains a Desktop filesystem adapter; the
memory-state `rollout_catalog` unbind still runs in Desktop before Host deletes
the project row. Other memory-state project-resolution callers still use the
legacy service, so this cuts over the renderer-facing CRUD path, not every
project database caller or database ownership.

Verification: all 17 workspace packages build; Data and Host builds pass; the
authenticated standalone Host HTTP smoke passes list/get/create/update/delete.
Desktop Main typecheck remains blocked by the existing repository-wide error
backlog; filtering its output finds no diagnostics in the changed project
handler, Protocol, Host API, HTTP transport, or project service files. The
workspace-wide `git diff --check` reports pre-existing dirty-tree whitespace
findings in `AGENTS.md` and `room-session.ts`; no finding points to this slice.

## Agent session reads and title updates — use Host Session API (2026-10-12)

The masked provider-config IPC now reads a session's provider/model through
`HostSessionApiV1.get`, and Agent Process Pool `chat:title_generated` messages
update the session through `HostSessionApiV1.update`. This removes one direct
CoreStores read and one direct SessionStore write while preserving the existing
IPC response and best-effort title update behavior. The Host HTTP listener and
database handles are still composed by Electron Main.

Verification: Desktop Main typecheck remains nonzero on the existing broad
repository backlog; its filtered diagnostics contain no errors in either
changed file. Scoped `git diff --check` passes. No tests were added or run for
this slice.

## External transcript import — write and rollback through Host (2026-10-12)

Claude/Codex JSONL parsing stays in Desktop, but session creation and rollback
now use a local authenticated Host capability. Parsed message entries append
through the Host Session timeline API in batches of 50. The Host removes the
session row, message index, and best-effort rollout file during rollback, so
the import writer no longer opens `CoreStores` directly. The local-only import
contract accepts the legacy working directory; public/remote Session APIs
remain Workspace-reference-only. Desktop's Host listener and database handles
are still Main-owned.

Verification: Agent Protocol and Host builds pass. Desktop Main typecheck still
fails on the existing repository-wide backlog; filtered output has no errors
in Host transport or composition and reports the pre-existing `LogComponent`
type error in `session-writer.ts`. No tests or live import/rollback smoke were
run. The migration removes the import writer's direct CoreStores access, but
does not move database ownership or complete the other remaining callers.

## Desktop CLI message and session queries — use Host Session API (2026-10-12)

`POST /v1/messages/send` now appends the durable user message through
`HostSessionApiV1.appendTimeline`. Channel-disconnect fallback agent discovery
now pages `HostSessionApiV1.list` instead of scanning `CoreStores.sessions`.
Both operations preserve their existing HTTP response behavior and remain
local-only Desktop CLI APIs. This removes one direct MessageLog write and one
direct CoreStores read; Electron Main still composes the Host listener and owns
the database handles.

Verification: `npm run -w @duya/desktop typecheck:main` exits 2 on the existing
repository-wide backlog; filtered diagnostics contain no errors in the changed
handler. Scoped `git diff --check` passes. No tests were added or run for this
slice.

## Automation cron sessions — use Host Session API (2026-10-12)

Cron run setup now checks/creates its session with `HostSessionApiV1` and
registers the automation workspace through the local Host capability before
the Agent Server chat dispatch. `runCronNow` awaits persistence before
returning its session handle, and scheduled execution awaits the same
idempotent operation. This removes Automation's direct `CoreStores` session
read/write; timers and execution remain in Electron Main. The cron prompt still
enters the timeline at run dispatch, so session creation does not add a second
message write.

Verification: Desktop Main typecheck exits 2 on the existing repository-wide
backlog; filtered output has no diagnostics in `agent-run.ts` or `Scheduler.ts`.
Scoped `git diff --check` passes. The existing cron-session test was updated for
the async Host API contract but was not run.

## Conductor Canvas session state — use Host Session APIs (2026-10-12)

Conductor Canvas selection now reads `conductor_canvas_id` and the local
session working directory through Host's local Session projection. Canvas
binding, unbinding, and `conductor_mode_enabled` updates use
`HostSessionApiV1.update`; the executor now awaits those operations. Canvas
storage and the RPC executor remain in Desktop Main. This removes the
Conductor proxy's direct CoreStores access without moving project database or
Canvas ownership.

Verification: Desktop Main typecheck exits 2 on the existing repository-wide
backlog; filtered output has no diagnostics in `executor-proxy.ts`. Scoped
`git diff --check` passes. The existing proxy test mocks were updated for the
Host API but were not run.

## Gateway session rows — use Host Session API (2026-10-12)

Gateway session create, workspace/permission synchronization, and generated
title updates now use the authenticated Host Session API. Local workspace
paths are registered through Host and persisted as Workspace references. The
Gateway message handler awaits session creation and metadata synchronization
before it enqueues an inbound wake; Gateway chat mappings and the legacy
`threads` table still use Main's database.

Verification: Desktop Main typecheck exits 2 on the existing repository-wide
backlog; filtered diagnostics contain no errors in `session-helpers.ts` and
only the unrelated Gateway reply DTO mismatch in `message-bus.ts`. Scoped
`git diff --check` passes. No tests or live Gateway/Host smoke were run.

## Gateway and automation session paths — finish adjacent Host writes (2026-10-12)

Desktop automation cron-run summaries now use Host's existing local prefix
query instead of `CoreStores.sessions.listByPrefix()`. Routine lifecycle
markers append through `HostSessionApiV1` and are broadcast only after Host
confirms a new timeline entry. The scheduler still owns cron definitions and
execution; this moves only session summary reads and transcript persistence.

Verification: Desktop Main typecheck exits 2 on the existing repository-wide
backlog; filtered diagnostics show no errors in the changed `db-handlers.ts`
or Gateway session helpers, with one unrelated Gateway reply DTO mismatch in
`message-bus.ts`. Scoped `git diff --check` passes. No tests or runtime smoke
were run.

## Desktop Control Plane compatibility path — use Host Run API (2026-10-12)

The exported `createRun`, `appendRunEvents`, `completeRun`, query wrappers, and
`dispatchControlPlaneAction` now call the authenticated Desktop Host Run API
client through the existing adapter. They no longer open or inject
`CoreStores.runs`; production Agent Server calls and legacy direct callers use
the same persistence boundary. Control Plane composition and child-process
sender authorization remain in Main, and the Host listener still uses
Main-owned database handles.

Verification: scoped `git diff --check` passes, and the changed adapter has no
direct `getCoreStores`/`core-connection` reference. Desktop Main typecheck exits
2 on the existing repository-wide backlog; no diagnostic points to
`run-control-plane.ts`. No tests or live run smoke were run.

## Research persistence — route Agent bridge actions through Host (2026-10-12)

Added a bounded `HostResearchApiV1` action contract and authenticated
`POST /v1/research/actions` route. The Host service now owns the existing
Research Session, plan, activity, event, source, citation, report, and Research
Memory action mappings. Both Desktop's Main-composed listener and standalone
`startLocalHost()` expose the service. The Agent DB bridge forwards these
actions over its Host client and no longer reads `CoreStores` for Research.
Legacy payload fields and result shapes are preserved. Desktop Main still
composes the listener over its own handles; this is API-boundary migration,
not physical ownership transfer.

Verification: `@duya/agent-protocol` and `@duya/host` builds pass. Desktop Main
typecheck exits 2 on existing provider-config diagnostics in `db-bridge.ts`;
filtered output contains no errors in the new Research API, HTTP route, or
Desktop Host wiring. Scoped `git diff --check` passes. No tests or runtime
smoke were run.

## Terminal command history — route the last local terminal SQL through Host (2026-10-12)

Added Data migration 59 and `TerminalHistoryStore` for command suggestions and
upserts, plus a local-only Protocol/HTTP capability. Both standalone
`startLocalHost()` and Desktop's Main-composed listener provide it. Desktop's
terminal manager no longer imports `getDatabase()` or contains command-history
SQL; IPC awaits Host-backed suggestions and explicit record requests. PTY input
is written before awaiting best-effort history persistence, so a history failure
does not prevent the shell from receiving the command. This also creates the
table that the previous Main SQL expected but no migration had created.

Verification: `@duya/agent-protocol`, `@duya/data`, and `@duya/host` builds
pass. Desktop Main typecheck remains red on the documented repository backlog;
the new Protocol subpath import was corrected to use the package root, and the
remaining terminal-file diagnostics are on unchanged PTY options/logging lines
and the existing spawn-error handler. `typecheck:all` stops earlier in
`@duya/agent-runtime` on conflicting Protocol message-content types.
`architecture:check` reports 11 new violations from existing dirty migration
edits and its Core IO scanner fails with EPERM; no baseline entries were added.
Scoped `git diff --check` passes. No tests or Electron/standalone Host smoke
were run.

## Wakeless chat workspace — read settings through Host (2026-10-12)

Wakeless chat now awaits the local Host Settings API for `workspaceDir` before
building the Agent Server request. This removes its synchronous
`db/queries/settings` dependency. A Host settings failure rejects the dispatch
with an explicit unavailable result, preserving the configured-workspace
invariant instead of falling back to an unintended directory.

Verification: scoped `git diff --check` passes and source search finds no
`getSetting()`/`getDatabase()` in `orb-wakeless-chat.ts`. Desktop Main typecheck
still exits 2 on repository errors; the only filtered diagnostic in that file
is the existing provider DTO mismatch at `getActiveProviderConfig`.
No tests or runtime dispatch smoke were run.

## Gateway configuration reads — use Host Settings API (2026-10-12)

Gateway's cached provider fallback and `gateway:get_config` now await the local
Host Settings API rather than querying the `settings` table directly. Provider
resolution keeps its 30-second cache and the existing provider-selection
precedence. The Gateway message bus still has direct Main database access for
its chat mappings, thread projections, and other persistence; this is only the
settings-read cutover.

Verification: scoped `git diff --check` passes. Desktop Main typecheck still
exits 2 on the repository backlog; filtered diagnostics in `message-bus.ts`
point only to the unchanged Gateway send-response DTO. No tests or live
Gateway/Host IPC smoke were run.

## Current Desktop database caller inventory (2026-10-12)

After the Host session, Run, wake, terminal-history, settings, and Gateway
domain cutovers, a production-source scan excluding tests finds 25 files that
still call `getDatabase()` and 4 that still call `getCoreStores()` directly.
These are file counts, not caller counts; Main still opens both application
databases, so the independent Host ownership gate is not met. Several provider,
settings, and legacy compatibility domains remain to be migrated by typed
operation before moving the listener and database startup out of Electron.

## Gateway persistence and config — move production operations behind Data/Host (2026-10-12)

Added the transport-neutral `HostLocalGatewayUserMapApiV1`, Data-owned
`GatewayUserMapStore`, and authenticated local Host HTTP route. Desktop and
standalone Host compositions both provide the API. Gateway session resolve,
reset, status/stop commands, the Gateway DB bridge's mapping actions, and CLI
channel binding listings now use the Host client. Production SQL for
`gateway_user_map`, `channel_directory`, and atomic allow-list mutations are
confined to Data stores behind authenticated local Host APIs. Gateway bridge
configuration and allow-list checks use the same typed Host boundary; CLI
channel and platform listings await Host-backed reads. The existing
session-row `threads` projection remains a Main persistence path, and Desktop
still composes the Host listener over Main-owned database handles.

Verification: `@duya/agent-protocol`, `@duya/data`, and `@duya/host` builds pass.
Desktop Main typecheck exits 2 on the repository backlog; filtered diagnostics
contain no errors in the changed Gateway or CLI files. Scoped `git diff --check`
passes. Production-source search finds Gateway mapping, directory, and
allow-list SQL only in Data schema/stores; remaining Gateway Main SQL is the
legacy `threads` projection. No tests or live Gateway/Host smoke were run.

## Gateway thread projection cutover (2026-10-12)

Gateway title lookup, ensure/reset upserts, first-message title writes, and
thread timestamp updates now use `HostLocalGatewayThreadApiV1` over the
authenticated Host HTTP client. `GatewayThreadStore` owns the legacy `threads`
SQL in Data; both standalone Host and Desktop's embedded Host composition
provide the API. `apps/desktop/src/main/gateway/message-bus.ts` no longer calls
`getDatabase()` or writes SQL directly. This closes the Gateway Main SQL
boundary, but Desktop still supplies its database handle to the Host listener,
so independent Host database ownership remains incomplete.

Verification: `@duya/agent-protocol`, `@duya/data`, and `@duya/host` builds pass.
No tests or live Gateway/Host smoke were run.

## Desktop settings query — use the Data store (2026-10-12)

The synchronous Desktop settings query facade now delegates string reads and
JSON writes to Data's `MainSettingsStore`, which is also the store composed by
the Host Settings API. The facade still obtains the current Main database
handle for legacy synchronous callers; this moves SQL ownership into Data but
does not yet detach those callers from Electron's database lifecycle.

Verification: Desktop Main typecheck reports no diagnostic in
`db/queries/settings.ts`; it still exits 2 on the existing unrelated Main
backlog. No tests were run.

## Agent message-card state writes — Host API (2026-10-12)

The Agent DB bridge's six interactive message-card persistence actions now
cross `HostLocalSendMessageStateApiV1`: widget pending/response, cursor-agent
run upsert/status, and secret pending/status. The protocol owns their DTOs,
Data wraps the existing side-table SQL, and both standalone Host and Desktop's
current embedded Host composition expose the authenticated local HTTP routes.
The DB bridge now resolves `getDatabase()` lazily, so these Host-backed actions
do not acquire the Main database handle; the remaining direct channel and
health branches still do. Desktop still
composes the HTTP Host in Main over Main-owned handles, so this is caller
cutover only, not independent Host ownership.

Verification: protocol, data, and host package builds pass. Desktop Main
typecheck still exits 2 on the existing Main backlog; this slice has no
diagnostics, while three pre-existing provider-config errors remain in
`db-bridge.ts`. `architecture:check` remains red on the dirty checkout: its
core-I/O scanner hit filesystem `EPERM`, and it reports nine
`@duya/agent` → `@duya/agent-core` edges already present in the dirty package
migration. The Host deep import from its first run has been fixed. Scoped
`git diff --check` passes; whole-tree check is still blocked by an unrelated
blank line in `renderer/lib/room-session.ts`. No tests were run.

## Agent model-capability cache — Host API (2026-10-12)

The Agent DB bridge's `modelCapability:get/set/delete` actions now use a typed
local Host API backed by Data's `ModelCapabilityStore`. Model-name
normalization, timestamps, the SQL row shape, and the legacy `{ success }`
responses are preserved. Both standalone Host and Desktop's current embedded
composition expose the same authenticated routes. The bridge no longer reads
or writes `model_capabilities` directly; channel binding/offset and health
branches still need database-domain cutovers.

Verification: protocol, data, and host package builds pass. Desktop Main
typecheck still exits 2 on the existing Main backlog; the filtered
diagnostics in `db-bridge.ts` remain its three provider-config field errors.
Scoped `git diff --check` passes. No tests or live Host/Agent smoke were run.

## Agent plugin setup reads — local Host API (2026-10-12)

The `plugin:setup:list-all` Worker action now reads through an authenticated
local Host route backed by Data's `PluginSetupStore`. The store preserves the
existing empty-object fallback when the setup table is missing or unreadable,
and the Agent still receives the same `{ pluginId: { key: value } }` map.
Because these values can contain credentials, this remains a local-only route;
the Host server continues to bind only to loopback. The DB bridge no longer
opens the database for this action.

Verification: protocol, data, and host package builds pass. Desktop Main
typecheck exits 2 on the existing Main backlog; filtered output shows only its
three pre-existing provider-config errors in `db-bridge.ts`. No tests or live
Host/Agent smoke were run.

## Channel bindings and offsets — route persistence through Host (2026-10-12)

Added `HostLocalChannelPersistenceApiV1` and Data's
`ChannelPersistenceStore` for `channel_bindings` and `channel_offsets`, with
authenticated local routes in both standalone and Desktop Host compositions.
Desktop channel IPC, the Agent DB bridge, and the Gateway health projection now
use the Host client. Telegram offset restore/save is asynchronous and uses the
same API; its connector no longer issues SQL. Existing row fields and upsert
defaults are preserved. SQL for these two tables is now confined to Data's
store/schema in production code.

Desktop still embeds the Host listener in Main and supplies its database
handle, so this is a caller cutover, not independent Host ownership. The
Worker Manager and run execution still depend on `@duya/agent`.

Verification: protocol, data, and host package builds pass. Desktop Main
typecheck still exits 1 on the existing backlog, including provider-config
diagnostics in `db-bridge.ts` and unrelated connector-runtime typing errors;
no diagnostics were reported for the new persistence API, IPC handlers, or
Host composition. No tests or live Host/Telegram smoke were run.

## Agent profile persistence — route IPC through Data/Host (2026-10-12)

Added `HostLocalAgentProfileApiV1` and Data's `AgentProfileStore`, with the
authenticated local Host route/client in both standalone and Desktop
compositions. Agent profile IPC keeps the existing snake_case row DTO, JSON
encoding of tool lists and prompt overrides, create defaults, patch field map,
and preset-delete refusal. `db-handlers.ts` no longer issues SQL for
`agent_profiles`; the table SQL remains in Data's store/schema.

This is a persistence-caller cutover only. Desktop still starts the HTTP Host
inside Main and injects its Main-owned SQLite handle. The independent Host
process/database owner gate remains open.

Verification: protocol, data, and host builds pass. Three real SQLite store
tests pass for create/list row compatibility, partial updates, and preset
deletion; all nine focused profile IPC tests also pass. The broader
`db-handlers.test.ts` file still has 38 failures because unrelated session,
lock, and other IPC fixtures do not start or mock their Host APIs. Desktop Main
typecheck exits 2 on the repository's existing backlog; the run reports no
profile-store, Host profile API, or IPC handler diagnostics.

## Code Review history reads — use the local Host API (2026-10-12)

Extended `HostLocalTurnReviewApiV1` with latest, bounded history, detail, and
session/turn lookup reads. `ChatTurnReviewStore` now owns those queries, and
the authenticated local Host HTTP client/server expose them beside the
existing write route. Git IPC converts the Host projection into its unchanged
renderer DTO and retains its invalid-row and unavailable-Host responses.
`git-handlers.ts` no longer reads `chat_turn_reviews` or imports the Main
database accessor.

This removes one more direct Main SQL caller, but the Desktop listener still
runs in Main and uses its database handle. Host process ownership remains
unfinished.

Verification: `@duya/agent-protocol`, `@duya/data`, and `@duya/host` builds
pass. One real SQLite store test and all 21 Git IPC tests pass. The Desktop
Main typecheck still exits 2 on unrelated existing diagnostics in
`git-handlers.ts`'s commit/ref handlers; it reports no diagnostics in the new
turn-review adapter, API, store, or routes. Scoped `git diff --check` passes.
`architecture:check` exits 1: its Core I/O scanner cannot realpath
`scripts/architecture/layer-purity.ts` in this environment (`EPERM`), and the
dirty checkout reports nine existing `@duya/agent` → `@duya/agent-core`
dependency edges. No baseline entries were changed.

## Plugin setup persistence — route writes through Host (2026-10-12)

Extended `HostLocalPluginSetupApiV1` with atomic merge and clear operations.
Data owns the upsert transaction; the authenticated loopback Host exposes
POST/DELETE alongside the worker-facing list route. PluginManager no longer
opens SQLite for setup values. Its sync `listInstalled()` projection reads a
cache primed after Desktop's Host client starts, while setup load/save,
installation state calculation, and uninstall cleanup use Host APIs. The IPC
load handler continues to mask secrets before returning values to the renderer.

This only migrates plugin setup persistence. Desktop still composes the Host
listener inside Main.

Verification: Agent Protocol, Data, and Host builds pass. Five focused tests pass
across the real Data store, authenticated loopback HTTP merge/list/clear, and
PluginManager install/list behavior. Desktop Main typecheck still fails on
other diagnostics in `plugin-handlers.ts` (lines 58, 311, and 387); the filtered
run reports no diagnostics in PluginManager, Desktop Host composition, or the
Host route/client changes. The first sandboxed Vitest attempt could not
realpath the `node_modules` junction (`EPERM`); the focused run passed with the
required filesystem access.

## Runtime and CLI source status recheck (2026-10-12)

The production turn loop has advanced: Desktop `chat:start` and the headless
CLI both call `driveRunWithEngine`, and the sub-agent path has an engine driver.
The old package is still required for composition: Desktop and the headless CLI
still import and construct `duyaAgent`, which currently supplies prompt, model,
tool, and run-lifecycle mechanisms to the engine ports. The current source has
no production `duyaAgent.streamChat()` / `subAgent.streamChat()` turn call; the
remaining `.streamChat()` calls are LLM-client operations or comments/tests.
This means the Runtime loop is live, while removing `@duya/agent` is still a
separate extraction task.

The CLI migration is transitional. `packages/cli` provides `duya serve` and a
local Host session adapter; `packages/agent/src/cli` reuses or starts that local
Host for durable sessions, timeline, tasks, and run records. It still constructs
`duyaAgent` and `HeadlessRunHost` in the CLI process, so the Host persists the
run while the CLI process executes it. The CLI does not yet ask a Host to execute
the run, and it has no remote Host selection/auth flow. Other control-plane
commands still use Desktop's CLI API. Neither change moves Desktop's Host
listener/database owner out of Main.

Verification of the live driver paths: 49 focused Runtime tests pass across
Desktop single-driver, headless engine parity, sub-agent engine, and session-end
parity suites. This validates the engine-loop cutover but does not establish
that the CLI can run without `@duya/agent` or that Host owns execution.

## Workbench persistence — move Main callers behind Host (2026-10-12)

Moved the Workbench source persistence contract into Agent Protocol and added
`WorkbenchDataStore` in Data. The authenticated local Host API now owns source
CRUD, canvas project-path and element ownership reads, due-source selection,
and refresh-result writes. Both standalone Host and Desktop's embedded Host
composition expose the same API. `WorkbenchService` now uses async Host calls;
`executor-proxy` awaits the CRUD calls, while widget checks, project queries,
refresh scheduling, and renderer broadcasts retain their existing behavior.
The service no longer calls `getDatabase()` or issues SQL. Source configs stay
on the authenticated loopback API because they may contain credentials.

This removes the Workbench service from the Main database-caller set, but
Desktop still supplies its SQLite handle to the Host composition, and the
Workbench scheduler/fetch lifecycle remains in Desktop Main. It does not pass
the independent Host owner or Worker Manager gates.

Verification: Agent Protocol, Data, and Host builds pass. Desktop Main
typecheck exits 2 on the existing repository backlog; filtered output reports
no diagnostics in the changed Workbench service, Host route/client/composition,
or Workbench types. The existing Workbench service spec was updated for async
Host operations but tests were not run. No live HTTP/Host smoke was run.

## Import history persistence — route batch metadata through Host (2026-10-12)

Moved `import_batches` and `import_items` reads/writes into Data's
`ImportBatchStore` and added a local authenticated Host API in Protocol, Host,
and the HTTP client. Standalone Host and Desktop compositions use the same
store. Desktop import apply, rollback, and history now await Host calls; the
file writers and session importer remain in Main. Removed the Main-owned
`batch-store.ts` direct SQLite path. Data maps SQLite snake_case rows to the
existing camelCase IPC records used by rollback/history.

This closes only the import-history persistence domain. Desktop still supplies
the database handle to its embedded Host and owns the import file operations.

Verification: Agent Protocol, Data, and Host builds pass. Desktop Main
typecheck exits 2 on the repository backlog; filtered output has no diagnostics
in the changed import handler, Host route/client/composition, or import batch
API. Direct IPC/runtime smoke was not run, and tests were not run. No runtime or
test result is claimed.

## Desktop settings callers — route persisted settings through Host (2026-10-12)

Moved the persisted settings used by `settings-handlers` to the existing
authenticated Host settings API: browser-extension allowlist load/sync/write,
the host tool permission setting, and the provider reinitialization reads for
blocked domains, sandbox state, and browser backend mode. The extension
installer also persists its auto-approved extension ID through Host. Startup
loads the browser allowlist and max-tab setting through Host before starting
the browser daemon. Electron-only actions and the live in-memory extension
allowlist remain in Main.

This removes SQLite/settings-store calls from these settings and extension
installer IPC paths. The process pool now reads `browserBackendMode` through
the Host settings API before initializing a Desktop worker; headless use keeps
the existing `auto` fallback. Desktop still supplies its open database handle
to the embedded Host. This does not pass independent Host ownership.

Verification: Desktop Main typecheck exits 2 on the repository backlog; the
changed settings and extension-installer handlers have no filtered diagnostics,
the process pool has no filtered diagnostics, and the changed startup block has
no diagnostics (the remaining `index.ts` diagnostics are at unrelated lines).
The current Data path resolver returns `C:\Users\lavachen\.duya\duya-main.db`
and sibling `duya-core.db` / `memory-state.db`. Targeted `git diff --check`
passes. No tests or live Desktop/Host smoke were run.

## Skill override settings — move CLI and capability reads behind Host (2026-10-12)

The Desktop CLI skills list/info endpoints and enable/disable writes now use the
authenticated Host settings API for `skillEnabledOverrides`. The capability
management cross-source snapshot reads the same key through Host and is now
async. Skill override read-modify-write operations are serialized in the CLI
handler so concurrent requests do not overwrite each other's updates. These
runtime callers no longer use the synchronous settings query helpers.

The one-time config migration still reads historical settings while migrating
legacy values; that startup path moves with database bootstrap ownership. The
Host listener is still embedded in Desktop Main, so this is not independent
Host ownership.

Verification: Desktop Main typecheck exits 2. The changed CLI handlers have no
filtered diagnostics; `cross-source.ts` still reports existing severity,
origin, and MCP DTO mismatches outside the Host-settings change, while
`index.ts` reports unrelated diagnostics. No tests or live CLI/Host smoke were
run.

## Provider reinitialization session reads — use Host local session projection (2026-10-12)

The provider-reinitialization IPC handler now reads each active worker's
working directory and `system_prompt` via the authenticated local Host session
API. `settings-handlers` no longer imports `getCoreStoresOrNull()` or reads
session rows directly. The local projection is required because the worker
init message needs a filesystem path; the client-safe session contract keeps
that path opaque.

This closes one more Main-side CoreStores caller. It does not move database
ownership or Worker lifecycle out of Electron, and no test or live Host smoke
has been run for this slice.

Verification: Desktop Main typecheck still exits 2 on repository diagnostics
in `index.ts` and `cross-source.ts`; the filtered output has no diagnostics in
`settings-handlers.ts`. Scoped diff check passes. No test or live Host smoke
was run.

## Recap and next-step message reads — route through Host (2026-10-12)

Recap and next-step generation now page `HostSessionApiV1.readMessages` and
adapt Host message entries through the existing IPC projection. Inactivity
recap counts user messages from the fetched projection and reuses those rows
for generation, avoiding a second history read. These services no longer
access `CoreStores.messageLog` or depend on the Main SQLite handle.

This moves two more read-only production callers behind Host while preserving
the prompt DTO and including superseded messages as before. Main still opens
the databases and owns the scheduling/UI lifecycle. Tests and live Host smoke
were not run for this slice.

Verification: Desktop Main typecheck still exits 2 on repository diagnostics
in `index.ts` and `cross-source.ts`; the filtered output has no diagnostics in
the new message reader or the recap/next-step services. Scoped diff check
passes. No tests or live Host smoke were run.

## Gateway network checks — use canonical channel config (2026-10-12)

Proxy discovery and bridge connectivity checks no longer query `settings` or
`weixin_accounts` from SQLite. They read the migrated channel configuration
through ConfigStore and use the existing Weixin account store, including the
legacy single-token fallback. These values already belong to `config.toml` and
`secrets.json`; the SQLite reads were stale compatibility paths. The two Main
services no longer import or call `getDatabase()`.

This removes a stale DB dependency and does not transfer ConfigStore ownership
or the database handles out of Electron.

Verification: `npm run -w @duya/desktop typecheck:main` exits 2 on diagnostics
in other files, including `db-bridge.ts`, `router.ts`, and `connector-runtime.ts`;
there are no diagnostics in `proxy.ts` or `bridge-tester.ts`. Scoped diff check
passes. No tests or network smoke were run.

## Gateway auto-start — remove stale SQLite read (2026-10-12)

Desktop startup already builds the Gateway configuration from ConfigStore and
starts the Gateway when `channels.auto_start` is true. A later legacy startup
block separately queried SQLite's `bridge_auto_start` setting and called
`startGateway()` again. Removed that duplicate path so startup follows the
canonical ConfigStore value and no longer revives a stale SQLite setting.

Verification: scoped `git diff --check` passes. `npm run -w @duya/desktop
typecheck:main` still fails on existing diagnostics, including unrelated
`index.ts` errors at lines 453, 464, and 1006 and a `message-bus.ts` error at
line 915; no tests or live Gateway smoke were run.

## Memory toggle — read legacy value through Host Settings API (2026-10-12)

The memory boot-alignment step now reads the legacy `memoryEnabled` setting
through the authenticated Host Settings API instead of opening Main's SQLite
connection through `getJsonSetting()`. Startup awaits alignment before reading
`memory.memory_enabled`, so the worker gate observes the aligned value. The
Memory Worker still receives Main/Core database handles for its extraction and
catalog reads; this change moves the setting caller only.

Verification: scoped `git diff --check` passes. Filtered Desktop Main typecheck
reports no diagnostics in `memory/worker-bootstrap.ts`; the aggregate check
still fails on unrelated `index.ts` diagnostics at lines 453, 464, and 1006.
No tests or live Host smoke were run.

## Weixin context tokens — route persistence through Host (2026-10-12)

Added Weixin context-token get, upsert, and account-wide delete operations to
the existing authenticated local Channel Persistence API. Data's
`ChannelPersistenceStore` now owns the `weixin_context_tokens` SQL; the
Desktop IPC handlers use the same Host API as standalone Host clients. Tokens
remain on the local-only authenticated route. Account configuration continues
to use ConfigStore.

Verification: Agent Protocol, Data, and Host builds pass. Filtered Desktop
Main typecheck reports no diagnostics in `db-handlers.ts`; the aggregate Main
check still fails on existing diagnostics in other files. `architecture:check`
exits 1 because the Core I/O scanner hits filesystem `EPERM` and the dirty
checkout exposes nine existing Agent-to-Core dependency edges; no baseline was
changed. Scoped `git diff --check` passes. No tests or live Host smoke were run.

## CLI status — ask Host whether persistence is ready (2026-10-12)

The Desktop CLI control API's `/v1/status` handler no longer opens or inspects
the Main SQLite connection. It asks the authenticated Host HTTP client for the
database-readiness projection exposed by `/healthz`. Both production Host
compositions open their database handles before listening, so `dbReady` now
reflects Host availability rather than a Main-process SQLite handle.

Verification: Agent Protocol and Host builds pass. Desktop Main typecheck still
fails on existing repository diagnostics; filtered output contains no
diagnostics in `cli-api-server.ts`, `handlers/status.ts`, or
`desktop-host-api.ts`. No tests or live CLI/Host smoke were run.

## App Connection metadata — Data store and authenticated Host API (2026-10-12)

`app_connections` now has a transport-neutral metadata contract in
`@duya/agent-protocol`, a SQL DAO in `@duya/data`, and an authenticated local
Host API. Both `startLocalHost()` and Desktop's embedded Host composition
register the same store. Desktop's `AppConnectionService`, OAuth persistence,
token refresh, connector inventory, IPC reads, Agent Server catalog response,
and automation listener now await the Host client. The Desktop service no longer
constructs `ConnectionStore` from `getDatabase()`. The old synchronous
`ConnectionStore` remains only as a compatibility facade for store-level tests.

The contract carries connection metadata only. Access/refresh tokens, OAuth
client secrets, and remote-MCP OAuth state remain in `TokenVault`; no credential
fields were added to the Host API. Desktop still starts the Host HTTP server in
Main and opens its DB handle there, so this is a domain-level caller cutover,
not completion of independent Host process ownership.

Verification: Agent Protocol, Data, and Host builds pass. Desktop Main
typecheck exits 2 with broad diagnostics in the dirty checkout, including
App Connection flow/logger errors and unrelated CLI, gateway, channel, and
service errors; no clean baseline was available for comparison. No tests or
live Host smoke were run. `git diff --check` reports line-ending/trailing
whitespace findings across the pre-existing dirty workspace; they were not
normalized wholesale.

## Channel contracts — move shared DTOs out of the legacy Agent source path (2026-10-12)

Moved the channel platform vocabulary, connector manifests, address codecs,
inbound/outbound envelopes, delivery-failure DTO, connection config, and prompt
snapshot into `@duya/agent-protocol/channels`. Desktop Main now imports those
contracts from Agent Protocol instead of reaching into `packages/agent/src`.
The old Agent `channels/types` path remains as a compatibility re-export.
Credential values stay in the Desktop Secret Store and are deliberately not
part of the shared protocol.

Verification: Agent Protocol build and legacy Agent typecheck pass. Desktop
Main typecheck still exits 2 on the dirty-checkout diagnostics; the new
subpath-resolution errors were fixed by adding its explicit TypeScript path
mapping. Remaining channel diagnostics are in unchanged connector/runtime code
and the Desktop channel barrel's duplicate export. No tests or live connector
smoke were run.

## Channel wake prompts — move pure formatting into Host (2026-10-12)

Moved the pure channel wake prompt builders into `@duya/host/channel-prompts`.
Desktop's channel wake coordinator now imports the Host API, and the old Agent
source path remains a compatibility re-export. The builders depend on shared
Agent Protocol channel contracts and have no Electron or database I/O.

Verification: Agent Protocol and Host builds pass, and the legacy Agent
typecheck passes. Desktop Main typecheck still fails on the dirty-checkout
diagnostic set; filtered output contains no errors for the channel prompt or
channel contract imports. No tests or live wake smoke were run.

## Sidebar Sections — route persistence through Data and Host (2026-10-12)

Moved the sidebar-section SQL store into `@duya/data` and added a typed
`@duya/agent-protocol` contract plus authenticated local Host API. Both
`startLocalHost()` and Desktop's embedded Host composition register the same
store. Existing Desktop sidebar IPC channels now call the Host client instead
of constructing the store from `getDatabase()`; the old Main store path is a
compatibility re-export. This is a domain-level caller cutover only: Desktop
still owns the embedded Host process and database lifecycle.

Verification: Agent Protocol, Data, Host builds, and legacy Agent typecheck
pass. Desktop Main typecheck still exits 2 with 247 diagnostics in the dirty
checkout; filtering the output found no diagnostics for Sidebar Sections or
its new package subpaths. No tests or live Host smoke were run. Scoped
`git diff --check` reports only an existing LF/CRLF warning in the compatibility
re-export; no whitespace errors were reported.

## Usage summary — move database reads behind Host (2026-10-12)

The existing `db:usage:summary` IPC no longer reads `CoreDataStores`, opens a
Main SQLite handle, or constructs `CapabilityDao`. It gets all session
metadata, append-only timeline counts, and provider pricing from the
authenticated local Host API. Changed histories are loaded through the
existing paginated Host Session API and projected with the established message
adapter; Desktop retains the aggregation and facts cache. Data now owns the
read-only provider-model pricing query, and both standalone and embedded Host
compositions expose the same usage index. Timeline counts are fetched in one
indexed aggregate query, rather than one database query per session.

Verification: Agent Protocol, Data, and Host builds and legacy Agent typecheck
pass. Desktop Main typecheck exits 2 with 247 diagnostics in this dirty
checkout; filtering reports no diagnostics in the files changed for this
slice. No tests or live Host smoke were run.

## Browser download directory — read settings through Host (2026-10-12)

`cookie-writer.ts` no longer imports the legacy settings query. Browser startup
seeds the download-directory cache from `HostLocalSettingsApiV1`; the existing
`db:setting:set` and `db:setting:setJson` IPC paths refresh that cache after the
Host write, preserving live settings changes without a synchronous SQLite read
inside Electron's download event.

Verification: scoped `git diff --check` passes. Desktop Main typecheck exits 2
with the same 247 diagnostics seen in the dirty checkout; the reported errors
are on pre-existing lines in `index.ts`, with none in `cookie-writer.ts`,
`db-handlers.ts`, or the changed startup line. No tests or live Host smoke were
run.

The next large remaining Main-owned data surface is Conductor. Source review
found that `@duya/data`'s existing `ConductorStore` targets `duya-core.db`,
while the Desktop legacy canvas/action handlers still write `duya-main.db` and
share foreign-key/undo transactions. Moving only canvas CRUD to that store
would split one data domain; the cutover needs to move the related Conductor
tables and action/undo path together.

## Renderer transcript projection — move visibility boundary to Protocol (2026-10-12)

Moved the visible-transcript projection from `@duya/agent/message` to
`@duya/agent-protocol/transcript`. Desktop renderer now imports message
ingestion and projection from Agent Protocol, preserving the existing visible,
hidden, branched, and legacy DTO conversion behavior. This removes the
renderer caller's direct dependency on the legacy Agent package.

Desktop Main's `core-db-adapters.ts` still calls
`projectTimelinePersistenceMessages` from `@duya/agent/message`; that path
builds the Agent context and synthesizes compaction checkpoints, so the old
package remains a production dependency. This slice does not change database
ownership, Worker Manager placement, or real-run execution ownership.

Verification: `npm run -w @duya/agent-protocol build` passes. A focused
TypeScript check of `project-message-transcript.ts` and its imports passes. The
full Desktop renderer typecheck did not complete: it produced no diagnostics
for over a minute and was stopped, so it is not counted as a pass. No tests or
live Desktop smoke were run.

## Run Event Spine — move run lifecycle assembly into Host (2026-10-12)

Moved `createRunEventSpine` and its types into `@duya/host/run-event-spine`.
The production worker RunDriver now imports that implementation from Host; the
old Agent module remains a compatibility re-export for existing callers. Host
owns the Runtime-only run session, event stream, emitter, and terminal
candidate recorder. The RunDriver itself and provider/tool/context assembly
still live in `@duya/agent`, so this is a lifecycle boundary move rather than
Host-owned execution.

Verification: `@duya/host` and `@duya/agent` builds pass, and scoped
`git diff --check` passes. No tests were run.

## Agent DB bridge — project lookups through Host (2026-10-12)

The Agent DB bridge now resolves project paths, groups sessions by project,
and injects additional writable roots through the authenticated
`HostProjectApiV1`. It no longer calls `memory-state.listProjects()` or
bootstraps that database to answer project lookups. Path normalization uses
the shared Data utility, and project entity homes follow the shared data-root
resolver. The compatibility ProjectService also no longer defaults to
`getCoreStores()`; database-backed operations require an injected project DB
handle. This removes the bridge's direct project-read path and an implicit
Main database dependency; the listener and SQLite owner are still in Desktop
Main.

Verification: scoped `git diff --check` passes. Desktop Main typecheck remains
red from the dirty checkout's existing diagnostics; the only filtered errors
in `db-bridge.ts` are unrelated provider-config lines 1904–1923, and none were
reported in `projectService.ts`. The targeted ProjectService Vitest run could
not collect tests because Vite hit `EPERM` resolving
`node_modules/vitest/dist/spy.js`. No live Desktop smoke ran.

## Agent profile config — move config reads to Host (2026-10-12)

Moved the shared custom-agent config contract, `config.toml` reader, config-root
resolver, and path expansion into `@duya/host/agent-profile-config`. The legacy
Agent module remains a compatibility facade for `toAgentProfile`, while
Desktop's Agent DB bridge, Agent Server router, wake runner, memory worker, and
group-config writer now import config reads from Host. This removes those
production Desktop source imports from `packages/agent`; the Agent runtime
still constructs profiles and executes runs through the legacy package.

Verification: Data and Host builds, Agent typecheck, and CLI build pass. A
direct Node smoke confirmed config resolution honors `DUYA_DATA_ROOT` and reads
agent entries there. The shared data-path resolver also resolves the default
database to `<home>/.duya/duya-main.db`. A standalone `startLocalHost()` smoke
listened on loopback and opened `duya-main.db` plus `duya-core.db` under an
isolated data root without Electron. The built CLI's `duya serve --port 0`
smoke printed its loopback origin and Host runtime descriptor; shutdown was
requested with SIGINT, but a graceful-shutdown message was not observed.
Desktop Main typecheck still exits 2
with the existing provider-config diagnostics at `db-bridge.ts:1904–1923`; no
diagnostic points to the moved config boundary. The focused Vitest run could
not collect tests because Vite hit `EPERM` resolving
`node_modules/vitest/dist/spy.js`. No Electron runtime smoke ran.

`npm run architecture:check` was also attempted. Its temporary core-I/O entry
hit the Windows `EPERM` realpath failure; the scanner reports that as a new
finding, along with nine `@duya/agent` → `@duya/agent-core` findings from the
already-dirty Agent Core extraction. No Host-boundary finding was reported.
The architecture baseline was not rewritten.

## Previous Electron database migration — detect destination conflicts (2026-10-12)

Hardened `migratePreviousDefaultDatabases()` for the case where a standalone
Host created the new `.duya` database before Desktop migrated its previous
Electron-default database. Copies now include main/core/memory-state files and
WAL/SHM companions, retain the original files, and write a pending/completed
manifest so repeated startup is idempotent and interrupted copies can retry.
If old source files coexist with target files but there is no matching
completed migration manifest, startup fails instead of silently opening the
new target and hiding the old data. An existing completed manifest is scoped
to the exact source and destination paths. Standalone Host also recognizes a
`storage.database_path` value still pinned to the old Electron default as a
legacy default, so it migrates to the same `~/.duya` target as Desktop rather
than remaining on a split data path; other explicit paths remain honored.

Verification: Data, Host, and CLI builds pass. A direct Node smoke passed
copying the old database set, retaining sources, repeated-start idempotency,
conflict rejection, and starting `startLocalHost()` when `config.toml` still
points to the old Electron default; the new `.duya/duya-main.db` retained a
marker row from the old file. The new Data and Host test files pass standalone
strict TypeScript checking. The focused Vitest run could not collect because
Vite hit the existing Windows `EPERM` resolving `node_modules/vitest/dist/spy.js`;
`git diff --check` passes for the changed source and test files. Desktop and
standalone Host ownership still need to converge on one supervised process
after the remaining production database callers are cut over.

## Provider model capabilities — typed Host persistence (2026-10-12)

Added `HostLocalProviderModelCapabilityApiV1` and a Data-backed
`ProviderModelCapabilityStore` for `provider_model_capabilities`, with the
same authenticated HTTP routes in standalone Host and Desktop's embedded Host.
Desktop `ProviderStore` no longer constructs `CapabilityDao` or reads the
table through `getDatabase()`; its capability reads, writes, and runtime
resolution now await the Host client. Provider IPC, the Agent DB bridge,
provider initialization, wakeless chat, recap, and next-step callers were
updated to await the asynchronous contract. The built-in `@duya/ai` catalog
and config-marker precedence remain in `ProviderStore`.

This is a source-level caller cutover for one data domain. It does not move the
embedded listener or SQLite handles out of Electron Main, and the overall
database-owner and Worker Manager gates remain open. No typecheck, test, or
Electron smoke was run for this change yet.

## Timeline persistence projection — move Desktop Main to Protocol (2026-10-12)

Moved the pure durable timeline projection, including compaction checkpoint
markers and preservation of folded branched messages, into
`@duya/agent-protocol/transcript`. Desktop Main now imports that projector
directly instead of importing `@duya/agent/message`. The legacy Agent
persistence exports remain as compatibility facades over the Protocol
implementation. This removes one production dependency edge; it does not move
database ownership or the write itself out of Desktop Main.

Verification: Agent Protocol and Agent builds pass. Desktop Main typecheck
still exits 2 with 246 repository diagnostics; none point to the changed
projector or `core-db-adapters.ts`. Scoped `git diff --check` passes. No tests
or live Desktop smoke were run.

## Memory extractor — remove unused Main database handle (2026-10-12)

`Stage1Extractor` already requires the host-supplied `readMessageRows` port,
but its constructor also accepted `duya-main.db` without reading it. Removed
that unused handle from the extractor and `MemoryWorkerDeps`; Desktop's memory
worker bootstrap no longer calls `getDatabase()` to start extraction. The
worker still reads CoreStores for catalog synchronization and message rows,
and opens `memory-state.db` locally, so the memory database domain is not yet
Host-owned.

Verification: `@duya/memory` build passes. Desktop Main typecheck still exits 2
with 246 diagnostics; none point to the changed constructor or bootstrap
lines. The focused six-file Vitest run failed before collection with six
identical Windows `EPERM` errors resolving `node_modules/vitest/dist/spy.js`,
so no tests ran. No Electron smoke was run.

## Memory extractor — read transcript through Host (2026-10-12)

The Desktop memory worker now supplies the existing paginated
`HostSessionApiV1.readMessages` adapter to `Stage1Extractor`, instead of reading
`MessageLog` directly from `CoreStores`. The catalog-sync path still reads
session rows and `message_index` through CoreStores and performs project
identity registration against the core database. The worker also continues to
open `memory-state.db` in Main; this is a transcript-read cutover, not a
database-owner cutover.

No tests or typecheck were run for this small wiring change. The existing Host
message adapter reads all pages and retains the IPC message projection.

## Memory catalog reads — route through Host (2026-10-12)

Production Memory Worker catalog sync now receives an async
`MemoryCatalogSource` backed by authenticated Host APIs. It pages session
projections, reads paginated timeline index metadata, and resolves local
project paths through a separate `HostLocalProjectApiV1`; the worker no longer
receives CoreDatabase or SessionStore handles. `syncAllFromMainDb` remains for
legacy callers, but the production worker calls `syncAllFromHost`.

The Desktop Host adapter still implements project resolution using the legacy
Main resolver over Main-owned `duya-core.db`; the Host listener still runs in
Main, and the Memory Worker still opens `memory-state.db`. Standalone Host does
not yet compose the local project resolver or Memory Worker. This is a read
boundary cutover, not a database-owner or runtime-host cutover.

Verification: Desktop Main typecheck exits 2 on existing diagnostics in
`memory-worker.ts` unrelated to this change; the changed catalog and bootstrap
files have no diagnostics. Scoped `git diff --check` passes. No tests or
Electron smoke were run.

## Legacy project import — move into Data ownership (2026-10-12)

Moved the one-time `projects` / `project_bots` import implementation into
`@duya/data` and invoke it from `CoreDataHost` after core migrations. Desktop
Main and standalone Host now share the same read-only, marker-guarded import;
the duplicate startup block in `main/index.ts` is gone. The old Desktop module
remains as a compatibility re-export. `memory-state.db` remains untouched as
the import source, and no Conductor or Canvas persistence code changed.

Verification: `@duya/data` and `@duya/host` builds pass. Desktop Main typecheck
still exits 2 with the existing 246 diagnostics; the touched Data and import
modules have no diagnostics. Three existing diagnostics remain in unrelated
`main/index.ts` logger / screenshot callback code. The architecture gate could
not complete: its core-I/O scanner hit EPERM resolving a temporary entry file,
and its remaining boundary findings were in files outside this change. No tests
were run.

## Preserve Desktop rollout files during the database-root move (2026-10-12)

The default main database already resolves to `~/.duya/duya-main.db`, and its
startup migration copies the old Electron database set while retaining source
files. Desktop's rollout migration was still deriving its source from the new
database path, so old JSONL sessions under the former Electron data directory
could be missed. It now uses `legacyDbPath` when the resolver identifies the
previous default; custom database paths keep their existing source behavior.

Verification: Desktop Main typecheck still exits 2 with 246 diagnostics; the
filtered output has no diagnostics in `boot-config.ts` or `core-connection.ts`.
`git diff --check` passes for the changed files. No tests or Electron startup
were run.

## CLI dependency-closure build — keep the control plane off legacy Agent (2026-10-12)

The package build script now accepts `--target <workspace>` and selects the
target's transitive `@duya/*` dependency closure in the canonical build order.
`build:cli` and `typecheck:cli` use that path, so building the Host control-plane
CLI does not build the legacy `@duya/agent` workspace. The closure exposed that
Host depends on `@duya/agent-runtime`; Runtime is now ordered before Host.

The Runtime build also exposed an existing ambiguity: root `MessageContent`
referred to transcript blocks, while `RunEvent` payloads use the distinct event
block union. The protocol root now exports `EventMessageContent` explicitly,
and Runtime uses it at event translation and replay boundaries. This preserves
the transcript/event conversion instead of widening either contract.

Verification (2026-10-12): `npm run build:cli` passes, building 9 packages
through `@duya/cli` and excluding `@duya/agent`; `node
packages/cli/dist/index.js --help` exposes `serve` and exits 0. This proves the
CLI build and entry point only; Desktop database ownership and shared worker
execution remain outstanding. No test suite was run.

## RunEngine execution and settlement — move into Host (2026-10-12)

Added `executeRunEngine` to `@duya/host/run-engine-execution`. The Desktop
Worker's production `agent-process-entry.ts` → `driveRunWithEngine` path now
delegates RunEngine construction/execution, concurrent event draining, durable
terminal settlement, terminal publication, and stream closure to Host. This
uses the same Host-owned event spine. The Agent driver still creates
`DuyaAgent`, assembles the legacy-backed `RunEnginePorts`, and projects events
to the worker's existing frames; standalone chat CLI still runs its legacy
`DuyaAgent` path. This is a production execution-boundary move, not retirement
of `@duya/agent` or a shared Host Run API for CLI and Desktop.

Verification (2026-10-12): `npm run build:cli` passes for the 9-package CLI
dependency closure, excluding `@duya/agent`; `node
scripts/build-packages.mjs --target @duya/agent` passes for the 13-package
Agent dependency closure, including Host and the production caller. Scoped
`git diff --check` passes. No tests or Electron runtime smoke were run.

## Worker resource policy — move process limits into Host (2026-10-12)

Moved adaptive concurrency, memory threshold, per-worker heap sizing, idle
reaping decisions, configuration-to-environment mapping, and child worker
environment construction into `@duya/host/worker-limits`. The Agent Server's
chat manager, its router and interagent router, workflow workers, and Desktop's
Agent Server launcher now import that Host implementation. The old Desktop
module remains a compatibility re-export for existing tests and callers. Its
standalone worker-log fallback follows the shared `~/.duya/logs` data root.

This moves process policy and spawn configuration, not process ownership: the
concrete `WorkerManager`, chat `SessionManager`, and message/DB bridge still run
in the Desktop Agent Server. CLI and Desktop runs therefore still execute
through `@duya/agent`.

Verification (2026-10-12): `npm run build:cli` passes and compiles the Host
package. Desktop Main typecheck exits 1 on the repository's broad current
diagnostic set; filtered output contains no diagnostics in the moved policy,
WorkerManager, workflow runtime, or Agent Server lifecycle imports. Two
remaining diagnostics in `router.ts` are at unrelated call sites (1836 and
3502). No tests or Electron runtime smoke were run.

## Worker Manager — move supervision implementation into Host (2026-10-12)

Moved the child-process supervisor implementation into
`@duya/host/worker-manager`. The Desktop module is now an adapter that injects
the current Agent Server `SessionManager`, structured worker logger, and
packaged/development resource paths. Spawn, replacement, interrupt settlement,
background-subagent draining, idle reaping, and shutdown behavior now execute
from the Host package in the production Desktop path.

This is an implementation-ownership move, not yet an independent Host process
cutover. Electron still supervises the Agent Server that constructs the manager;
the adapter still supplies Desktop session state and resource paths; standalone
Host and CLI do not compose this Worker Manager; and workers still execute the
legacy `@duya/agent` entry point.

Verification (2026-10-12): `npm run -w @duya/host build` passes. Desktop Main
typecheck exits 1 on the broad current repository diagnostics; the changed
Worker Manager implementation and Desktop adapter have no diagnostics. The
filtered output shows one error in the unchanged Agent Server caller at
`index.ts:296`; the full output also contains unrelated router diagnostics at
1836 and 3502. The architecture check is not green: its Core IO scanner hit
`EPERM` while resolving a temporary entry file. It reported 11 unbaselined
violations in unrelated Desktop/provider and legacy Agent files; none points
to the new Host WorkerManager. No tests or Electron runtime smoke were run.

## Worker session state — move the in-memory registry into Host (2026-10-12)

Moved the Agent Server's session lifecycle state machine and bounded SSE event
buffer into `@duya/host/worker-session-registry`. The production Agent Server
still constructs the registry through a Desktop adapter to retain its
structured logger, while `SessionState`, transition validation, and session
record types now come from Host. This moves the implementation boundary; the
Agent Server process still composes it, and the worker entry still loads the
legacy `@duya/agent` package.

Verification: `npm run -w @duya/host build` and full `npm run typecheck:all`
pass. The Electron ratchet reports no new type errors (245 known across 121
keys; 28 baseline keys shrank or disappeared). The raw Desktop Main typecheck
still reports repository diagnostics, none in the new Host registry, Desktop
adapter, or type re-exports. No tests or runtime smoke were run.

## Host Run execution API — the Host starts and cancels real runs (2026-10-12)

Gate 3's first half is landed: the standalone Host now OWNS execution, not
just the ledger. `HostRunExecutionApiV1` (`@duya/agent-protocol/run-api`)
exposes `startAgentRun` / `cancelAgentRun`; `POST /v1/agent-runs/start` and
`POST /v1/agent-runs/:id/cancel` serve it; `HostSessionHttpClient` speaks both.

`HostRunExecutionController` (`@duya/host/run-execution`) composes the pieces
that already existed instead of adding a second anything: the Host WorkerManager
spawns the production worker entry, `RunOrchestrator.openRun` freezes the
manifest and dispatches `chat:start` through `createWorkerExecutionChannel`,
`createRunControlPlaneActions` serves `run:create/append/complete/events`
IN-PROCESS over the same RunStore the ledger API reads — no second writer, no
second seq space — and worker frames are normalized by `worker-frames.ts`
(the Desktop router's normalizer moved into Host) and observed into durable
`run_events`. Worker `db:request` frames are served by
`createHostWorkerDbBridge` (run ledger, session reads, settings reads,
tool-approval domain); every not-yet-migrated domain fails FAST with a typed
`WorkerDbBridgeError('unimplemented_domain')` instead of silently timing out —
the bridge is a discovery surface for gate 1's remaining domains, not a facade.

`duya serve` now starts execution when a worker entry is available
(`DUYA_HOST_WORKER_PATH`, else the repository's agent bundle path); without one
it stays a ledger-only Host and says so. `startLocalHost` gained
`workerPath` / `betterSqlite3Path` options and stops supervised workers on close.

Verification (2026-10-12): `packages/host/tests/run-execution.test.ts` (3
tests, real forked worker processes, real HTTP, real SQLite in a temp data
root) — start → dispatch → durable events (`assistant.text_block`,
`run.completed`) → settled `completed` → replay reads the same sequence;
cancel → interrupt → grace → SIGTERM → settled `cancelled` durable; unknown
session refused with `refused_no_session`. Full `packages/host/tests/` suite
9/9. `npm run -w @duya/agent-protocol build`, `npm run -w @duya/host build`,
`npm run -w @duya/cli build` pass.

Deliberately NOT done yet, in order:
1. The worker entry is still the legacy `@duya/agent` bundle (gate 3's port
   extraction; the ledger-side composition is clean, the worker is not).
2. The worker db bridge covers only the domains listed above — a basic
   conversation will fail fast on message-write actions until the message
   domain's converters move into a Host-owned module.
3. CLI chat (`packages/agent/src/cli`) is still an in-process executor; the
   HTTP start/cancel client exists but the chat entry has not been cut over
   (gate 4).
4. Desktop still supervises the Agent Server rather than an independent Host
   (gate 2), and its Desktop Host API adapter does not yet compose the
   execution controller.

## CLI chat over the Host — the vertical chain is live end to end (2026-10-12)

Gate 4 is landed: `duya chat` (packages/cli) is a pure Host HTTP client —
`startAgentRun` → `watchAgentRunEvents` (replay + follow) → `cancelAgentRun`.
It contains NO agent runtime: no `DuyaAgent`, no `@duya/agent` dependency edge
(verified: packages/cli has neither `@duya/agent` nor `@duya/agent-runtime` in
dependencies; apps/desktop has neither either). Session creation, resume
(`--session`), per-run provider/model/apiFormat overrides (`--provider`,
`--model`, `--api-format`), and SIGINT→cancel are all served through the Host.

Supporting changes:
- The worker now SELF-INITIALIZES when no `init` arrived: `buildSelfInitMessage`
  resolves the provider from local config.toml + secrets.json only, honouring
  the run manifest's frozen agent selection (`manifest.agent.providerId/model`)
  over `[model].provider`. The Host never sees a credential.
- `resolveProvider` gained an explicit-provider-id parameter for the manifest
  override.
- Standalone Host now serves `localSessionApi` (the local session projection),
  which `duya chat --session` reads to resume.
- Host WorkerManager no longer swallows `db:request` (the Desktop router's
  per-request handler was copied into the Host composition long ago; the Host
  controller serves it through the worker db bridge).

RUNTIME EVIDENCE (real processes, real model):
- `duya serve` (standalone process, `DUYA_DATA_ROOT=.e2e-host`) + `duya chat
  --print "只回复四个字：链路通了" --provider deepseek --model deepseek-v4-pro
  --api-format openai` → run `daafedf0` **completed**; the model answered
  「链路通了」; durable events: run.started, assistant.thinking_block,
  assistant.text_block, assistant.usage (input 25,893 / output 18),
  run.completed. Replay over `GET /v1/agent-runs/:id/events?afterSeq=0`
  returns the same durable sequence.
- Second turn in the same session (`--session sess-968f5b1f…`) asked the model
  to quote its previous answer — it replied 「链路通了」, proving the session
  transcript round-trips through Host persistence to the worker's context.
- Cancel: a long generation was cancelled via `POST /v1/agent-runs/:id/cancel`
  → `requested: true`, the model stream was actually aborted, and the run
  settled durably. KNOWN GAP: the terminal was `failed("stream ended without
  finish_reason")` rather than `cancelled` — the worker's interrupt path
  reports `chat:error`, whose `run.failed` envelope wins the one-shot CAS
  before the cancel arbiter settles. This is the shared
  orchestrator/controller semantics (not Host-specific), recorded as a
  follow-up: the worker must report a cooperative stop frame on interrupt.
- Provider override proven by error provenance: minimax-cn quota 429 (2056)
  before the manifest-override fix, glm-cn balance 429 (1113) after switching
  `--provider glm-cn` — each request hit the provider it named.

Remaining, in order:
1. Worker entry is still the legacy `@duya/agent` bundle (gate 3 port
   extraction A5–A7) — the CLI/Desktop production dependency graphs no longer
   contain `@duya/agent`, but the spawned worker process is still its bundle.
2. Worker interrupt should report a cooperative stop so cancel lands
   `cancelled` instead of racing `run.failed`.
3. Desktop still supervises its in-process Agent Server (gate 2); its Host
   adapter does not yet compose the execution controller.
