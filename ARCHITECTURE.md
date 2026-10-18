# Architecture

> Last updated: 2026-10-12

## Overview

Monorepo / Agent Harness changes follow the single execution plan
[587](./docs/exec-plans/active/587-agent-harness-monorepo/README.md).
Its contracts and phase gates define the target; this document describes
the current implementation. Historical RFCs and migration schedules are
centralized in that plan's reference directory.

DUYA is a Windows desktop AI agent client with a modular architecture:

- **Frontend**: Vite + React 19 + Zero Router (Electron renderer)
- **Desktop Shell**: Electron 44 (Main Process)
- **Agent runtime**: `@duya/agent-runtime` owns run identity, event ordering,
  and the model/tool/context port contracts.
- **Worker assembly**: `@duya/host` owns the product session, concrete tool
  registry composition, worker command loop and run-context bindings.
  `@duya/cli` supplies the command runner at the worker bootstrap; Host does
  not import CLI. `packages/host/bundle/worker-entry.js` is the new executable,
  with packaged location `resources/harness-bundle/worker-entry.js`.
  Legacy Agent import adapters remain pending final retirement verification.
- **Duya Host**: `@duya/host` is Electron-independent and owns the local
  session/timeline/archive, project metadata, parsed-document attachment,
  settings APIs, config-driven Agent profile reads, session permission-profile
  resolution, Control Plane service contracts, worker-session state, worker
  supervision, Run orchestration, and RunEngine settlement. `HostRunExecutionApiV1`
  (`POST /v1/agent-runs/start|cancel`) lets the standalone Host START and CANCEL
  real runs: the Host WorkerManager spawns the worker, the RunOrchestrator
  freezes the manifest and dispatches `chat:start`, run Control Plane actions
  execute in-process over the same `RunStore` the ledger API serves, worker
  frames are normalized and observed into durable `run_events`, and worker
  `db:request` frames are served by the Host worker bridge (unmigrated domains
  fail fast with a typed error). The worker self-initializes from local
  config when no `init` arrived, honouring the run manifest's frozen provider
  selection. Standalone
  `duya serve` owns its database handles; `duya chat` is a pure Host HTTP
  client (start/replay/cancel, session resume, provider overrides) with no
  `@duya/agent` dependency edge — verified live end to end against a real
  model through the standalone Host. Desktop still composes the Host
  listener over Main-owned handles, and its Agent Server still supplies the
  worker command channel. Desktop and standalone launch selectors now target
  the Host worker bundle. The new child startup/command channel has been
  verified; complete CLI/Desktop execution with the old package absent remains
  pending.
- **AI Layer**: `@duya/ai` multi-protocol adapter
- **Database**: SQLite via better-sqlite3; default data root is `~/.duya`,
  with `DUYA_DATA_ROOT` overriding the shared root for databases, rollouts, and
  attachments. The default main database is `duya-main.db` beside
  `duya-core.db` and `memory-state.db`; `storage.database_path` remains an
  explicit main-database override.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vite 6, React 19, Zero Router, Tailwind |
| Desktop Shell | Electron 44 |
| Build | esbuild, electron-builder |
| Agent Core | TypeScript |
| Database | better-sqlite3 (FTS5, trigram) |
| Testing | Vitest, Playwright |

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Process layer 1 - Electron Main Process                    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │  Core   │ │ Config  │ │ Memory  │ │ Agents  │            │
│  │   DB    │ │  Store  │ │  State  │ │ Manager │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │   IPC   │ │Services │ │Gateway  │ │  Auto-  │            │
│  │ Handlers│ │         │ │         │ │ mation  │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  spawns ↓ (ELECTRON_RUN_AS_NODE=1)                          │
├─────────────────────────────────────────────────────────────┤
│  Process layer 2 - Agent Server (HTTP + SSE)                │
│  agent-server.js / router.ts / @duya/host/worker-manager    │
├─────────────────────────────────────────────────────────────┤
│  Process layer 3 - Agent Workers (fork, one per session)    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  @duya/agent (workspace package)                      │  │
│  │  @duya/ai (multi-protocol LLM adapter)                │  │
│  │  entry: agent-process-entry.js                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  React 19 + Zero Router                             │   │
│  │  Components: Chat, Layout, Settings, Automation...   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## IPC Architecture

DUYA uses three communication patterns:

### 1. IPC Invoke/Handle (Request-Response)

For CRUD operations, config, database queries:

```
Renderer → preload → IPC Channel → Main Process Handler → SQLite/FileSystem
```

Channels: `db:*`, `config:*`, `gateway:*`, `automation:*`, `logger:*`

### 2. Agent Server (HTTP + SSE)

For streaming AI conversations:

```
Renderer → Agent Server (HTTP POST) → Worker Process → LLM
                                     ↓
                              SSE Stream → Renderer
```

- The Agent Server is a **separate spawned child process**, not an in-process
  HTTP server: `spawnAgentServer` launches it as `process.execPath` +
  `spawn(agent-server.js)` under `ELECTRON_RUN_AS_NODE=1`
  (`apps/desktop/src/main/agents/agent-server-lifecycle.ts:118,122`).
- Each session is backed by its own Worker Process, forked lazily and keyed by
  session id (`packages/host/src/worker-manager.ts:97`, composed through the
  Desktop adapter at `apps/desktop/src/main/agents/server/worker-manager.ts:48`,
  entry `agent-process-entry.js`). Settled workers idle past the TTL are reaped
  (`packages/host/src/worker-manager.ts:538`) and the next request takes the
  same lazy-spawn path.
- Streaming via Server-Sent Events

### 3. MessagePort

For high-frequency data: tool execution, tool streaming, config sync.

Exactly three channels are registered at runtime — `config`, `toolExec`,
`toolStream` (`apps/desktop/src/main/index.ts:431-437`). `agentControl` is
**not** a live channel; it was removed in Phase 7.1 of plan 53. The stale
`agentControl` entry still listed in `DEFAULT_CHANNEL_DEFINITIONS`
(`apps/desktop/src/main/types/port-types.ts:136`) is re-exported but has no
production consumer, so it opens no port.

## App Connections (Connectors)

Unified AppConnector registry (Plan 455): first-party providers, plugin `.app.json`
declarations (`mcp-remote` / `rest` bindings), and custom connectors, resolved by
`apps/desktop/src/main/services/app-connections/app-connector.ts`. Tokens live in the main
process (encrypted vault) and never cross IPC.

Connection metadata (`app_connections`) now follows a typed
`HostLocalAppConnectionApiV1`: `@duya/data` owns `AppConnectionStore`, and both
the standalone Host and Desktop Host composition serve it over authenticated
loopback HTTP. The Desktop OAuth and connector services use the Host client for
list/get/upsert/status/remove calls. Tokens and OAuth client secrets remain in
Desktop's encrypted `TokenVault`; they are not fields in the Host contract.
Desktop still hosts this API inside Main and owns the database handle, so this
domain cutover does not yet mean the whole Desktop data owner runs outside
Electron.

Auth elicitation loop (Plan 450 Phase B + Plan 498):

1. Connector invoke fails with `connector_auth_required` → worker emits
   `chat:connector_auth_required` → agent server SSE → renderer auth card.
2. Tool result tells the model to end its turn and wait (no retry, no links).
3. `appConnection:connect` (card button or Settings) completes the OAuth
   loopback → main broadcasts `app-connection:connected` to all windows.
4. Card flips to its real connected state and ChatView sends a localized
   resume message (mailbox-queued if a stream is active) so the model re-issues
   the failed call; per-provider dedup keeps it to one resume.

The system prompt carries a persistent "Apps (Connectors)" section
(`packages/agent/src/mentions/index.ts` — connected-app catalog plus the
help-the-user-connect guidance: prefer connectors over browser workarounds,
name missing services, never paste authorization URLs).

### Channel Attachments (Plan 507)

Per-bot channel connectors (`apps/desktop/src/main/channels/*-connector.ts`) and the gateway
route path carry inbound media to the bot and upload outbound files to the
platform. Two data flows:

- **Inbound persist + path injection**: adapters (`gateway-manager.ts`
  `forwardInbound`, Feishu/Weixin/TG deep adapters) download media to temp
  cache; the main process persists each to stable storage via
  `apps/desktop/src/main/channels/attachment-store.ts` →
  `~/.duya/agents/<ownerId>/attachments/inbound/<platform>/<ts>_<name>`
  (shared agents root, plan 526; atomic write, per-kind size caps mirroring
  `attachment-builder.ts`, traveral
  guard on owner/platform/name). The `ChannelInboundEnvelope.attachments`
  contract lives in `@duya/agent-protocol/channels` and feeds
  `packages/host/src/channel-prompts.ts`, which renders
  `[attachment saved to: <path> (...)]` lines under each inbound message so the
  bot can Read/Bash the file. Oversize/unreadable entries become
  `[attachment skipped: <reason>]` lines instead.
- Channel addresses, connector manifests, inbound/outbound envelopes, and
  connection metadata are shared Protocol contracts. Desktop Main imports
  `@duya/agent-protocol/channels` directly; the legacy Agent path re-exports
  them during migration. Credential-value records remain private to the local
  Secret Store and are not part of the shared contract.
- Pure channel wake prompt builders live in Host and consume those Protocol
  contracts. Desktop Main uses the Host package export; the legacy Agent path
  remains a compatibility re-export during migration.
- **Outbound real upload**: `SendMessage type:"attachment"` with a `file://` url
  becomes a `MediaReply` (`gateway` `NormalizedReply.type==='media'`) mapped in
  `apps/desktop/src/main/channels/connector-runtime.ts` (feishu/weixin live adapters) or a
  multipart send in `apps/desktop/src/main/channels/channel-delivery.ts` (`file-url.ts`
  decodes `file://` and infers MIME/key); media type follows MIME:
  image→photo, audio→voice, video→video, else document. A missing/empty file or
  `https://` url degrades to the existing text-with-link. Slack stays
  text-with-link.

### Gateway = Router + Status Broadcast (Plan 520)

`packages/gateway` serves the **legacy direct-channel line** only (settings
BridgeSection bindings). Bots ride the per-bot `apps/desktop/src/main/channels` pipeline
and never touch it. The gateway subprocess no longer:

- resolves sessions (`user-mapper.ts` deleted) — Main resolves/creates the
  session from the `gateway_user_map` row in
  `message-bus.ts:resolveOrCreateGatewaySession`;
- executes slash commands — `commands/dispatcher.ts` detects known commands
  and wraps them as `gateway:inbound { kind: 'command', command, args }`;
  Main executes help/new/reset/clear/status/stop and answers via
  `requestChannelSend`;
- gates senders — pairing (`gateway:pairing:*`, `/pair` `/approve` `/deny`) is
  fully removed;
  Main enforces a per-platform channel allow-list
  (`channel-directory.ts`, settings key `gateway_allowlist`, empty list =
  open) and replies `gateway:inbound:response { authorized }`.

Gateway session rows and metadata are created or updated through the
authenticated Host Session API. Main registers the selected local directory
with Host and stores its opaque Workspace reference; inbound handling waits for
the Host write before enqueueing the Agent wake. `gateway_user_map` reads and
writes now use a typed, authenticated local Host API backed by Data's
`GatewayUserMapStore`; Gateway IPC actions and CLI channel listings use that
same API. Network bridge tests and proxy discovery read channel credentials,
Weixin accounts, and proxy settings from their canonical ConfigStore source,
not stale SQLite mirrors. Desktop still composes the listener over its database
handle, so the independent Host process owns the API contract but not yet
Desktop's database startup or lifecycle. Gateway channel directory, sender
mapping, allow-list, bridge config, and auto-start settings now use
authenticated local Host APIs backed by Data stores; the legacy `threads`
projection is included. Gateway Main now has no direct SQL calls, though
Desktop still supplies the listener's database handle.

Busy handling is a Main→Gateway broadcast:
`gateway:agent_busy { platform, platformChatId, busy, ok }` — set when a wake
is enqueued, cleared by `forwardToGateway` on the terminal
`chat:done`/`chat:error`. Each adapter's `busy_input` option decides
queue (buffer + flush on idle) / steer / interrupt locally; the working
reaction (🤔→👍/👎) and typing indicator are the user-facing bot-status
signal. Retained: CLI control-plane proactive send
(`duya channel send` → `POST /v1/channels/send` → `requestChannelSend` →
`gateway:send` → `GatewayManager.sendMessage`) and plan 507 inbound
attachment persistence.

## Database

### Location

- Default on all platforms: `~/.duya/duya-main.db`; `duya-core.db` and
  `memory-state.db` are siblings. Startup copies the previous
  Electron-default database set into `~/.duya` and retains the old files as
  recovery copies. Desktop startup also relocates rollout JSONL files from the
  previous default database directory into the configured rollout root.
- An explicit custom `storage.database_path` in `~/.duya/config.toml` remains
  authoritative. A value still pointing at the former Electron default is
  treated as a legacy default and migrated. E2E namespaces keep their
  checkout-scoped database root.
- `DUYA_DATA_ROOT` overrides the default root for a local Host deployment;
  `storage.database_path` remains the more specific main-database override.

### Current ownership

`@duya/data` is Electron-independent and owns the shared data-root and
database-path resolvers, safe copying of the previous default database set,
the shared SQLite opener, the `duya-core.db` `CoreDatabase` migration runner/WAL
checkpoint, and `CoreDataHost`, which composes that connection, migrations,
MessageLog, archive-row recovery, the idempotent import of legacy project rows
from `memory-state.db`, and the `CoreDataStores` factory. It also owns
the durable `RunStore` for `runs` and `run_events`, and the reusable Task,
PermissionLedger, Lock, Goal, SpawnEdge, Attachment, ModeState, Session,
Mailbox, Project, Research, Conductor, PendingWake, ToolApproval, SendMessage
side-state, Workbench, and import-batch stores. Desktop's `db/core` files for these stores
are compatibility exports, and its `CoreStores` lifecycle uses `CoreDataHost`.
`AppConnectionStore` also owns the `app_connections` table queries; connection
metadata reads and writes from the Desktop service cross the local Host API.
Sidebar section persistence follows the same boundary: `@duya/data` owns the
`sidebar_sections` and project-assignment queries, `@duya/agent-protocol` owns
the DTO/API contract, and `@duya/host` exposes them over the authenticated
local Host API. Standalone and Desktop Host compositions inject the same Data
store; Desktop's existing sidebar IPC is now a Host-client adapter. This moves
that domain's production callers off direct Main database access, while the
embedded Desktop Host still shares Main's process and database lifecycle.
The usage-summary IPC keeps its existing response and aggregation behavior,
but obtains session metadata, append-only timeline versions, and provider
pricing through the authenticated local Host API. Changed histories are read
through the paginated Host Session API; the aggregation and facts cache remain
in Desktop Main for now. `ProviderModelPricingStore` in `@duya/data` owns the
pricing query used by both standalone and embedded Host compositions.

Previous Electron-default migration stages the main, core, and memory-state
database files together with any WAL/SHM companions, then records a completion
manifest under the new data root. Startup retries a pending migration before
opening SQLite and refuses to open when old source files and unrecorded target
files conflict. The old files remain as recovery copies.

`@duya/data` resolves the default data root to `~/.duya`; the default main
database is `~/.duya/duya-main.db`, with the core and memory-state databases as
siblings. It owns the `duya-main.db` and `duya-core.db` handles and their
open/checkpoint/close lifecycle through `DatabaseHost`, `MainDatabase`, and
`CoreDataHost`. Desktop creates one `DatabaseHost` for its main process and
keeps compatibility accessors. Desktop's `schema.ts` supplies its logger and
plugin connection-slug derivation port. The Electron-free `startLocalHost()`
composition also opens `DatabaseHost`, performs previous-default migration and
legacy import, and serves the Host APIs. CLI can start this composition when no
Host descriptor is available, but it currently runs in the CLI process rather
than under a separate supervisor. Desktop still opens its own database handles
in Main; moving startup, safe-mode policy, and shutdown ownership to an
independent Host process remains unfinished.

`@duya/agent-protocol/session-api` now declares the async `HostSessionApiV1`
contract for session metadata and the append-only durable timeline. Its wire
entries cover message, compaction, and rollout events; append retries use the
stable entry IDs already enforced by `MessageLog.appendBatch`. `@duya/host`
now provides an Electron-free implementation backed by injected `@duya/data`
session and MessageLog stores. Desktop's CLI
HTTP `GET /v1/sessions`, `GET /v1/sessions/:id`, `POST /v1/sessions`, and
`POST /v1/sessions/import` routes use that service for session reads, creation,
and timeline append. It also owns session archive/unarchive, including
subtree lock checks, rollout-file movement, metadata rollback, and legacy
archive recovery. The list route preserves the existing archived-session,
limit/offset, and response-field behavior. The Agent Server's message
add/append/replace bridge actions and renderer `db:message:add`/`replace` IPC writes also use
`HostSessionApiV1.appendTimeline`; batch append preserves the explicit
`turnId` index. Agent Server and renderer timeline-count reads use
`HostSessionApiV1.countTimeline`. These callers still compose the service
inside Main from `getCoreStores()`, and other database write paths remain
direct. Session metadata and rollout-text searches now use
`HostSessionApiV1.searchSessions` and `searchMessages` over authenticated Host
routes; Desktop IPC and Agent DB bridge adapters retain the legacy result DTO
and rehydrate local-only session fields through the Host's local projection.
The CLI control-plane session handlers also use these authenticated routes:
search scopes rollout matches through Host, and export reads the message
projection plus local-only session metadata through Host instead of opening
`CoreStores` directly.
The masked provider-config IPC reads the selected provider/model through
`HostSessionApiV1.get`, and Agent Process Pool title-generation messages update
session metadata through `HostSessionApiV1.update`; neither path reads or writes
`CoreStores` directly anymore.
The pure `AgentMessage`-to-legacy-row projection for durable timeline writes,
including compaction checkpoint synthesis and folded branch preservation,
lives in `@duya/agent-protocol/transcript`. Desktop Main imports it directly;
the legacy `@duya/agent/message` persistence exports delegate to that same
implementation. The projector has no database or transport access.
The Desktop CLI `POST /v1/messages/send` route appends through
`HostSessionApiV1.appendTimeline`, and channel-disconnect fallback discovery
pages session profiles through `HostSessionApiV1.list`.
Recap and next-step suggestions now page the same Host message projection and
adapt it to their existing prompt DTOs; their Main services no longer query
`MessageLog` directly.
Research and Research Memory actions from the Agent DB bridge now use the
allowlisted `HostResearchApiV1` over authenticated `POST /v1/research/actions`.
Desktop and standalone Host compose the same Data-backed service, and the
Desktop bridge no longer opens `CoreStores` for this domain. The action names
are bounded by Protocol, while the legacy payload DTO remains a record-shaped
compatibility contract that can be tightened per operation later.

`@duya/agent-protocol` now declares `HostRunApiV1` for Agent Run create/get/list,
durable event append, terminal settlement, and paginated event reads. `@duya/host`
backs it with Data's `RunStore`, preserving manifest/input idempotency, event
identity conflict checks, and terminal compare-and-set. Both standalone
`startLocalHost()` and Desktop's current Main-owned listener expose the API over
the authenticated loopback transport. CLI chat passes that client to
`HeadlessRunHost`: it writes the Run row before dispatch, appends Runtime events
through Host, and settles the terminal there. This is the first shared durable
Run ledger path, not Host-owned execution. CLI still assembles the executor
through `@duya/agent`; Desktop Agent Server now routes every `run:*` command
through the same API after Main's Control Plane authenticates its child-process
sender. The Desktop API adapter still reaches Main-owned SQLite handles.
The active Host execution API also streams canonical events from a bounded,
process-local channel. Ephemeral assistant text and thinking deltas travel only
on that live channel; after it closes, the SSE endpoint resumes from the durable
ledger for the committed terminal and later replay. This does not provide
attach or resume for a live run.
The production worker's RunDriver now imports the Runtime-only event-spine
factory from `@duya/host/run-event-spine`; the old Agent path is a compatibility
re-export. Host owns the run session, event stream, emitter, and terminal
candidate recorder. The RunDriver and its `DuyaAgent` provider/tool/context
assembly remain in `@duya/agent`, so execution ownership has not moved to Host.
The worker supervision implementation now lives in `@duya/host/worker-manager`.
Desktop Agent Server supplies adapters for its in-memory session state, logger,
and packaged worker paths, and still constructs the manager inside the
Electron-supervised Agent Server process. Standalone Host and CLI do not yet
compose this manager, and its worker entry still runs the legacy `@duya/agent`
engine.
The production `RunOrchestrator` and worker execution-channel adapter now live
in `@duya/host/run-orchestrator`; Agent Server imports that Host subpath and
injects its DB bridge, worker channel, and logger. The old Agent Server module
re-exports the Host implementation for compatibility. This moves source
ownership only: Desktop still constructs the orchestrator, and standalone Host
does not yet compose it or execute chat runs.

Desktop's compatibility exports in `control-plane/run-control-plane.ts` also
dispatch through the authenticated Host Run API client. The production Agent
Server path and older direct callers therefore share the same persistence
boundary; Main no longer opens `CoreStores.runs` in this adapter. Control Plane
composition and sender authorization remain in Main.

The child-session card reads its session through that local projection and its
diff totals through Host; `@duya/data`'s `ChatTurnReviewStore` owns the query
against `chat_turn_reviews`. Child-run cancellation targets the Host-owned
Worker Manager implementation through the Desktop Agent Server adapter; the
Agent Server process lifecycle remains Desktop-supervised.
Desktop session/timeline IPC and Agent Server bridge calls now use a
`HostSessionHttpClient` against that same loopback listener. Main starts the
listener after the core stores are ready and before the Agent Server can send
database bridge requests; `startCliApiServer()` reuses it. This gives Desktop
and CLI the same transport contract while Electron Main still owns the server
and database handles. `db:message:getBySession` now reads the Host's
message/compaction projection through that client and converts it with the
existing IPC row adapter; source-filtered bot-direct transcript reads now use
the Host message API, which applies the source allowlist before paging.
Agent Server `message:getBySession` and `session:loadMessages` reads also use
that projection; parsed-document attachment lookup remains a Main-owned
compatibility path.
Desktop rewind and timeline deletion now use Host operations too.
`readProjectedTimeline` preserves the repaired/rebased projection and process
events needed by rewind; the IPC adapter restores file snapshots from that
projection before appending the edit-resend rebase through Host. The explicit
file-restore IPC reads the same projection, and timeline deletion clears the
search index while retaining rollout files. Host append receipts include the
number of newly indexed entries so bridge callers can report counts without a
separate Main-side count query. `WorkspaceStore` UUID generation now uses the
ESM `node:crypto` import, so local directory registration works in standalone
Host processes.
Session forks now use `HostSessionApiV1.forkAt`: Host reads the repaired source
timeline, copies messages through the selected checkpoint with remapped IDs,
creates the child session and Workspace binding, and records the `fork` lineage
edge. The Desktop IPC handler keeps the existing response shape and adapts the
Host result to its legacy session row DTO. Whole-store rollout reconciliation
also runs through `HostSessionApiV1.reconcileRollouts`; Host rebuilds the
`message_index` projection from rollout files under its configured root.
Rollout export, import, and index reconciliation now run through Host. Export
and import use a local capability over the authenticated loopback API,
including standalone `duya serve`; only this local surface accepts filesystem
paths. A future remote API will need an upload contract instead of server paths.
Claude/Codex transcript import also creates and rolls back session records
through a local Host capability; parsed timeline entries append through the
Host Session API in bounded batches. Desktop keeps the source-format parser and
import UI, while Host owns the SQLite writes for this path. The listener and
database handles remain in Electron Main.
Terminal command history now follows the same Protocol/Data/Host boundary:
Data migration 59 creates `terminal_command_history`, and `TerminalHistoryStore`
owns its suggestion and upsert queries. The authenticated local-only Host API
serves both standalone Host and Desktop; Desktop's terminal manager and IPC
handlers use its HTTP client instead of opening the database. Command content
stays on this local surface because it can contain secrets. Desktop still
composes this listener over Main-owned database handles, so this removes one
direct caller without transferring process ownership.
Wakeless chat now resolves its configured workspace through the same local
Host Settings API before dispatch instead of synchronously reading Main's
SQLite handle. If the Host settings read fails, the request is rejected rather
than dispatched with a guessed working directory.
Workflow-run DTOs now live in Agent Protocol, with Data re-exporting the legacy
type names. Persistence has a typed async boundary in `WorkflowRunApiV1`:
standalone Host and Desktop compose it from the Data store, and Desktop's Agent
DB bridge, workflow IPC, and startup crash reconciliation use the authenticated
`HostSessionHttpClient`. The listener and SQLite handles are still created by
Electron Main; only the API path has migrated.
Session-goal DTOs and the async `HostGoalApiV1` contract now live in Agent
Protocol. Data implements idempotent per-session `getOrCreate`, and Host
composes the API for both standalone and Desktop adapters. Goal reads, budget
deltas, status changes, and status-filtered lists from Desktop IPC and the Agent
DB bridge now cross the authenticated Host HTTP client. The existing IPC row
shape is adapted at the boundary. This still uses Desktop Main's database
handles until Host process ownership moves out of Electron.
Mode tracker snapshot DTOs now live in Agent Protocol, with Data re-exporting
the compatibility row type. Host exposes async read, upsert, status, and
per-session list operations; the Agent DB bridge and Desktop cold-load IPC use
the authenticated Host client instead of accessing `ModeStateStore` directly.
This moves another persistent runtime-state domain behind Host while its
listener and database owner remain in Electron Main.
The legacy interactive `permission_requests` ledger has a typed
`HostPermissionRequestApiV1` contract in Agent Protocol, a Data-backed Host
service, and authenticated HTTP/client routes. Desktop permission IPC and the
Agent DB bridge use those routes for create/get/resolve while preserving the
existing snake_case IPC rows. The separate approval-card ledger has a
`HostToolApprovalApiV1` contract for create/get/list, first-wins resolve,
one-shot consume, and scoped grant rules. Standalone Host and Desktop compose
the same Data-backed service; Desktop's Worker DB bridge and approval IPC use
the authenticated client. This keeps Run Protocol permission events, the
interactive request ledger, and approval-card state as distinct durable facts.
Widget response, cursor-agent card lifecycle, and pending-secret side-table
writes now use the `HostLocalSendMessageStateApiV1` over authenticated local
routes. Data owns the SQL adapter, while the Agent DB bridge preserves its
existing success/error response shape. Desktop still supplies Main's database
handle to this Host composition, so independent Host process ownership remains
outstanding.
The Agent model-capability cache also has a typed local Host API backed by
Data's `ModelCapabilityStore`; the DB bridge preserves normalized names and
the existing SQL-row/`{ success }` response shapes.
Provider model overrides in `provider_model_capabilities` now have their own
typed `HostLocalProviderModelCapabilityApiV1`, backed by Data's
`ProviderModelCapabilityStore`. Desktop's `ProviderStore` keeps the config and
built-in catalog precedence, while capability list/get/upsert/delete and
runtime resolution cross the authenticated Host client. Its IPC, Agent DB
bridge, provider initialization, wakeless chat, recap, and next-step paths
await that API instead of opening the table through `CapabilityDao`. The
Desktop Host listener and database handles still live in Electron Main, so
this moves the domain behind the Host contract without completing process
ownership.
Plugin setup values, which may contain credentials, are read, atomically merged,
and cleared through a local-only Host API backed by Data. The routes require the
Host token and loopback binding. Desktop primes PluginManager's synchronous
setup-state projection through this API after the Host client starts; the old
Main-owned `PluginSetupStore` and its direct SQLite calls are removed.
Channel session bindings and adapter offsets also use a typed local Host API
backed by Data's `ChannelPersistenceStore`. Desktop IPC, the Agent DB bridge,
Gateway health projection, and Telegram offset persistence now go through this
authenticated API; the connector no longer issues channel SQL itself. Desktop
still supplies Main's database handle to the embedded listener, so the API
boundary is shared while process ownership is not yet independent.
Agent profile list/get/create/update/delete IPC now uses
`HostLocalAgentProfileApiV1`, backed by Data's `AgentProfileStore`; the
snake_case SQL row and JSON-encoded tool/prompt columns remain compatible.
Desktop still composes this service in Main over its database handle, so this
removes profile SQL from the IPC handler without moving database ownership to
an independent Host process.
Agent DB bridge project-by-cwd resolution, project grouping, and writable-root
lookups now read `HostProjectApiV1` through the authenticated local Host client.
Path normalization comes from `@duya/data/path-utils`, and project entity homes
use the same resolved data root as the databases. The bridge no longer reads
projects through the memory-state compatibility facade; the embedded Host and
database handles still live in Desktop Main. The compatibility ProjectService
also requires its project database handle from the composition root; it no
longer falls back to `getCoreStores()`.
Code Review's latest/history/detail/by-turn reads and turn-review writes now
share `HostLocalTurnReviewApiV1`, backed by Data's `ChatTurnReviewStore`.
Desktop keeps the legacy review DTO conversion at the IPC edge, including
malformed-history handling; `git-handlers.ts` no longer queries
`chat_turn_reviews` directly. The Host is still embedded in Main.
The Control Plane's `ApprovalRepository` is asynchronous and uses these Host
clients as well. Desktop Main still owns its listener and database handles;
moving those owners remains part of Host-owned run execution.
Session runtime locks now have a `HostLockApiV1` contract in Agent Protocol and
a Data-backed Host implementation. Agent DB bridge lock operations, renderer
lock IPC, bot-send busy checks, and the wake dispatcher's busy/preemption
checks use the authenticated Host client. The wake queue and pending-wake
store remain Desktop-owned and still need extraction with scheduler ownership.
`@duya/host/http-server` provides an authenticated, loopback-only HTTP
adapter for session, goal, mode-state, permission-request, tool-approval, and
runtime-lock
APIs, timeline reads/appends, workflow-run persistence, index deletion, local
rollout export/import/reconciliation, and channel binding/offset persistence.
It also serves local-only card state writes for widgets, cursor-agent runs, and
pending secrets.
The Desktop CLI message list/show/count handlers also read through
`HostSessionApiV1`; cursor pages are reassembled before the legacy full-history
projection so numeric offset and message DTO behavior remain stable. Room
transcript reads and group-turn orchestration now use the async Host session
API for room-session creation, timeline appends, and source-filtered history
reads. The orchestration remains in Electron Main; only its room data access
has moved behind Host, so this does not yet make the Host process owner
independent from Desktop.
Scheduled cron runs now create/reuse their session through the same
`HostSessionApiV1` and register the automation workspace as an opaque Host
reference before dispatch. The scheduler, timer, and Agent Server dispatch
remain Electron-owned; this moves the cron session write contract, not scheduler
or execution ownership.
Conductor Canvas management now reads its local working-directory projection
and persisted canvas binding through Host, and updates `conductor_canvas_id`
through `HostSessionApiV1`; the canvas database and RPC executor remain in
Desktop Main.
Mailbox persistence now has a versioned `HostLocalMailboxApiV1` contract and
authenticated local routes. Desktop IPC, the Agent DB bridge, and Main's
spawn-completion, idle-wake, and agent-DM adapters use the Host client for
enqueue, edit, claim, apply, cancellation, and lookup operations while keeping
the existing IPC row projection, broadcasts, and wake dispatch. Both Desktop's
Main-composed listener and standalone `duya serve` bind the API to the Data
`Mailbox` state machine. The Control Plane's SQLite repository still uses that
Data store internally; Desktop still owns the listener and database handles,
so this is an API-boundary migration rather than process ownership transfer.
`startLocalHost()` now composes `DatabaseHost`, `CoreDataHost`, the legacy
importer, and that HTTP adapter without Electron. `duya serve` starts it and
publishes `runtime/host-api.json` under the data root. It takes an exclusive
Host lock, copies the previous default database set when needed, and keeps the
existing SQLite paths. `HostSessionHttpClient` lets `duya session create/list/show` use
the running Host (list/show retain the Desktop API fallback when no Host is
running). Desktop now also starts the same authenticated, loopback-only
`HostSessionHttpServer` over `getCoreStores()` and publishes the same
`runtime/host-api.json` descriptor. The CLI therefore uses the shared
`HostSessionApiV1` wire contract for session create/list/show with either
Desktop or `duya serve`; the older Desktop CLI API remains available for its
other commands and as a fallback. Its `/v1/status` `dbReady` field now comes
from the authenticated Host `/healthz` response instead of probing Main's
SQLite handle. The Host reports persistence ready only after its production
composition has opened both database handles and started listening. This
Desktop adapter still runs inside Main and does not transfer database
ownership out of Electron. A cross-process
smoke created a session through the CLI and read it after restarting Host.
Desktop's `db:session:create` now registers a locally selected working
directory through Host before creating the session; Desktop path changes do the
same and send only the returned Workspace reference. Pathless creation,
metadata/extension updates, soft deletes, and clearing a working directory also
use Host. Host resolves the path and transactionally updates the session row and
binding. Agent Worker creates under an unregistered path still use the local
compatibility path until that Worker flow carries an explicit grant signal. CLI
chat likewise registers its launch directory with the authenticated loopback
Host before creating its session. The local registration endpoint is not
exposed as a remote Web capability. Desktop configures a separate authenticated
`/v1/local/sessions` projection for its legacy IPC adapter; standalone
`duya serve` does not register that route. Host rehydrates local path/archive
fields inside this local-only projection, while `HostSessionApiV1` remains path-free.
Desktop IPC session get/list and Host-backed create/update, plus Agent Server
Host-backed session create/get/ensure-bot/update, use that projection instead
of reopening `sessions.get()` in Main. Child-session
creation carries spawn type/reason/turn lineage through the Host session API,
so the normal Host-backed path no longer writes the spawn edge separately from
Desktop Main; unregistered raw-path compatibility creates retain the old
best-effort write until workspace binding covers them.
The Agent Server's Worker database bridge now routes session create/get,
ensure-bot, update/delete, list, and child-session metadata operations through
the same Host HTTP API. Registered-Workspace child runs create their session
and lineage through Host as well; unregistered raw-path children retain the
compatibility write. Worker `message:replace` creates a missing session through
Host before appending its timeline. Explicit unregistered-path compatibility
writes and session consumers such as project grouping still access Data
directly, so the full session domain and database-owner cutover remain
incomplete. Desktop archive/unarchive IPC now invokes the same
Host session API; rollout-file movement and archive metadata updates no longer
run inside the IPC handler. The authenticated HTTP transport exposes
`POST /v1/sessions/:id/archive` and `POST /v1/sessions/:id/unarchive` for local
Host clients. Desktop still composes that Host service inside Main, so this is
a domain migration rather than the independent-process/database-owner cutover.
The Session API types its persisted `permissionMode` field as
`SessionPermissionProfile` (`default`, `auto`, or `full_access`), separately
from the Run API's `PermissionPolicyMode`; the HTTP validator accepts stored
profile values without translating or silently changing their behavior.
Gateway routine lifecycle markers append through Host before broadcasting to
the renderer, and Desktop cron-run summaries use Host's local prefix query.
Gateway mapping, channel directory, allow-list, message mirror, and legacy
`threads` projection use typed Host APIs backed by Data. Gateway Main no longer
executes SQL directly, but Desktop still supplies the listener's database
handle. Other legacy database domains, including the cron schedule store,
remain direct Main callers.
`DatabaseHost` now takes a per-file owner lease shared by
Desktop and standalone Host compositions; a second composition fails closed
instead of opening another handle. This is an interim single-owner guard:
Desktop does not yet attach to or supervise the existing Host, so it may need to
be closed before `duya serve` can claim the data. The standalone Host exposes a
Run persistence API over HTTP for create/get/list/append/settle and paged event
reads. Run events can also be followed over SSE with durable sequence IDs and
reconnect cursors (durable `seq` values can skip non-durable events). This API
does not schedule, start, cancel, attach, or resume execution; Worker Manager
composition and database ownership migration remain outstanding. The API does
not promise timeline replacement/CAS because the current store does not provide
that operation.

The pure Run manifest factory (`RunIntent`, `BuiltRun`, and `buildRunManifest`)
now lives in `@duya/host/manifest-factory`, and the Agent Server imports that
Host subpath directly. The former Desktop module remains a compatibility export.
This moves manifest construction into the Electron-independent package; Run
Store/Control Plane actions still cross the Agent Server's existing `db:request`
bridge, and Desktop still supervises that Agent Server.

The AI event-to-`ModelPort` adapter now lives in
`@duya/host/run-engine-model`; production run composition imports that Host
subpath directly. The old `packages/agent/src/process/run-engine-model.ts`
path remains a compatibility re-export. `@duya/agent-runtime` stays provider
independent. The production driver still gets its `AIClient`, tool pipeline,
and turn context from `DuyaAgent`, so this extraction does not yet remove the
legacy Agent runtime dependency.

`ControlPlaneService`, its bounded in-memory `HostMap`, the command/run receipt
contracts, repository port, and pure trusted-sender decision now live in
`@duya/host` public subpaths. Desktop Main imports these Host APIs directly;
the former Desktop modules remain compatibility exports. The service receives
its repository, run-action dispatcher, and logging callback through ports, so
the service itself has no Electron dependency. Desktop still binds the SQLite
repository and `db:request` dispatcher and owns worker process registration;
`run:create`/`append`/`complete` and run queries now use the Host
`run-control-plane` service over that injected `RunRepository`. The legacy
Desktop dispatcher is only an adapter for remaining direct callers. This is a
service and action-logic extraction, not yet a Host process or database-owner
cutover.

The append-only rollout JSONL, `message_index`, rebase projection, and repair
implementation now live in `@duya/data`; the durable message and rollout-event
contracts live in `@duya/agent-protocol/message-timeline` and
`@duya/agent-protocol/rollout-events`. Message-origin classification and its
direct-chat and group-room source filters now live in the Protocol timeline
contract; Desktop IPC and group-history production callers import that contract
directly, including session-fork persistence. The legacy Agent message module
re-exports those names for existing consumers. The renderer transcript
visibility projector now lives in `@duya/agent-protocol/transcript`; Desktop
Main still uses the legacy Agent timeline-to-persistence projector because it
folds compaction checkpoints into stored message rows. Desktop's old
`db/core` paths are compatibility adapters, and its `CoreStores` composer
supplies the logger and bot-session path ports. `WorkflowRunStore`, its
migrations, and its construction now live in `@duya/data`; the Desktop
`db/core/workflow-store.ts` path is a compatibility export.
`createCoreDataStores()` now constructs workflow runs with the other durable
stores. Archive path policy and legacy archived-row recovery also live in Data,
with the old Desktop module paths retained as compatibility exports. Desktop
workspace identity tables, migration, path normalization, and lazy session
binding now also live in Data; standalone Host includes that migration and
resolves session paths from workspace/root IDs and relative paths. Desktop keeps
compatibility module paths for existing imports. Desktop
Main composes one `DatabaseHost` for both database handles and retains the
compatibility accessors, `CoreStores` adapter, rollout-root migration, and
one-time legacy database import. The Electron-free `@duya/host` package now
composes its own `DatabaseHost` and `CoreDataHost` for `duya serve`; Desktop does
not supervise or connect to that process yet. The shared per-file owner lease
prevents both `DatabaseHost` compositions from opening the same files at once.
Memory-state connection/migrations also remain under
`apps/desktop/src/main`.

Desktop's CLI control API publishes its loopback port/token in
`<dataRoot>/runtime/cli-api.json`; `@duya/cli` checks this shared location first
and retains probes for the former platform-specific Electron `userData`
directories during migration. The CLI imports only the public Data path
resolver for discovery; the current API is still served by Desktop, so this is
not yet an independent Host service.

The standalone chat CLI's legacy database path resolves under the same
`~/.duya` root (including the existing test-root overrides). Interactive REPL
and TUI sessions now create session metadata, append transcript turns, record
compaction rebases, and update titles through `@duya/cli/host-session` and
`HostSessionApiV1`. They reuse Desktop's authenticated runtime descriptor when
present, otherwise start the Electron-free local Host for that CLI process.
These writes go through the Host API into the database owned by the active
Desktop Main or standalone Host; the CLI no longer calls the standalone no-op
`createSession`/`addMessage`/`replaceMessages` path for chat persistence. The
message-to-timeline projection, stable-ID deduplication, compaction rebase, and
session-title update adapter now live in `@duya/cli/transcript-persistence`;
the legacy chat entry supplies the compaction-checkpoint suffix as an option.
same session/timeline path now covers one-shot
`-t`, `--print`, and `--headless` runs; a headless script keeps its prompts in
one session. Appends happen after each completed prompt, so this does not
provide crash-time streaming recovery. The control CLI's `session list/show`
can read these sessions through the same service. The current create path
registers the effective local working directory as a Workspace before creating
the session, so these CLI sessions carry a Workspace binding and can appear in
workspace-filtered Desktop views.
The persisted Todo `Task` contract now lives in `@duya/agent-protocol`, and
authenticated Host task routes use the `@duya/data` TaskStore. CLI chat installs
a Host-backed `TaskStore` for interactive, one-shot, print, and headless runs.
Desktop exposes the same task API from Main over its existing CoreStores. Both
Renderer `db:task:*` handlers and the Agent Server's existing IPC wire forward
task operations through the authenticated Host HTTP client, then convert
results back to the legacy task-row shape. Those paths reach the same
Desktop-owned database while Desktop is running, and standalone CLI uses the
independent Host's Data stores. This aligns task persistence behind the Host
API but does not transfer database ownership out of Electron.
CLI chat still executes through legacy `DuyaAgent` in the CLI process, and the
Desktop Agent Server still uses the legacy Agent worker path. Their durable Run
records now share Host APIs, but they do not yet share a Host-owned executor;
Agent tools using other legacy persistence facades are also not all routed
through Host services. Desktop Main still supervises the Agent Server process;
that server constructs Host's Worker Manager through a Desktop adapter. The
database writer cutover and legacy Agent package retirement remain outstanding
before CLI and Desktop execution can converge.

The worker resource policy and child-process environment builder live in
`@duya/host/worker-limits`; process supervision lives in
`@duya/host/worker-manager`. Desktop Agent Server uses both Host modules, while
Desktop still injects session lifecycle, logging, and packaged paths. Standalone
Host and CLI do not yet compose the Worker Manager; the message router and
Agent Server process lifecycle remain Desktop-owned.

### Schema

The `duya-main.db` connection and numbered schema migrations are owned by
`@duya/data`'s `MainDatabase`; Desktop supplies the logger and connection-slug
port through its compatibility adapter. The process-wide accessor, path
resolution/validation, and safe-mode policy remain in Desktop Main; the path
override is stored as `storage.database_path` in `config.toml`.
Core tables:

- `sessions` - Session metadata
- `message_index` - Chat message index (FTS5 indexed)
- `memory_schema` - Memory RAG storage bookkeeping (`memory_entries` / `memory_evidence` were dropped by memory-state migration 0009)
- `settings` - User configuration
- `tasks` - Task state
- `permission_requests` - Permission requests
- `session_goals` - Session goals
- `mode_state_snapshots` - Mode state snapshots
- `attachments` - Message attachments
- `mailbox_items` - Mailbox items
- `rollouts` - Experiment tracking (Plan 326)

### Rollout Files

Chat history stored in rollout JSONL files under `workspace/rollouts/`:

```
workspace/
  rollouts/
    2026-09/
      session-id.jsonl
```

`message_index` table references these files.

### Rollout as First-Class Data (Plan 506)

The JSONL rollouts are the source of truth; `message_index` is a rebuildable projection. Core: `@duya/data` owns the durable MessageLog; `apps/desktop/src/main/db/core/session-fork.ts` remains a compatibility adapter for checkpoint seed derivation. Production session fork writes run through `@duya/host`'s `HostSessionApiV1.forkAt`. IPC (`apps/desktop/src/main/ipc/db-handlers.ts`) + preload (`session.forkAt/archive/unarchive/listArchived`, `rollout.export/import/reconcile`):

- **Export** (`db:rollout:export`): Host's local API writes one portable file per session — bot sessions concatenate `archive-<g>.jsonl` generations in order + `active.jsonl`; the DB and source files remain read-only.
- **Import** (`db:rollout:import`): `restore` builds a new session from an external .jsonl; `continue` appends onto an existing session. All-or-nothing validation (1-based line numbers); ids colliding on the `message_index` GLOBAL PK are remapped into `import:<sessionId>:<oldId>` with every cross-reference (parentId / replyToId / compaction refs / rebase newMessages) following.
- **Reconcile** (`db:rollout:reconcile`): Host rebuilds the whole-store index from rollout files, reporting missing/orphan files; orphans are never deleted.
- **Fork** (`db:session:forkAt`): Host seeds a new session from the repaired source timeline through a message id; fresh ids (`fork:<newSessionId>:<oldId>`), `parent_session_id` + `session_spawn_edges` edge of type `fork`.
- **Archive** (`db:session:archive/unarchive/listArchived`): Host checks locks across the spawn subtree, mirrors every rollout segment into `archived/<date>/`, and rolls files/metadata back on failure. Unarchive restores one session's segments and legacy single-file rows; descendants remain archived. Archived sessions leave the default `list()` result (`includeArchived` to reveal).
- **Non-bot rotation** (Plan 506 C1): long ordinary chats rotate on the same `archive-<g>.jsonl` layout as bots once they cross `NON_BOT_ROTATION_THRESHOLD_BYTES` (4 MB) — compaction triggers rotation for already-rotated sessions; the active file's generation directory is sticky so segments never split.

### Memory State DB (Plan 479)

Separate SQLite file (`memory-state.db`, next to `duya-main.db` in the same boot.json directory), managed by `apps/desktop/src/main/memory-state/`. Its legacy schema includes projects / rollout catalog (0001), leases + stage1 outputs (0002-0003), curation runs / publications (0008), and the bot memory tier index (0010). `projects` and `project_bots` are now canonical in `duya-core.db`; `CoreDataHost` imports their legacy rows read-only and idempotently during startup, with completion recorded in core `meta`.

The Stage 1 extractor now receives only the memory-state database and a
host-supplied `readMessageRows` port; Desktop no longer opens `duya-main.db`
for an unused extractor constructor handle. Production catalog synchronization
uses an async `MemoryCatalogSource` backed by authenticated Host APIs for
session pages, timeline index metadata, and local project-path resolution. The
Memory Worker no longer receives CoreDatabase or SessionStore handles;
`syncAllFromMainDb` remains as a legacy compatibility entry point. Desktop's
local project resolver still adapts the existing Main resolver over Main-owned
CoreStores, the Host listener still runs in Main, and the worker still opens
`memory-state.db` locally. This is a caller-boundary cutover, not a full memory
domain or database-owner cutover to Host.

`memory_tier_index` (migration 0010, Plan 479 Phase 1) is a rebuildable query index over the file-manifest memory tree — the files remain the source of truth. Tiers: `agent` (own, `~/.duya/agents/<agentId>/memory/`), `user` (shared, `~/.duya/memory/`), `project` (`~/.duya/memory/projects/`). `entry_id` = sha256 of tier+writer+project+dedupe_key; shard-unique index enforces one entry per (tier, writer, project, key). Conflict rules live in `apps/desktop/src/main/memory-state/tierConflicts.ts`: newest-wins within a shard, earliest-via across shards, tier precedence agent > project > user. Store API in `apps/desktop/src/main/memory-state/tierIndex.ts` (`upsertTierEntry`, `listTierEntries`, `mergedTierRecall`, `rebuildTierIndexFromFiles` with dry-run).

## @duya/ai - Multi-Protocol LLM Adapter

三层架构 (Plan 451):

### 1. API Layer (`packages/ai/src/api/`)

- `anthropic-messages.ts` - Anthropic Messages API
- `openai-completions.ts` - OpenAI Completions API
- `openai-responses.ts` - OpenAI Responses API
- `ollama-chat.ts` - Ollama API
- `bedrock-converse.ts` - AWS Bedrock Converse API
- `google-generative-ai.ts` - Google Generative AI API
- `local-runtime.ts` - Local runtime API
- `degrade.ts` - Degradation handling
- `emit-sse.ts` - SSE emission
- `transform-messages.ts` - Message transformation

### 2. Provider Layer (`packages/ai/src/providers/`)

- Factory: `createProvider()`
- Catalog: `createProviderCatalog()`
- Auth: OAuth, API Key, Device Code

### 3. Models Layer (`packages/ai/src/models/`)

- Model capability detection
- Thinking level mapping
- Cost calculation

### Supported Protocols

| Protocol | Provider |
|----------|----------|
| anthropic | Anthropic |
| openai-chat | OpenAI, Azure OpenAI, DeepSeek, Qwen, MiniMax, Kimi, GLM |
| openai-responses | OpenAI Responses API |
| ollama | Ollama |
| openrouter | OpenRouter |
| bedrock | AWS Bedrock (P2) |
| gemini | Google Gemini (P2) |
| vertex | Google Vertex (P2) |

### System One Decision Client (Plan 551)

决策形态 ≠ chat 形态——Jev（TypeSafe "System One" 模型）接入独立于 `providers/` chat 抽象：

- `packages/ai/src/system-one/` — `DecisionClient` 接口 + `SystemOneClient`（state + 多问题单请求 → choice/score/noul typed 决策；timeout 预算 + 瞬态重试；基数 255 校验）。`DecisionClient` 是可替换后端抽象（未来：LLM structured-output / 本地 SemIf）。
- `packages/agent/src/decisions/` — `DecisionService`（降级链 Jev → LLM fallback → 抛上层规则）、`policy.ts` 阈值策略（灰区 → `uncertain`，绝不静默猜）、`calibration.ts` (p, outcome) 校准日志、`config.ts` 读 `config.toml [system_one]`。419 权限总线预筛通道默认关闭（`prescreen.permissions`，只产建议不改语义）。
- `packages/computer-use/src/decide/` — "LLM plans, Jev decides" 内循环：describe（代码可算摘要全进 state）→ 每轮一次 fan-out（target/value/done/error/blocked/irreversible）→ 代码门控 → act；status 契约 `done | likely_done | needs_confirmation | error | stuck | ambiguous | blocked | max_actions`。agent 侧 `computer_use_decide` 工具经既有 `computer-use:execute` IPC 驱动，审批复用主进程审批卡。
- **零行为破坏**：无 key / 未启用时所有路径与现状一致——`computer_use_decide` 不注入，419 预筛不触发。

### Workflow Engine (Plans 415 + 552)

独立后台 run 管理系统（非 mode,不进 popover、不套 413 检查点）。代码位于
`packages/agent/src/modes/workflow/`：

- **定义层**：`schema.ts`（zod:六类节点 tool/gui/decision/human/agent/noop + map/when 原语 + params/triggers）、`validate.ts`（引用存在/无环/跨阶段前向引用拦截/decision 阈值/human timeout 必填）、`workflow-files.ts`（`~/.duya/workflows/` save-as 注册表,load 全量重校验）。
- **表达式**：`expr.ts` 受限四类表达式（引用/比较/逻辑/聚合）+ decision answers 进 when 作用域 + `${...}` 插值;无 eval、无时钟/随机（§6.5 确定性铁律）。
- **状态机**：`engine/run-lifecycle-tracker.ts` 小内核（纯转移矩阵 + paused/terminal 判定 + history cap 64 + from_snapshot 折叠,与 GoalTracker 共享词汇不共享结构体）;`tracker.ts` WorkflowRunTracker 挂 phase/epoch/预算/journal 字段。
- **执行器**：`engine.ts`（阶段 → 拓扑 → journal;SuspensionSignal → 签名 resumeToken waiting outcome）、`node-runner.ts`（reqHash 缓存 + on_error 动态策略 + output_schema 校验重试）、`map-runner.ts`（per-item 缓存 + soft-fail null）、`gui-runner.ts`（确定性步骤 → suspected_noop 阶梯 → decide 通道八态契约 → 498 审批门）、`human-runner.ts`（§6.3 marker 语义）、`decision-adapter.ts`（551 DecisionService,阈值覆盖 + 灰区 → on_low_confidence）。
- **可靠性**：`journal.ts`（`nodeId+reqHash` 缓存命中即跳过 = "可复跑/可修正";BudgetExceeded/Cancelled 不落 journal;trailing failure 剪除;live listener 三用:持久化=SSE=审计）、`resume-token.ts`（HMAC + timingSafeEqual）、`host.ts`（BudgetLedger reserve→commit/release 与 Semaphore 分离）、`manager.ts`（dedup 幂等 launch、崩溃对账 reconcileStaleRuns → interrupted 绝不盲目重跑、wait-tracker tick 应用 on_timeout、`onRunFinished` 完成自动唤醒钩子）。
- **触发层**：`trigger.ts` 统一入口 `launchFromTrigger`（cron 触发分钟 / bot 消息 id / http 幂等键 / manual 无——dedup 命中返回既有 run）。
- **存储**：core-db `workflow_runs`（元数据行,dedup_key UNIQUE,wait_till 索引,迁移 26/27）+ `workflow_run_snapshots`（1:1 blob:冻结 YAML + 节点栈 + journal;截图外置于 artifact store,日志只存引用）。渲染端经 `workflow:*` IPC 只读（`WorkflowPanel` 控制台）。**每 run 文本日志**：`run-log.ts` 在 `launchSavedWorkflow` 落 `~/.duya/workflow-logs/<workflow>-<runId>.log`（launch args + 逐条 journal 投影 + 终态错误;best-effort,fs 失败降级 no-op;`DUYA_WORKFLOW_LOGS_ROOT` 可覆盖,测试必须指到 tmp）。
- **控制台（ZCode 交互对齐）**：`WorkflowPanel` 双 tab——定义库（双 scope:项目 `.duya/workflows/` shadows 全局 `~/.duya/workflows/`;卡片含参数/触发器/阶段节点数/可复制权威路径;定义只读,修改走对话）+ 运行（进行中/已结束双区计数;活跃可停止、结束可删除）。run 详情渐进披露:血缘(`retry_of`)、四格统计（时间/tokens/子代理/阶段,纯代码从 journal 推导）、阶段 trail N/M、逐步证据行（`nodeKind`/`action`/`exitCode`/`durationMs`/`outputSize`/`childSessionId` + 可展开缓存结果）、产物区、逐条 verified/unconfirmed 标注。journal 证据字段为**展示专用**,不进 reqHash payload（缓存经济学不受影响）。**节点链接（2026-09-27 升级）**:run 卡片 agent chip（带 `childSessionId`）与证据行的子会话链接直接 `setActiveThread` 进入子会话 ChatView（只读侧栏 `SessionMessagesPanel` 仍服务 subagent 工具行/任务抽屉入口）;decision/human/browser/agent 节点 chip/行走 `duya:open-workflow-node-panel` → run 详情顶部的按类型专属查看器（`run-display/node-detail.tsx`，命令/判断依据/审批结论/落在 URL 等;截图 ref 经 `workflow.artifactPath` → `duya-file://` 渲染画廊,点开复用 `ImagePreview` lightbox）。
- **规划器**：`planner.ts`（LLM 生成 YAML + 一次带错重试;规则 regex + Jev risk noul 预筛;高风险 → awaiting_confirm 必停）、`verify.ts`（确定性标注 → decision over 机器摘要 → verification agent 三档 fresh-eyes;`verified/unconfirmed` 标注落 journal）。
- **执行接线（ZCode 同构,worker 是唯一 runner）**：renderer `WorkflowPanel` 定义库 run 按钮 → `WorkflowLaunchDialog` 实参窗（项目目录 + frontmatter args 表单,required/number/JSON 校验）→ `workflow.run` IPC → router `POST /:session/workflow/:name/trigger`（锚点 `sessionId ?? mostRecentWorkerSessionId()`,sendCommand false → 409 不自动 spawn）→ worker 命令 `{type:'workflow:run'}` → `packages/agent/src/process/workflow-runner.ts` `launchSavedWorkflow`：SavedWorkflowStore.resolve → args 默认值+required 校验（建行前 fail）→ `workflowRunDb.create`（id=runId,SSE 卡片==DB 行）+ snapshot 播种 → journal listener 进度帧（`chat:workflow_run` start/progress/done/error 走 worker→router→SSE）→ `runDwfScript` → complete。DwfHostPorts 生产绑定：runTool=fresh builtin registry、runAgent=SubagentTool executor（子会话+进度,token 省略）、requestApproval=worker `chat:permission`（5 分钟 deny 上限）、runGui=loud-failure stub。v1 边界：resume 未接、runTool 无 MCP。`workflow:runBackground` 主进程模拟已删除。

### Computer-Use Native Backends (Plans 454/519/552/556/562/572)

五腿框架（capture / plan / record / execute / verify）在 `packages/computer-use/` 平台无关地组装，
两个平台后端按 `backend/factory.ts` 路由（`DUYA_CUA_DRIVER` 环境变量可强制 MCP `cua-driver` 兜底）：

- **Windows（UIA 栈）**：`ElectronDesktopBackend`（desktopCapturer + nut.js + sharp，文件名 `win32.ts`
  实为跨平台）+ `resources/recorder/uia-probe.ps1` 常驻 PowerShell 探测（probe/readUrl/enumerate/fg/
  apps/windows/selectText/invoke，JSON 行协议）+ `win32-injection.ts` 后台点击梯 + recorder（uiohook
  hook-worker / converter / element-matcher L1–L3）。三消费者共用 `createComputerUseDaemon` 管线
  （spawn/心跳/重启/recycle）。
- **CUA 14 工具面（plan 575，Windows）**：ZCode/Codex CUA 对齐的系统级面。契约层
  `packages/computer-use/src/cua/`（元素 token 台账 / 树归一化三步 prune-merge-flatten /
  `formatObservation` 优先级裁剪 / `diffSnapshots` full-delta-no_change / `CuaError` 错误码分类
  + action_sent-retry 语义）；服务层 `apps/desktop/src/main/services/cua/cua-service.ts`（14 工具逻辑：
  窗口解析 fail-closed（plan 578：minimized 窗口可解析——visible 优先、minimized 兜底、cloaked 拒绝；
  `includeScreenshot=true` 对最小化目标先 `ShowWindow(SW_SHOWNOACTIVATE)` 无焦点恢复
  （`window-restore.ts`）再重查 rect 后 enumerate+capture，纯树观察不恢复）、app_ref 作用域元素寻址（0 基模型索引 → 1 基 probe 槽）、隐式帧绑定坐标
  ——坐标目标只对 `get_app_state(includeScreenshot)` 交付过的最后一帧解析）；通道
  `computer-use:cua`（`apps/desktop/src/main/ipc/cua-handlers.ts` 拥有 CuaService 单例，agent 侧
  `computer_cua` 单工具 14-action，`packages/agent/src/tool/OSTool/ComputerCuaTool.ts`，
  builtin hidden 注册 + `.system/computer-use` 内置 skill）。非 win32 平台返回
  STRUCTURED_STATE_UNAVAILABLE。
- **macOS（AX 栈，plan 572）**：Swift CLI helper `resources/ax-helper/`（`scripts/build-ax-helper.sh`
  编 universal binary）经同一条 daemon 管线常驻——`enumerate/probe`（快照句柄制元素 + 真实坐标，
  `AXUIElementSetMessagingTimeout(0.5s)` 防阻塞）→ element-detector `axElements`(`axSource:'ax-tree'`)；
  注入梯 **AX action → CGEventPostToPid（键盘/滚动，不抢焦点）→ 前台 nut.js**（Chromium 过滤 pid
  鼠标事件，无 pid 点击梯）；AXManualAccessibility 配方唤醒 Chromium/Electron 树；AppleScript 词典
  读浏览器 URL；`AXSecureField` 脱敏；TCC 四权限面（`computer-use:permissions:*` IPC + Automation 页
  `MacPermissionsCard`）+ recorder 权限门/Secure Input 显性化；`capture({windowId})` 经
  ScreenCaptureKit 单窗捕获（SDK 14+ 门控，低版本回 unsupported 降级全屏）。客户端
  `apps/desktop/src/main/services/recorder/ax-helper.ts` 对齐 uia-probe 客户端语义（竞速超时/回收/降级重试/pid 缓存）。
- **坐标铁律**：AX/CGEvent/CGWindow 全 points（左上原点），截图像素 ↔ points 换算集中在
  `capturePxPerPoint`（检测侧）与 `computer-use-coords.ts`（点击侧 darwin 分支）——Retina 半坐标是
  第一大正确性风险。技术底稿 `docs/references/macos-accessibility-research.md`（本地不入库）。
- **机器门执行器**：`node scripts/mac-gate.mjs` —— TCC 检查 + Finder/Safari/Chrome 覆盖矩阵 +
  注入两梯读回验证一键跑（plan 572 §7）；`scripts/reset-mac-tcc.sh` 重置授权。剩余真机 Gate
  依赖 macOS 13+（Electron 44 硬性要求）与 TCC 授权。

## @duya/agent - Agent Core

### Entry Points

- `packages/agent/src/agent/DuyaAgent.ts` - Main agent class
- `packages/agent/src/session/MessageSession.ts` - Session management
- `packages/agent/src/session/TaskStore.ts` - Task state

### Chat CLI TUI

- Worker content frames retain the engine's message ID and content index through
  the Host bridge. A run-only `chat:turn_start` marker preserves model-turn
  boundaries alongside legacy status text; the TUI additionally scopes old
  per-run content IDs by that turn. Thinking/text buffer transitions flush in
  arrival order and authoritative blocks replace only their matching content.
- `WorkerPermissionRequests` persists worker approvals before publishing them.
  The existing permission-request HTTP endpoint returns decisions and answers
  to the waiting worker, with deadline, cancellation and duplicate-reply guards.
  TUI permission frames use the queued picker; tools awaiting approval are
  visible, and the embedded Host diagnostics path is printed at startup.
- Esc aborts the stream immediately but holds local turn admission until Host
  cancellation and a terminal record are confirmed. A fresh prompt submitted
  during cancellation waits for that barrier; older queued drafts still need
  explicit resumption. Failed cancellation blocks subsequent run admission.
  Host cancellation also awaits the orchestrator's common release path, even
  when a forced stop produced no worker terminal frame. A killed child awaiting
  its exit event is replaced before the next run; stale exit cleanup cannot
  remove the replacement worker's activity state.
  `build:cli-dev` rebuilds both the Host worker and the CLI so `dev:tui` cannot
  silently execute a stale worker bundle.

- The Host-backed entry uses `tui/host-event-stream.ts` to scope envelopes by
  session/run identity and sequence before projecting them into UI frames.
  The active Host run also publishes canonical events through a bounded
  `LiveRunEventHub`, including transient status events absent from the durable
  ledger; its HTTP SSE route resumes from the ledger after terminal settlement.
  `tui/turn-queue.ts` serializes locally pending follow-ups; cancellation and
  failure pause older drafts until an explicit resume. Pending drafts stay in
  chrome until admitted, and shutdown waits for startup/cancellation before the
  caller closes its Host. The CLI does not become a second run executor.
- `tui/terminal/session.ts` owns injected geometry, the output writer and resize
  forwarding/cleanup. Inline modal views borrow the alternate screen without
  destroying the shared keyboard Program, then invalidate the live viewport on
  return. `composer-layout.ts` supplies a cursor-following multiline window and
  bounded horizontal-rule layout. Fullscreen remains the default; inline is
  available through `DUYA_TUI_INLINE=1`.
- TUIApp memoizes assembled transcript lines across input-only and animation
  frames using its private document revision and presentation options. Public
  `TranscriptRenderer` content-hash semantics remain unchanged. Stable-prefix
  native scrollback, a general layout index and a possible pi backend remain
  separate follow-ups; this slice does not establish them.
- `packages/cli/src/tui/TUIApp.ts` owns the terminal screen, input/transcript
  focus, key routing, and scroll window. `transcript-view.ts` is a pure
  block-to-markup renderer in the same package; the `@duya/cli/tui` entrypoint
  exposes these UI primitives without importing the Agent runtime.
- `packages/cli/src/chat.ts` is the Host HTTP `duya chat` entry. On interactive
  terminals it renders Host run events through `TUIApp`; `/resume` and
  `/sessions` offer workspace session candidates in the slash-completion menu
  and restore the selected session's persisted transcript. `/new`, `/clear`,
  and `/exit` are handled in the same entry. Non-interactive terminals retain
  the readline fallback.
- `packages/agent/src/cli/tui-session.ts` is the temporary host adapter: it
  connects the legacy chat CLI's run events, persistence, and Agent-specific
  completion candidates to the TUI. The planned CLI/Run API migration will
  replace this adapter; it is separate from the Host HTTP `duya chat` entry.
- Focus starts in the input. Tab switches to history when the input is empty
  (and inserts indentation when it has text); F6 switches focus at any time.
  Up/Down recalls prompt history in the input and selects transcript blocks in
  history. Left/Right folds or opens the selected tool result or thinking block.
- Ctrl+T expands or folds all details and clears per-block overrides. Tool
  results remain capped at five rendered lines. Completion owns Tab/Up/Down
  first while its popup is open. Assistant output renders headings, lists,
  quotes, inline emphasis, links, and fenced code as safe Blessed markup.

#### Drawing Seam (`packages/cli/src/tui/screen/`)

`ScreenSurface` is the interface between the TUI and whatever paints it.
`TUIApp` used to build a blessed `program`, a `screen` and five boxes itself,
which made blessed's widget API part of the application's shape; the seam
reduces every drawing operation to a patch on one of five fixed regions —
`transcript`, `input`, `status`, `overlay`, `completion` — carrying content,
height, distance from the bottom edge, border colour, border style and
visibility.

Three things the seam had to take ownership of rather than let the caller
compute, because only the renderer placed them:

- `measure(region)` reports laid-out geometry (`innerWidth`/`innerHeight`
  already account for whether a border exists, and the input box drops its
  border on short terminals).
- `measure(region).laidOut` distinguishes "created" from "placed", which the
  cursor routine needs and cannot infer.
- `content(region)` returns the lines the caller last handed over. The rendered
  bytes cannot answer this: a diff-based renderer rewrites one cell per
  keystroke, so text typed character by character never appears contiguously in
  the terminal output.

`BlessedScreenSurface` remains the default implementation.
`OwnScreenSurface` is the second implementation, selected with
`DUYA_TUI_RENDERER=own`. It uses the same five-region geometry and append order
to compose a cell grid, then writes only the rows whose cells changed. The
alternate-buffer lifecycle is owned by either surface; `update()` creates a
missing surface but never re-enters a suspended one, while `ensure()` and
`enter()` are the explicit re-entry paths.

**Input migration status:** Blessed remains the default. With
`DUYA_TUI_RENDERER=own`, `OwnKeyInput` puts the real input stream in raw mode and
`OwnKeyParser` decodes UTF-8 across chunks, CSI/SS3 navigation, Ctrl/Alt
modifiers, bracketed paste, and SGR wheel events. Parsed keys are adapted into
the existing `program` event channel so `TUIApp` keeps one key-routing path;
bracketed paste is delivered as one literal edit, preserving embedded newlines.
The own path still uses Blessed `Program` for event dispatch, mouse-mode output,
and cursor commands, so Phase 4 remains responsible for removing that runtime
dependency.

**Not yet unified:** the inline path. `InlineSurface` writes whole frames
straight to the stream and owns no regions, so it is not a `ScreenSurface`. The
`inline === null` branch still exists in the paint methods; folding it away is a
rewrite of those methods, not of the seam.

#### Terminal capability detection

`detectTerminalEnvironment(env, platform)` takes the platform as an explicit
input because one rule cannot be reached from an environment bag: `unicodeBox`
used to end at a `LC_ALL`/`LC_CTYPE`/`LANG` check, and those are POSIX
variables that a stock Windows PowerShell sets none of. Absence was read as
"cannot do UTF-8", and blessed honours `fullUnicode: false` by replacing every
non-ASCII cell with `?` — so on Windows every CJK character in the transcript
and the composer was lost while input still arrived correctly. `win32` now
defaults to UTF-8 capable, `TERM=dumb`/`TERM=linux` still override it, and
`DUYA_TUI_ASCII=1` is the explicit way back.

Every test row names a platform, because a detection test whose expected value
depends on the host is this bug waiting for a different CI image.

### Slash Command Catalog (`packages/command-catalog/`)

`@duya/command-catalog` is the single definition of every slash command: name,
aliases, short titles in both locales, descriptions, argument shape
(`argsHint`/`subcommands`), category, which surfaces advertise it (`surfaces`),
and whether the Desktop's gateway adapters serve it (`gateway`). Both front ends
project it:

- `apps/desktop/src/renderer/lib/commands/registry.ts` maps each spec onto the
  renderer's `CommandDef` and answers `resolveCommand` /
  `getCommandsForPlatform` / `getCommandsByCategory`.
- `packages/cli/src/tui/slash/registry.ts` intersects the catalog's CLI view with
  the handlers the TUI can actually run, and feeds both the `/` popup and
  `/help`.

Behaviour is deliberately NOT shared: the Desktop's executors act on a
renderer-side `CommandAppBridge`, the CLI's act over the Host HTTP API. That
split matches codex, where `slash_command.rs` holds the definition and
`slash_dispatch.rs` the behaviour.

Three rules the package enforces (see `packages/command-catalog/src/index.ts`
and its tests):

1. **Lookup is exact and unfiltered; only the popup filters.** `findSpec()`
   ignores `surfaces`, so a command a surface does not advertise still resolves
   when typed. "Not advertised" must never degrade into "unknown command".
2. **Availability is data.** `surfaces`, `availableWhileBusy` and
   `requiresSession` live on the definition; a popup asks the catalog instead of
   carrying its own list.
3. **Order is presentation order.** The array order in `COMMAND_SPECS` is the
   popup order. Do not alphabetize it.

`@duya/command-catalog` imports no other `@duya/*` package, so it sits in
level 1 of `scripts/build-packages.mjs`. Omitting it there fails the way the
`@duya/input-completion` note in that file describes — green locally, TS2307 on
a clean checkout.

### Tool System

- `packages/agent/src/tools/` - Built-in tools
- `packages/agent/src/mcp/` - MCP server integration
- Tool protocol adapter layer (Plan 418)

#### Tool Catalog and Exposure

`ToolRegistry` remains the source of definitions, executors, and source
metadata. Each `ToolSnapshot` (`packages/agent/src/tool/snapshot.ts`) projects
eligible entries into a catalog with stable `tool_id`, normalized schema,
`schema_revision`, source, discovery hints, and one of three exposure values:

| Exposure | Provider tool list | Discovery | Invocation |
| -------- | ------------------ | --------- | ---------- |
| `eager` | Full schema | Searchable for explanation; details say `direct` | Direct call by the provider-visible name |
| `deferred` | Not exposed directly | `tool_catalog({query})`, then one schema via `tool_catalog({tool_id})` | `tool_invoke({tool_id, arguments})` fallback |
| `hidden` | Not exposed | Omitted from catalog search and detail | Unavailable |

`tool_catalog` returns short, deterministically ranked matches without schemas.
The detail operation returns one schema and a revision receipt. The agent records
that receipt only after the tool result is committed to the conversation, so a
same-provider-response `tool_catalog` + `tool_invoke` batch cannot use a schema
the model has not read yet. Fallback dispatch resolves the stable ID against the
request snapshot and live registry, checks current scope and exposure, confirms
the prior-round schema revision, validates arguments, then applies the ordinary
permission / approval chain before executing the real tool.

Key wiring:

- Visibility policy: `agent-profile/ToolFilter.ts` keeps profile, exact
  allowlist, and mode restrictions in the same eligibility path. Infrastructure
  routers remain available when a target is eligible; they do not grant access
  to out-of-scope targets.
- Legacy MCP exposure: `[tools] exposure = "full" | "hint" | "search"` maps
  `full` and `hint` to `eager` to preserve direct availability, and `search` to
  `deferred`. Legacy `catalog` maps to `search`. The default remains `hint`
  (therefore eager) until representative provider measurements justify a
  default change (`config/tool-exposure.ts`).
- MCP and plugin identities use persistent connection IDs where available;
  schema revisions change independently of stable IDs. Full catalog schemas are
  retained separately from provider-facing schema-budget reductions.
- `tool_search`, `tool_schema`, and empty-schema hint stubs are retired. Native
  OpenAI / Claude search adapters are not currently wired; providers use the
  catalog + invoke fallback until capability checks and request contracts are
  implemented. Existing deferred-schema utilities alone do not establish native
  search support.

#### Tool Migration Status (2026-10-13)

`@duya/capabilities` now owns the PowerShell specialization and its
PowerShell-specific security/read-only policy. The old Agent `PowerShellTool`
is a compatibility adapter that supplies the Agent-managed process starter,
output directory, and Git reminder; `builtin.ts` still registers that adapter.
`ToolRegistry`, `ToolSnapshot`, eager/deferred/hidden exposure, profile/mode
filtering, and the permission/approval chain therefore remain Agent-owned.
Moving a tool implementation into Capabilities does not move its production
registration or execution owner.

The 2026-10-13 extraction batch now places the filesystem tools, Bash and
PowerShell, Todo, MemoryWrite, WriteStage1Policy, AskUserQuestion, Brief,
Module, ImageGenerate, Vision, ReactToMessage, and SendArtifact implementations
under `@duya/capabilities`. This is a source extraction seam, not the final
architecture boundary: the package still contains a broad application-shaped
tool contract and permission policy, while several tools still carry domain or
interaction state. The old Agent paths are compatibility adapters/re-exports;
Desktop's worker still reaches them through the Agent registry. CLI has
separate Host-backed and legacy entry paths, so each consumer must be traced
before claiming cutover. Exposure, approval ownership, cancellation, and
durable result recording have not moved with these implementation files.

The next cross-layer slice is the single authorization result between
`ApprovalPort` and `ToolPort`: Runtime must authorize the resolved tool and
final arguments once, bind that decision to the invocation/resource scope, and
pass it to execution so the legacy executor cannot consume an approval a
second time. Argument or environment changes must request authorization again.
AskUserQuestion needs a separate interaction port for prompt, wait, answer,
timeout, and cancellation; an answer must not be represented as permission.
Move product permission rules to Host/Core and leave capability-local input,
path, and patch safety invariants in place.

Computer Use action names, error codes, and request/result envelopes now live
in `@duya/agent-protocol`, shared by the Agent tool and Desktop Main IPC. The
executor, tool exposure, approval flow, and OS-context bridge still use their
existing Agent/Desktop production paths. Runtime/Host registration and actual
tool execution have not moved in either slice.

#### MCP Capability Core (plan 580)

MCP capability flows through four layers, all fed by one protocol-pure Core:

1. **Core** (`packages/plugin-core/src/mcp/core/`) — no I/O, no agent deps:
   transactional paginated discovery (`listAllTools` — commit only on normal
   cursor exhaustion; mid-page failure throws and discards), descriptor
   canonicalization, stable slug/alias allocation (D7), `DeadlineClock` (D5 —
   one deadline per pass, SDK receives `{ timeout, signal }`, a shared
   transport is never closed for one aborted request), error taxonomy (D9 —
   `classifyMcpError` + `breakerDisposition`), and ledger types. Both chains
   import this code; behavior cannot drift.
2. **Registry** (`packages/agent/src/tool/registry.ts`) — definitions,
   executors, owner-scoped replace-sets (`replaceByOwner`). Every successful
   mutation bumps a monotonic `catalogRevision` (D10).
3. **Catalog** (`ToolCatalogTool`) — three mutually exclusive modes: `search`
   (ranked matches, no schemas), `list(namespace)` (keyset paging with an
   opaque cursor bound to `(catalogRevision, namespace)`; a revision change
   mid-page-walk → `CATALOG_CURSOR_STALE`), and `detail(tool_id)` (canonical
   schema verbatim, deep-equal).
4. **Exposure** — `eager` / `deferred` / `hidden` as above; the connector
   Apps system section renders unconditionally so the model can always
   enumerate via `tool_catalog` list mode.

Two chains share Core and differ only in transport placement:

- **Chain A** (worker, `packages/agent/src/mcp/index.ts`): one `MCPClient` per
  stdio / streamable-http server inside the agent worker; tools land in the
  registry through `MCPManager` → `setOnToolsChanged` replace-set.
- **Chain B** (main, `apps/desktop/src/main/services/app-connections/connectors/remote-mcp.ts`):
  OAuth-capable remote connectors in the main process; the worker's
  `AppConnectionTool` calls over IPC with a `deadlineAt` stamp (+30s IPC
  buffer), and results round-trip through the same D8 last-mile
  (`composeResultFromBlocks`, lossless `ToolResult.blocks`).

Lifecycle truth (D2/D6): `transport.onclose`/`onerror` are the ONLY death
signals → status `degraded` → `callTool` fails fast with `MCP_TRANSPORT`;
`tools/list_changed` → 500ms debounce → transactional rediscovery → replace-set
commit; a failed discovery NEVER clears last-known inventory. Each chain keeps
an `InventoryLedger` (`discoveryStatus: complete|refreshing|failed|stale` +
five-layer metrics) surfaced through `mcp:status:snapshot` and the chain-B
connection status DTO (optional `ledger` field). Admission gate: conformance
L1–L9 (`packages/agent/tests/integration/mcp-conformance.test.ts`, AGENTS.md
Gates).

### Mode System (Plan 224)

Modes are declarative `ModeModifier` objects:

- `plan-task` - Plan + task execution
- `research` - Deep research (Plan 423)
- `conductor` - Orchestration
- `goal` - Goal tracking (Plan 411, v2 in Plan 553)
- `computer-use` - OS desktop takeover (Plan 454; structural-first in Plan 564)

Registration: `packages/agent/src/modes/index.ts`

#### Computer Use Mode — Structural Control (Plans 454/519/556/562/564)

`computer_use` 单工具 11-action（`packages/agent/src/tool/OSTool/`），双通道：

- **STRUCTURAL（主通道，plan 564，Windows）**：`tree`（常驻 uia-probe.ps1
  `enumerate`：TreeWalker + 交互 ControlType 白名单 + IsOffscreen 过滤 +
  Edit/Document/ComboBox 的 ValuePattern value 读取 → 1-based 元素表
  `[n]Role "Name" value @rect`，`som/structural-format.ts` 渲染）+
  `invoke`（probe 内元素缓存按 index 解析 + name/controlType 陈旧守卫 →
  ExecuteMethod：auto 按 ControlType 分派 Invoke/Toggle/ExpandCollapse/
  SelectionItem/Value/SetFocus，`no-pattern` 引导回落视觉）。`set_value(element=)`
  走 ValuePattern（原子、绕 IME）。probe 复用 556/562 管线（零新 spawn）；
  `stale-tree` 由客户端 fresh 重枚举后自动重试一次。审计/访问策略/审批门
  与视觉动作同轨（`invoke` 入审批集，focus-only 豁免）。
- **VISION（辅助通道）**：`capture`/`zoom`（SOM overlay 经 element-detector，
  优先消费 enumerate 缓存的 `axElements` 真实坐标，10s TTL）+ 坐标
  `click`/`drag`/`type`/`key`/`scroll`。无结构化通道的平台/窗口返回
  `STRUCTURAL_UNAVAILABLE`，模型按 mode prompt 回落视觉循环。

#### Goal Mode v2 (Plan 553)

`packages/agent/src/modes/goal/` — grok-lineage self-driving objective tracker with independent verification, hardened after the minimax Thread Goal comparison:

- **10-state machine** (`GoalTracker`, process singleton): `idle → active ⇄ verifying → complete | blocked`, plus `user_paused` / `backoff_paused` / `no_progress_paused` / `infra_paused` / `budget_limited`. Closed `GOAL_PAUSE_REASONS` catalog (`user_requested`, `blocked_worker`, `no_progress`, `no_progress_gaps`, `verifier_timeout`, `verifier_unavailable`, `backoff`, `infra`, `restart`) carries the WHY orthogonally to the state; surfaced in snapshots, `goal_updated` history rows, and the UI.
- **Session ownership**: the tracker records `boundSession` at `start`; every accessor/mutator takes an optional sessionId and a mismatched session reads `idle` / snapshots idle data, so a bystander session can neither read nor clobber another session's goal.
- **Verification**: `update_goal(completed:true)` is a blocking ack that runs an N-skeptic adversarial panel (1–5 parallel sub-agents, JSON verdicts, conservative aggregation, strategist + closing summarizer) under `verifyTimeoutSeconds` — a timeout settles `blocked(verifier_timeout)` before any tracker side effects. `[goal] verification = "panel" | "none" | "auto"` skips the panel (`none` everywhere; `auto` on ollama local runtimes) and settles the worker proposal verbatim (minimax BYOK cost parity). `get_goal` lets the model read the durable state.
- **Self-driving loop**: builtin PreFinalize hooks — `goal-reply-fingerprint` (priority 11: normalized final-reply streak, ≥2 occurrences nudge veto, ≥3 auto `no_progress_paused`) and `goal-continuation` (priority 12: veto the natural stop while the goal is active, bounded by `max_auto_continues`; engine invariants still outrank it). Bail endings are intercepted earlier by the priority-10 premature-stop detector.
- **Cross-session**: the goal persists in `mode_state_snapshots`; a restart folds `active/verifying → user_paused(restart)` (grok safety fold) and `[goal] auto_resume` (default on) re-resumes it in `ModeCoordinator.restore()`. DuyaAgent self-adds `goal` to the turn's activeTrackerIds from the persisted snapshot, so any next message re-drives the goal without re-selecting the mode. Deterministic `/goal status|pause|resume|clear` control is intercepted at streamChat entry (`goal-commands.ts`, also registered as a CLI/gateway slash command) — no LLM turn spent; `/goal <objective>` still flows to the model so work starts immediately.
- **UI**: `GoalStatusChip` + timeline-style `GoalStatusPanel` (Turn N · Verify M · tokens · live elapsed, vertical event timeline, Pause/Resume/Clear buttons sending the deterministic commands), fed by the extended `chat:goal_updated` event (`totalWorkerRounds`, `totalVerifyRounds`, `elapsedMs`, `pauseReason`, `executionWait`).

### Prompt System (Plans 550/551)

The system prompt is fully template-driven (Handlebars, `packages/agent/src/prompts/`):

- **Module registry** (`prompts/modules/registry.ts`): one entry per authored content module under `assets/modules/*.hbs` (identity, system, destructive-actions, config-protection, communication, tools, tasks, skill-usage, duya-desktop-context, final-answer, plus profile-specific `*-coding` / gateway / research modules). Keys double as the section name for profile gating (`isSectionEnabled`) and prompt-cache keys. Config references are type-checked (`ModuleName`) so a template rename is a compile error, not a runtime render throw.
- **Assembly** (`PromptSystemConfig.staticModules`): each profile config is a declarative list of `StaticModuleRef` (`module` + optional `name`/`params`/`enabledWhen`). References normalize onto `SectionDef.compute`, inheriting profile gating, prompt-cache keying, and empty-collapse; `HbsPromptSystem.renderModule` is the single render entry (registry path + module `slots` mapper + params).
- **Two render contracts** (plan 551 D1): *authored* modules are pure text with assembly-time params; *context-fed* sections live under `assets/dynamic/*.hbs` and use preBuildHooks + `promptContextExtension` for async I/O (memory, environment, recent sessions) — the legacy per-profile `sections/` TS trees and the Plan 550 monolith template are retired.
- **Variants** (plan 551 D3): no custom Handlebars helpers — mappers precompute booleans (`identity_style_clause`, `tone_never_analysis`, `system_capability_*`) and templates branch with plain `{{#if}}`.
- **Prompt caching**: static modules cache per section name; dynamic sections are volatile; `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates the halves; downstream `DuyaAgent` joins with `'\n\n'`.
- **Byte-discipline**: every migration landed with byte-level parity tests; the remaining known whitespace artifacts (stray blank lines where gated blocks collapsed in the old monolith/legacy paths) are documented in plan 551.

### Context Compaction (Plan 422)

Single grok-style strategy in `packages/agent/src/compact/` (`micro`/`snip`/`reactive` deleted; only `SessionMemoryCompactStrategy` remains):

- **Trigger**: 85% context threshold; background prefire pass1 starts at 75% (two-pass with prefix-fingerprint invalidation).
- **Rebuild order**: `system → user_prefix → AGENTS.md → last_user_query → summary → system_reminder` (recent tail dropped by default, configurable).
- **Summary prompt**: 9 structured sections wrapped in `<summary>`, tool use disabled, prior summary carried forward as authoritative.
- **Robustness**: tool-call sanitize/validate (orphan ToolResult stripping, `historySanitize.ts`), degenerate-summary detection (<500 chars retry, `summaryGuard.ts`), `classifySuppressReason` failure classification feeding the 3-scope `Suppression` (size: sticky on budget change; auth: 5-min window, plan 552; other: turn-scoped), input ladder (Verbatim → Fitted → Lossy), wall-clock budget, dedicated `compact_model`, memory flush.
- **Storage**: append-only `CompactionEntry` (Plan 315) + rollout JSONL full retention (Plan 441). Original history is always recoverable from rollouts, so no separate segment/transcript store (won't-fix decision, plan 422 P3.4).

### Compaction Consolidation (Plan 552)

Convergence pass over the eight incrementally-stacked compaction plans (422 → 495 → 517 → 523 → 475 → 315 → 441 → 486), audited against minimax-code v2's single-path design:

- **Dead code removed**: the grok 5-state `CompactSuppression` machine (`compactErrors.ts`, zero production call sites), `adjustSliceBoundary` (imported, never called), `CompactionStore`, and the `SessionManager`/`SessionStoreManager` pair. Failure classification is single-sourced in `classifySuppressReason` (the live 3-scope `Suppression` inside `CompactionManager` is the only machine; plan 523 should extend it, not revive the deleted one). `auth` suppression is time-windowed (5 min) and self-heals — the previous `onAuthRefresh()` clear trigger had no callers, so one 401 permanently disabled proactive compaction.
- **Single token estimator + single window resolver**: all ad-hoc char divisors (`len/4`, `CHARS_PER_TOKEN = 3/4` copies in hooks/memory-rollout/session, a verbatim CJK-heuristic copy in `DuyaAgent`) now route through `@duya/ai`'s `estimateContextTextTokens` (plan 443 canonical); reverse (tokens→chars) budgets import the exported `CJK_CHARS_PER_TOKEN` / `ASCII_CHARS_PER_TOKEN`. Context-window resolution exists once in `@duya/ai` `resolveContextWindow` — the agent budget (`compact/contextWindow.ts` re-export) and the renderer ring (`useContextUsage.ts`) share one precedence chain (capability → catalog → 200K), closing the plan 517 R1 drift class.
- **Single context projection (plan 577)**: `ContextLedger` stores provider observations and epochs; `CompactionManager.getContextSnapshot(messages)` combines those with persisted timeline content and schema deltas. Budget probes and worker usage frames read the same `accounting.projectedNextInputTokens`; the renderer consumes that snapshot and uses its resolved context window for both percentage and denominator. Provider output volume never enters the prompt projection by itself.
- **Single trigger probe**: `CompactionManager.probeCompaction()` measures tokens, image count and both decision lines (`getTriggerLine` = max − reserve; `getHardLimit` = full window) from the manager's budget. The pre-turn proactive checkpoint (`CompactionCoordinator.runPreTurn`) and the mid-loop preflight overflow (`DuyaAgent`) both consume the probe — the mid-loop no longer compares against a local `contextWindow` copy that could drift from the budget. Suppression/cooldown gating stays with the callers; the image trigger keeps bypassing both (grok semantics).
- **Single reinjection channel**: `PostCompactReinjector.reinject` returns `systemSegments` instead of splicing system-role messages into the result array; the controller reads `result.reinjection.systemMessages` directly (no fragile re-scan of result messages). Producers (reinjector segments, `legacy_system` capture, bot `postSummarySections`) write into `CompactionEntry.reinjectedSystemMessages`; `extractLegacySystemSegments` is the sole reader at the model boundary. Over-threshold loop-brake accounting adds the restored segments' token cost back so totals match the pre-552 layout.
- **Summarizer input hygiene**: `SessionMemoryCompactStrategy.stripImagesFromMessages` was a no-op (images silently rode into the summarizer); image blocks are now replaced with a text note (mcode `[image]` flattening).

### Compaction Loop Brake + Capability Audit (Plan 517)

Three surgical fixes layered on top of the Plan 422 / Plan 495 stack after a user-reported compaction-loop bug in 2026-09-10:

- **Capability resolution audit log** (`apps/desktop/src/main/services/providers/provider-store.ts:resolveRuntimeCapability`): the silent `DEFAULT_CONTEXT_WINDOW = 200_000` fallback (`packages/agent/src/compact/types.ts`) was hidden from users on 1M-context models whose id is not in `allProviderModels` (custom OpenRouter-style ids, third-party relays). Each call now emits an info-level audit line with `{ providerId, modelId, contextWindow, source: 'config' | 'db' | 'preset' }` on the three success branches and a warn-level line with `{ providerId, modelId, apiFormat }` plus a concrete pointer to `[options].model_context[modelId]` in `config.toml` when all three layers miss. `DuyaAgent`'s constructor mirrors the same warn with `{ runtimeConfigHasCapabilities, model, apiFormat }`. Users can `grep 'fallback to 200000' app.log` and recover in one step. Override priority: `config.options.model_context[modelId]` > DB row > built-in `allProviderModels`.
- **Turn-based + token-based cooldown** (`packages/agent/src/agent/DuyaAgent.ts:1594`, gates `imageTriggered || compactionController.shouldCompact()`): the proactive checkpoint now skips when `turnsSinceLastCompact < MIN_TURNS_SINCE_COMPACT (3)` OR `tokensGrowthSinceCompact < MIN_TOKENS_GROWTH_SINCE_COMPACT (30_000)`. Cooldown baseline pins on every successful proactive compaction via the new `lastCompactionTurn` and `lastCompactionObservedTokens` instance fields. The Pi/grok-style design lets the agent run at least three tool-use turns after each compaction; image-volume triggers (`compact/imageParts.ts`, Plan 495) bypass the gate so multimodal floods are still handled immediately.
- **`overThresholdAfterCompact` becomes an active loop brake** (`packages/agent/src/compact/CompactionManager.ts:compact`): the flag that Plan 422 computed but never consumed is now wired. When `overThresholdAfterCompact === true` (e.g. system prompt + reinject overshoot), `suppression.trySuppress('size')` fires and a new `compaction_over_threshold` event emits with `{ tokensRetained, available }`. The next `shouldCompact()` returns false at the existing suppression gate until a future successful compaction shrinks `finalTokens` below `available` — breaking the loop where Plan 422 ran every other turn because the post-compaction context kept re-crossing the threshold. `Suppression.trySuppress(type): boolean` (idempotent) lives on the 3-state `Suppression` machine inside `CompactionManager`; the former 5-state `CompactSuppression` API in `compactErrors.ts` was deleted in plan 552 (zero production call sites).
- **Per-step lifecycle events** (`packages/agent/src/compact/CompactionManager.ts` + `packages/agent/src/process/worker-protocol.ts` + `apps/desktop/src/renderer/lib/stream-session-manager.ts` + `apps/desktop/src/renderer/stores/compaction-store.ts`): a new `compaction_step` event (`projecting | cutting | summarizing | rebuilding | reinjecting | trimming`, `started | finished`) plus `compaction_over_threshold` flow as `compact:step` and `compact:over_threshold` SSE frames. The renderer mirrors them into the `compaction-store` (`CompactionPhase` union extended) and into the inline `CompactSummary` row, replacing the legacy single-spinner `'Compacting context...'` with `Summarizing 32 messages...`, `Re-injecting files, skills and tools (6 cached)...`, `Trimming — still over budget`, etc. i18n keys live in `apps/desktop/src/renderer/i18n/en.ts` / `apps/desktop/src/renderer/i18n/zh.ts` under `streaming.toolAction.compact.step.{phase}`. `ActionRowChrome` accepts a `verbText?: string` precedence over `verbKey` for callers that need interpolation variables. `@duya/ai`'s `SSEEvent` union gained the four `compact:*` frame types so the legacy `as unknown as SSEEvent` casts in `DuyaAgent.ts` could finally be removed at a future cleanup.

### Long-Session Parity Additions (Plan 495)

Grok-parity gap closure on top of Plan 422, from the 2026-09-05 grok-bot compaction/epoch study:

- **Background prefire** (`compact/BackgroundPrefire.ts` + `CompactionManager.maybeStartPrefire`): when usage crosses 75% of the compaction threshold a passive pass1 summarization runs best-effort; `MessageCompactionController.compactProactive` consumes the completed pass as the `previousSummary` seed (grok two-pass semantics). Validity is a message-id prefix fingerprint — append-only growth keeps it valid; a rewrite (mid-pass compaction) discards the result as prefix-invalid. Kickoff happens at DuyaAgent's per-turn proactive checkpoint; failures never block the turn.
- **Image-parts trigger** (`compact/imageParts.ts`, `IMAGE_COMPACTION_TRIGGER_COUNT = 85`, grok parity): counted at the turn-start checkpoint and the mid-loop preflight-overflow checkpoint; firing forces compaction via `CompactOptions.force` even under the token budget (screenshot-heavy runs degrade attention before the budget does).
- **Summary retry ladder** (`compact/summaryRetry.ts`): up to 3 attempts; output-length errors get a one-shot shorter-output instruction; input-length errors shrink the summarized range (tool traffic drops first, `TOOL_MESSAGE_DROP_THRESHOLD = 0.25`, grok `reduceSelfSummaryInputMessages` parity); fatal errors throw immediately; empty/degenerate exhaustion returns '' so the strategy's placeholder path keeps the compaction successful.
- **Wake preemption / redrive / tail guard** (`apps/desktop/src/main/wake/wake-dispatcher.ts`, 476 §2.2 close-out): a preempting wake (user message / priority DM) interrupts a dispatcher-owned in-flight run at enqueue time (`interruptRun` dep, best-effort `DELETE /sessions/:id/chat`); the displaced item re-queues as `isRedriven` (exempt from the epoch-stale skip and the recently-dispatched dedupe) and runs after the preempting turn. A run whose epoch advanced mid-flight has its user-facing tail side-effects (DM auto-return) suppressed — grok turn-runtime parity. Dispatching a user-lane wake does not advance the epoch (existing 476/477 contract).

### Compact Lazy-Spawn Handshake (Plan 508)

Bot sessions whose worker has been idle-reaped and is being lazy-spawned by `POST /sessions/:id/compact` previously hit a misleading `Agent not initialized` error: the router's ready handshake only filtered on event type, never on `ready.status`, so a worker that emitted `ready { status: 'error' }` (e.g. bot session missing `provider_id`) was treated as ready and the subsequent `compact` command ran against a worker whose `initAgent` had thrown. Plan 508 fixes this:

- **`waitForWorkerReady(child, timeoutMs)`** (`apps/desktop/src/main/agents/server/router.ts`): typed `WorkerReadyOutcome` distinguishing `status: 'error'` (HTTP 503 + worker error verbatim), `status: 'deferred'` (HTTP 409), and timeout (HTTP 504). Extracted from `lazySpawnWorkerForCompact` so the contract is unit-testable.
- **`handleCompactMessage(msg)`** (`packages/agent/src/process/agent-process-entry.ts`): extracted from the `'compact'` switch case so it can be replayed from the init drain. When `!agent && initializing`, the message is stashed in `pendingCompactCommand` and replayed from the init finally block (same shape as `chat:start`'s drain); when `!agent && !initializing`, an `init-failed` reason surfaces so the renderer can recover via a fresh chat:start.

### Bot Run Scheduler (Plan 500, grok SandRunScheduler parity)

For `bot:<agentId>` sessions the wake dispatcher is the **authoritative run queue**: busy-time messages queue, queued work is graded into the three wake lanes assigned by source (user DMs → `user`, bot DMs / room member turns → `agent`, connector/automation/completion → `background`), and a priority judgment decides preemption. Normal (non-bot) sessions keep the mailbox path.

- **Run attribution** (`session_runtime_locks.origin`, Plan 500 P1): every chat run persists its origin (`user` / `agent` / `background`) on the runtime-lock row — the agent-server derives it from `options.runOrigin` (wake dispatches declare their lane; renderer chats are `user`), so main can classify ANY in-flight run, including renderer-driven ones. `LockStore.lockOrigin()` reads it.
- **Preemption rules** (`packages/agent/src/wake/preemption.ts`, grok "superseded" parity): a new user message preempts ANY in-flight run — including a user turn (displaced user runs are NOT redriven; the user replaced them on purpose and the partial transcript is persisted). Priority DMs still preempt only non-user runs. `tryPreemptRunning` classifies foreign lock holders via the lock origin and applies the same decision.
- **User-lane producer** (`bot:sendTurn` IPC, Plan 500 P2): every bot-DM send goes through the main gate. Idle → `{action:'start'}` and the renderer runs its normal streaming path; busy → the message parks on the user lane (preemption already applied at enqueue). When a queued user turn's slot arrives, main broadcasts `bot:scheduled-turn`; one renderer window claims it (IPC CAS) and streams it, otherwise a hidden user-turn fallback (`runUserTurnInSession`, session's own model, `userTurn` semantics) runs it. The renderer's queued bubble and the push are matched by the minted `messageId`.
- **Group integration** (Plan 500 P4): room member turns run through `dispatchBotTurn` as `group.turn` agent-lane items (`turnWaiters` resolve the room chain's promise when the run finishes). A busy member parks instead of 409-passing; user messages preempt member runs with redrive; room-level epoch/serialization is unchanged.
- **Watchdog + persistence** (Plan 500 P5): a user item parked longer than `DUYA_BOT_WATCHDOG_MS` (default 120 s) interrupts the wedged run; queued `user.message`/`agent.dm` items persist to `pending_wakes` and rearm after restart. `PendingWakeStore` is wired into `CoreStores` (it previously existed unwired).
- **Watchdog escape** (Plan 501 L3): if the interrupted run still holds the lock after a grace period (`DUYA_BOT_WATCHDOG_ESCAPE_MS`, default 30 s), the dispatcher escapes it grok zombie-parity — waiters resolve, displaced work re-queues, the drain generation bumps so the zombie run's eventual return is discarded, and a fresh drain pumps the queue (the wedged run keeps the lock; the lock TTL stays the correctness backstop).
- **Redrive narrative + cap** (Plan 501 L3): re-queued runs carry a hidden `[redriven]` prompt preamble (grok re-delivery note — the model knows its earlier attempt was interrupted); `redriveCount` increments per redrive and the item is dropped beyond `MAX_WAKE_REDRIVES` (3), posting a room narrative for `group.turn` items via `appendGroupTurnDroppedNotice`.
- **Agent DM wire protocol** (2026-10-12): the envelope, intent taxonomy, digest, validator, codecs, text clamp, and dedupe helpers live in `packages/agent-protocol/src/agent-dm.ts` and are exported through the protocol's public entry. Desktop's DM dispatcher and automatic reply path use that shared contract; `packages/agent/src/agent/dm/` remains a compatibility re-export for Agent tools. Wake prompts and run scheduling remain in their current owners, so this does not move execution into Host.
- **Persisted bot/room session IDs** (2026-10-12): `packages/agent-protocol/src/session-ids.ts` owns the `bot:` and `room:` prefixes and their constructors/parsers. Data, Desktop Main, and the renderer consume this contract directly; Agent and local UI modules keep compatibility exports. Existing IDs retain their exact spelling, so no database rewrite is required.

### Stability Layers (Plan 501)

- **Frozen-prompt discipline** (`packages/agent/src/prompts/bot/`): bot sections split into stable (identity/roster/promptConfig — content-hash keyed) and `volatile` (memory×3 / automations / channels / spotlight — keyed on the compaction epoch ALONE). Mid-epoch memory writes no longer invalidate any section render; volatile data refreshes at the next compaction boundary (grok `resolveFrozenMemoryPrompt` parity). Identity changes mid-epoch stay covered by the profileUpdate envelope.
- **Compaction → rotation trigger** (`apps/desktop/src/main/db/core/message-log.ts`): `appendBatch` rotating a bot session's rollout file whenever a compaction payload lands (plan 493 Phase B now actually fires) — each compaction bumps `chat_sessions.generation` and the compacted summary becomes the first data entry of the fresh generation, so the agent-side `countTimelineCompactions` (summaryEpoch) and the storage generation stay aligned. Rotation failure is fail-open (append proceeds).
- **Delivery counting** (`packages/agent/src/hooks/send-message-reminder.ts`): `post_to_room` counts as a delivery alongside `SendMessage`, so the mechanical delivery-owed backstops read a room turn that already spoke as delivered.

### Bot Identity & Avatar (Plans 483/485, 481 amendment)

A bot's runtime identity lives in `<duyaRoot>/agents/<id>/profile.json` (`apps/desktop/src/main/config/bot-profile.ts`): `name` / `description` (model-updatable via `update_state`), `title` (host-managed only), `avatarColor` (color token for the initial-circle avatar) and `avatarImage` (filename of an image inside the agent dir). `config.toml [agents.<id>]` name/description only seed the profile on first creation and act as fallback (485 §2.4). Avatars were (shape, color) tokens until 2026-09-05 — shape tokens are removed; legacy files' `avatarShape` is ignored on read.

Plan 502: `title` is fully wired for the host side — create/edit dialogs and `BotSettingsPanel` expose a role-title input, creation seeds it via `AgentUpsertInput.title` → `seedBotProfileIfMissing`, and the sidebar renders it as the contact subtitle (`BotContactListItem`: `title || description`). The model still cannot set it. Bot ids are minted at a SINGLE point in the main process (grok `agent-session.ts` parity: ids are never user-authored): `config:agents:create` accepts an empty id and slugs it from the display name via `slugifyBotIdFromName`, then `allocateBotId` allocates a collision-free id against config keys, on-disk trees, and `.deleted` tombstones; the old renderer-side `deriveBotIdFromName` duplicate is removed. Ids stay readable slugs (unlike grok's opaque uuids) because they double as config keys and `send_to_agent` addresses.

Avatar rendering priority (`apps/desktop/src/renderer/components/layout/sidebar/BotCharacterAvatar.tsx`): image → colored initial circle → deterministic-hue fallback. The image is served to the renderer over the `duya-file://` protocol (`apps/desktop/src/main/index.ts`); `listBots()` pre-builds the URL with a `?v=<mtime>` cache-buster, so the renderer never handles raw paths.

Write paths, all converging on profile.json:

- **UI edit** (`EditBotDialog` / `BotSettingsPanel`, shared `useBotContactForm`): identity via `config:agents:updateBotProfile` → `updateBotProfileIdentity`; avatar image upload via `config:agents:uploadBotAvatar` (file dialog + copy in the main process) and `config:agents:clearBotAvatarImage`.
- **Model self-edit** (`update_state` profile.set / avatar.set / avatar.clear): routed through the `bot-identity:rpc` channel (agent subprocess → agent-server-lifecycle → `apps/desktop/src/main/config/bot-identity-rpc.ts`), which binds the subaction to the session's `bot:<agentId>` identity (a bot can only edit its own profile), validates color tokens and image sources, and calls the same identity writers. `avatar.set` accepts `avatarColor` and/or `avatarImagePath` (e.g. the model's own `image_generate` output; validated extension whitelist + 5 MB cap + magic bytes, then copied to `agents/<id>/avatar.<ext>` by `setBotAvatarImage`).

### Shared Agents Root (Plan 526)

The ENTIRE `agents/<agentId>/` tree — identity (profile.json, settings.json,
avatar), sessions, memory shards, skills AND the channels subsystem
(`channels/<platform>/connection.json`, `connector-secrets/<platform>.json`,
`gateway/weixin/` state, `attachments/inbound/`) — lives under the shared
`<duyaRoot>/agents` root (`~/.duya/agents`), resolved via
`getSharedAgentsRoot()` (`apps/desktop/src/main/config/agent-paths.ts` →
`ConfigStore.getConfigDir()`). This is what makes a bot fully portable
across dev and packaged installs: previously channel bindings lived under
`<userData>/agents/`, which is namespaced per install mode (`duya-dev` vs
packaged), so a packaged app could never see bindings configured in dev.
The worker already read `connection.json` from the shared root
(`packages/agent/src/prompts/bot/loader.ts`), so main and worker now agree.
At boot, `apps/desktop/src/main/channels/legacy-root-migration.ts` merges any remaining
`<userData>/agents/*` channel data into the shared root (per-file,
target-exists wins, source kept). Soft delete/hard delete of a bot moves or
removes the whole directory, so credentials are purged with the bot.

### Bot Routines & Event Listeners (Plan 499, 476 P2.3b/P2.3d)

A **routine** is a `cronjob.toml` entry with `agent` set (bot binding): `name` + `prompt` (the standing order) + a time `schedule` and/or declarative `eventTriggers` (`apps/desktop/src/main/automation/trigger-match.ts` — github: repo/events/userAllowlist, slack: channel + mention/keyword/message). Fires wake the bot's **resident session** through the wake bus as hidden `[routine]` turns (`enqueueAutomationWake` in `apps/desktop/src/main/wake/wake-dispatcher.ts`, background lane); the prompt is built at **dispatch time** from cronjob.toml by the dispatcher's `resolveRoutinePrompt` dep (`apps/desktop/src/main/automation/routine-wake.ts`), so a queued fire wakes with the routine's current definition and a deleted/disabled one skips silently.

- **Scheduled/manual fires** (`apps/desktop/src/main/automation/Scheduler.ts`): the former agent-bound stubs now claim the fire (`lastRunAt`, at-least-once) and enqueue a wake; standalone cron behavior is unchanged.
- **Event fires** (`apps/desktop/src/main/automation/listener-hub.ts`): a poll-driven hub (grok SandTriggerHub collect→match→fire shape, no cloud arbitration — duya is local-first). Each tick it polls github `/repos/{r}/events` and slack `conversations.history` with the OAuth token from App Connections (`listener-polls.ts`, injectable fetch), persists per-listener cursors in cronjob.toml (`listener_state`), seeds cursors on first run without replaying history, keeps cursors on poll failure, and coalesces matches into ONE wake carrying a sanitized event summary + escaped `<github_event>`/`<slack_message>` context blocks (payload fields `eventSummary`/`eventContext`). A platform with no connected App Connection stays silent.
- **Bot tool** (`manage_routine`, `packages/agent/src/tool/ManageRoutineTool/`): single action tool (create/update/pause/resume/delete/list) over the existing `automation:cron:*` db-bridge channels; ownership enforced agent-side from the calling bot's session id (SendToAgentTool precedent — the bridge has no session context). Schedule etiquette (weekday daytime default, minute rule, self-expiry, auth-failure pause) lives in the tool description; wake-cue conduct plus the bot's inventory render in the `botAutomations` prompt section.
- **UI**: `BotSettingsPanel` embeds `BotRoutinesSection` (rakazo-style rows + inline editor; run history stays in the bot conversation); the global AutomationView badges bot-bound entries. Event-only routines keep their trigger set bot-managed (UI read-only).

### Shared Rooms / Group Chat (Plan 478, grok group-chat port)

Multi-bot rooms (≤6 members + user) in one shared transcript. The room is a **logical config room** (`~/.duya/groups.toml` `[groups.<id>]`: name / members / max_rounds=3 / max_member_turns=10) — it never runs an LLM; its transcript is the MessageLog session `room:<roomId>` (`apps/desktop/src/main/wake/group-turn-dispatcher.ts::ensureRoomSession`, `agentType: 'room'`).

- **Pure mechanics** (`packages/host/src/group-turn.ts`, public subpath `@duya/host/group-turn`): faithful grok `group-chat.ts` + `group-chat-orchestrator.ts` port — mention parsing (`@Name` word-bounded handles + `@everyone`/`@all`), `resolveResponders` (only messages since the last user post count; no mentions = all members), round-robin `orderRoundSpeakers`, `(pass)` silence, `GROUP_MAX_ROUNDS`/`GROUP_MAX_MEMBER_TURNS`/2-messages-per-turn caps, epoch-cancellable rounds, failed member turn = pass. Desktop dispatch and `PostToRoomTool` consume the Host API; `packages/agent/src/wake/groupTurn.ts` remains a compatibility re-export.
- **Delivery**: the member's only room voice is the `post_to_room` tool (in `BOT_TOOLSET`; discoverable via exact-name promotion). It validates the room + membership against groups.toml (`validateRoomTarget`, `packages/agent/src/session/room-db.ts`) and appends the authored entry (`source: 'group'`, `metadata.groupPost` — whitelisted in `PERSISTED_METADATA_KEYS`, surfaced as `group_post_meta`) directly to the room transcript session; the `message:append` db-bridge broadcast gives every renderer the room view in realtime. Turn budget Map uses a CONSTANT run key (Mimosa scanner false-positives on `Map.get(<tool input>)`).
- **Orchestration** (`apps/desktop/src/main/wake/group-turn-dispatcher.ts`): per-room turn epoch + promise chain; each member turn is one hidden wake on the member's `bot:<agentId>` session via `runWakePromptInExistingSession` (profile-bound, 409/失败 = pass), prompt = grok group member contract + transcript window since the member last spoke. Triggers: user post (`room:post` IPC — bumps epoch, interrupts the in-flight member run, voids the remaining plan) and bot post (db-bridge append hook); a group_system conclusion row closes each turn. Pending: automation seeding, DM-preemption redrive, token budget fuse.
- **Prompts**: groups render inside the agent-messaging contract — `loader.ts` reads groups.toml (worker-side) → `ctx.agentGroups` → `renderBotRoster` passes `AgentGroupSummary[]` into `buildAgentMessagingSystemPrompt`.
- **UI**: sidebar Bots section gains a 群聊 group (`buildRoomContacts` + `RoomContactListItem`, composite room avatar); `GroupRoomChatView` (source-filtered `useRoomTranscript`, speaker-name lines, group_system rows, @mention composer with member picker dropdown); `GroupSettingsDialog` (create/edit ≤6 members/delete) over `config:groups:*` + `room:ensure|post|getTranscript|members` IPC (`apps/desktop/src/main/ipc/group-handlers.ts`, preload `groups`/`room`). `App.tsx` mounts it for `resolveChatMode === 'room'`; ChatView no longer falls through for room sessions.

### Sub-agent Runtime & Side Panel (Plan 571)

**Lifecycle vocabulary.** A sub-agent run has exactly five states, defined once in
`apps/desktop/src/renderer/lib/subagent-status.ts` and consumed by every surface:
`pending | running | completed | failed | killed`.
`killed` is first-class: `BackgroundAgentLifecycle.kill()` already records it agent-side, and
before plan 571 the renderer had **three** incompatible spellings of the same lifecycle
(`SubAgentRowInfo.status`, `ParsedSubAgentToolResult.status`, agent-side `TaskStatus`), none of
which could express a user cancel — so a stopped sub-agent rendered as a failure.
`deriveSubagentStatus(events)` derives state from the ordered progress events; the last terminal
event wins, and a kill (an `error` whose `data` starts with `killed`) resolves to `killed`.

**Event stream.** A sub-agent runs **in-process inside its parent's worker** — it has no process
and no SSE session of its own. Its events are multiplexed onto the parent's
`chat:agent_progress` channel and tagged with the child's own session id
(`agentSessionId` on the wire, remapped to `event.sessionId` by
`stream-session-manager.ts::handleAgentProgressEvent`).
`text` / `thinking` payloads are **incremental deltas**, not cumulative snapshots
(`DuyaAgent.ts:2520-2528`), so a renderer subscriber can rebuild the child's transcript from the
event log alone. `heartbeat` is a keepalive type carrying no content and must never enter a
transcript projection.

**Two buffers, on purpose.** `SessionState.agentProgressEvents` is scoped to one parent turn — it is
reset on run start (`:1708`) and dropped by the terminal slim (`:3309`). That is correct for the
parent transcript and wrong for a child, which routinely outlives the turn that spawned it. Plan 571
adds `subagentProgress`, keyed by **child** session id and never cleared on a turn boundary;
`subscribeToSubagentProgress()` replays retained history synchronously before streaming live, so a
panel opened mid-run renders what it missed. Entries are reclaimed once terminal, past a 5-minute
retention, **and** unlistened; a mounted panel pins its log. This is the same split ZCode reaches by
routing raw child events onto the child session's event topic
(`runtime/methods/subagent.ts:335-339`) — duya gets the equivalent by keying the multiplexed
channel, with no transport change.

**Side panel.** `SessionMessagesPanel` (registry id `session-messages`, `multiInstance`, opened
programmatically via `duya:open-session-panel`) renders any persisted session in the sidebar and
reuses the main `MessageList` — ZCode-parity reuse of the main chat view rather than a bespoke
renderer. It serves two kinds of session: sub-agents (live event stream available) and workflow
actor nodes (no event stream; historical only). Live sub-agents stream via
`useSubagentRuntimeStream` with **no polling**; the historical path keeps its reload as a fallback.
Emitters never touch panel state — they dispatch a CustomEvent carrying
`{ sessionId, parentSessionId, taskId, title }` and the panel provider resolves dedup/focus
(tabs dedup on `sessionId` only).

**Stop path.** `POST /sessions/:parentSessionId/subagents/kill { taskId }`
(`apps/desktop/src/main/agents/server/router.ts::handlePostSubagentKill`) → `workerManager.sendCommand(parentSessionId,
{ type: 'subagent:kill', taskId, reason: 'user_kill' })` → worker →
`backgroundAgentLifecycle.kill(taskId, 'user_kill')`.
It is keyed by the **parent** session because the child has no worker. A 404 means the parent
worker is no longer resident, which the panel treats as a no-op rather than an error.

**Result contract.** The `task` tool returns a discriminated shape keyed on `status`
(`pending | running | completed | failed | killed`) carrying `sessionId`, `taskId`, `outputFilePath`,
`totalToolUseCount`, `totalDurationMs`, `totalTokens`, `usage`, `workingDirectory`, `isolation`, and
`warnings`. `apps/desktop/src/renderer/lib/subagent-result.ts` parses it and still accepts the pre-571 field names
(`childSessionId`, `backgroundTaskId`, `outputFile`, `isAsync`) so already-persisted history keeps
rendering. A background launch receipt is a *successful* result that says nothing about the child —
it must never be read as completion.

## Package Workspace

### Canvas Workbench Runtime (Plan 570)

Turns a canvas into a long-running workbench (stock consoles / learning
dashboards / project boards). Desktop Main owns the current fetch/scheduler and
widget broadcast lifecycle; all Workbench database operations cross the
authenticated local Host API, so standalone Host and Desktop use the same Data
store.

- **Persistence** (`packages/data/src/workbench-store.ts`,
  `WorkbenchDataStore` over the Host-owned main database): `conductor_data_sources`
  (id / canvas_id / name / type `http|project_db` / config / refresh_interval /
  last_snapshot / last_error) + `conductor_handlers` (forward-looking, unused
  in v1). `HostLocalWorkbenchApiV1` lives in Agent Protocol; authenticated
  loopback routes provide CRUD, canvas/element checks, due-source queries, and
  refresh-result writes. Source configs may contain credentials, so the API is
  local-only.
- **Service** (`apps/desktop/src/main/conductor/workbench-service.ts`, singleton
  `workbenchService`): asynchronous Host API CRUD + `refreshSource` — http fetch
  (main-process, no CORS; headers support `$env:NAME`) or project-DB query via
  `ProjectDatabaseService.invoke` — saved through Host then broadcast as
  `conductor:data:update`; scheduler tick every 5s refreshes due interval
  sources (≥15s, in-flight dedupe, ≤6 concurrent); widget action intake
  (`conductor:widget:action` IPC) validates element→canvas ownership and rate
  limits 10/min/element.
- **Agent tools**: `canvas_data_source`
  (`packages/agent/src/tool/CanvasConductor/CanvasDataSourceTool.ts`) over
  executor RPC actions `data_source.manage` / `data_source.refresh`
  (`apps/desktop/src/main/conductor/executor-proxy.ts`).
- **Renderer** (`packages/conductor/src/renderer/elements/workbench-runtime.ts`):
  dynamic widget srcdocs get the runtime injected — `window.duya.data`,
  `duya.onData(cb)`, `duya.action('refresh', sourceId)`, attribute-driven
  buttons (`data-duya-refresh`), and agent-authored inline `<script>` blocks
  re-enabled after the runtime (same trust model as the chat widget path).
  `WidgetShell` pushes canvas snapshots into the iframe on load/change and
  routes `workbench:action` intents to the main process. Store slice:
  `conductor-store.workbenchData` (per-canvas snapshot map, merged per source).

### Import history and rollback metadata

`@duya/data` owns `ImportBatchStore` for the `import_batches` and
`import_items` tables. Desktop's import apply, rollback, and history IPC use the
authenticated local `HostLocalImportBatchApiV1`; file and session import work
still runs in Desktop Main. The Host returns camelCase protocol records for
history and rollback, so renderer DTOs no longer depend on SQLite row names.

Desktop settings and browser-extension IPC use the authenticated local Host
settings API for extension allowlists, blocked domains, sandbox state, and host
tool permission. Startup also loads the browser allowlist and max-tab setting
through Host before starting the browser daemon; the download directory is
loaded from Host at startup and refreshed by the settings IPC handlers, so
download events no longer read SQLite directly. The Desktop CLI's skill
override list/read/write and capability snapshot also use Host settings.
Provider reinitialization now reads each running session's working directory
and `system_prompt` through Host's authenticated local session projection.
Electron Main still performs browser-daemon and worker lifecycle actions. The
process pool reads the browser backend setting through Host before initializing
Desktop workers; a headless process-pool path retains the `auto` fallback when
no Desktop Host is present.

## Package Workspace

```
packages/
├── agent/                @duya/agent - Agent core
├── agent-core/           @duya/agent-core - Run reasoning (zero IO)
├── agent-protocol/       @duya/agent-protocol - Transport-neutral wire contract
├── agent-runtime/        @duya/agent-runtime - Run execution engine
├── ai/                   @duya/ai - Multi-protocol LLM adapter
├── capabilities/         @duya/capabilities - Filesystem and shell tool implementations
├── cli/                  @duya/cli - CLI tools
├── computer-use/         @duya/computer-use - Computer use capability
├── conductor/            @duya/conductor - Conductor component
├── gateway/              @duya/gateway - Gateway component
├── plugin-core/          @duya/plugin-core - Plugin system
└── voice/                @duya/voice - Voice component

apps/
└── desktop/              @duya/desktop - Electron app (main/preload/renderer)
```

`agent-protocol`, `agent-core`, and `agent-runtime` are the plan 587
`managed: true` boundaries (`architecture-policy.yaml`) — zero tolerance, never
baselined.

## Frontend Architecture

### Directory

```
apps/desktop/src/renderer/
├── components/
│   ├── chat/           # Chat UI (MessageList, Input, etc.)
│   ├── layout/          # Panel, Sidebar, Header
│   ├── settings/        # Settings pages
│   ├── automation/      # Automation rules
│   ├── browser-use/    # Browser control
│   ├── browser-use-panel/
│   ├── extensions/     # Extension management
│   ├── providers/      # Provider configuration
│   ├── skills/         # Skill management
│   └── ui/             # Shared UI components
├── contexts/            # React contexts
├── hooks/              # Custom hooks
├── lib/                # Utilities (git-ipc, etc.)
├── stores/             # State management
└── types/              # TypeScript types
```

### State Management

- Zustand stores in `apps/desktop/src/renderer/stores/`
- React Context for global state

## Security

### IPC Security

- Path validation (reject absolute paths, traversal)
- Diff output bounded at 1 MB
- Safe partial output on buffer exhaustion

### Tool Execution

- Permission mode gates
- Tool protocol adapter validates inputs
- Stream size limits

### Durable Tool-Approval Cards (Plan 498)

When a tool permission check resolves to `ask`, the worker persists an
approval card instead of (or in addition to) the in-memory interactive wait.
The approval row and decisions live in `tool_approval_state` in the legacy
main database, reached in production through `HostToolApprovalApiV1` and its
authenticated Host HTTP transport:

- **Persist**: approval row in `tool_approval_state` (legacy main DB,
  `apps/desktop/src/main/db/toolApprovalState.ts`) + a chat card message
  (`msg_type='tool-approval'`, `metadata.sendMessage.approval` — rides the
  existing persistence whitelist). Deterministic ids
  (`approval-card-<requestId>`); re-writes are no-ops.
- **Surfaces**: bot sessions (`bot:<agentId>`, surface flag derived at
  chat:start) PAUSE the turn — the requestPermission handler returns
  `'paused'`, StreamingToolExecutor pushes a neutral "Waiting for user
  approval" tool result and the turn ends; interactive sessions keep the
  in-worker wait (SSE `permission` event → PermissionPrompt, 5-minute
  timeout) with the persisted card as crash fallback. AskUserQuestion-style
  two-phase prompts never pause.
- **Decide**: `db:toolApproval:resolve(id, allow|always|deny)` CAS-transitions
  the row (`pending → approved|denied`, terminal rows are no-ops), upserts a
  `tool_approval_rules` entry for `always` (scoped per bot/session), enqueues
  an `approval.resume` continuation wake, and broadcasts
  `tool-approval:updated`. The interactive fast path (`db:permission:resolve`)
  syncs card state via `syncApprovalCardAsync` and burns the ledger entry.
- **Replay**: the continuation run's retried call is authorized by the
  one-shot ledger — `canUseTool` consumes the `approved` row on an exact
  tool-name + input-hash match (CAS `approved → consumed`), so nothing else
  is pre-approved and a replay can never double-execute.
- Renderer: `BotToolApprovalCard` (bot-direct transcript; hydrated from
  `db:toolApproval:listBySession`, live via `tool-approval:updated`).

### Provider Auth

- Credential store (in-memory by default)
- OAuth 2.0 PKCE flow
- Device code flow support

## Logging

### System

`apps/desktop/src/main/logging/logger.ts` - Structured logger

### Levels

| Level | Console | File |
|-------|---------|------|
| DEBUG | No | Yes |
| INFO | Yes | Yes |
| WARN | Yes | Yes |
| ERROR | Yes | Yes |
| FATAL | Yes | Yes |

Default: `WARN`. Set `LOG_LEVEL=DEBUG` for verbose output.

### Component Tags

Filterable by component: `LogComponent` constants (AgentProcess, IPC, DB, etc.)

### Output

- Console: stdout/stderr
- File: `%APPDATA%/DUYA/logs/app.log`
- Rotation: daily, 7 days retention

## Build System

### Frontend

- Vite 6: `vite.config.ts`
- Output: `dist/`

### Electron

- esbuild: `scripts/build-electron.mjs`
- Output: `dist-electron/`

### Agent Bundle

- Format: CommonJS
- Entry: `packages/agent/bundle/agent-process-entry.js`
- Production: `resources/agent-bundle/agent-process-entry.js`

### Host Worker Bundle (`packages/host/bundle/` — tracked, verified)

**Decision (plan 610 T03): keep it tracked, and gate it.** The alternative —
gitignore it and build on demand — was rejected because the bundle is not an
optimisation: the packaged app ships `packages/host/bundle/` as
`resources/harness-bundle/`, and `duya chat` spawns `worker-entry.js` straight
out of a checkout. Ignoring it would make every consumer run `build:packages`
before the app starts, and a missing artifact in a support log would look like a
code bug. So the artifact stays in git, and the drift it invites is caught by a
check instead of by convention.

- Builder: `scripts/build-agent-bundle.mjs` (two esbuild entries —
  `worker-entry.js` from `packages/cli/src/agent-worker-entry.ts`, and
  `BashTool/BashWorker.js` from `packages/host/src/managed-shell/BashWorker.ts`,
  which is spawned as its own process with `external: []`). It `rmSync`s the
  directory and rebuilds, so the directory is fully owned by the build.
- Inputs recorded by esbuild: `worker-metafile.json` (also committed — it is the
  bundle's own record of the ~2200 files it was built from; ~1072 of them are
  first-party and are the set the check judges).
- Verify: `npm run bundle:verify` (`scripts/architecture/bundle-verify.mjs`).
  Exit `0` fresh, `1` stale, `2` undetermined — `2` is not `0`, because "could
  not measure" and "measured clean" are different answers.

**How staleness is judged, and why not by rebuilding.** The obvious check is
"rebuild and compare bytes", and it does not work here: esbuild's minified output
for this entry is not reproducible. Two consecutive builds of identical source
with identical options produced 5515115 / 5515139 / 5515105 bytes, diverging
inside minified identifier allocation (`var bP=S(()=>{})` vs
`var bP=S(()=>{"use strict"})`). A byte comparison against that reports stale on
every run, for a bundle that is fresh.

So the judgement is made from git, which is deterministic by construction: find
the commit that last wrote `packages/host/bundle/`, read the input list in
`worker-metafile.json`, and ask whether any of those files changed after it —
counting committed history **and** the current working tree. This is why the rule
is not "the directory was touched": an edit under `packages/host/src/__tests__/`
is not a bundle input and stays green.

The check answers about the metafile that is **checked in**, so its denominator
follows that file, not the tree. A local `bundle:agent` run rewrites both the
metafile and the artifact; until that result is committed, the check is judging a
bundle that no longer exists in git — and it says so, because the rewrites are
inputs that are now modified. Restoring `git checkout -- packages/host/bundle/`
is the way back to a meaningful verdict while an unrelated change is in progress.

**The rule for changes that touch the worker.** Edit source → rebuild → commit
the source and `packages/host/bundle/` in the same change:

```bash
npm run build:packages -- --target @duya/host
git add packages/host/bundle
npm run bundle:verify
```

A bundle that is older than its source is not caught by any test: the artifact is
byte-perfect, it is just perfect for a different tree. The consequence is silent —
the CLI and the packaged app execute last week's worker.

### Packaging

- electron-builder: `electron-builder.yml`
- Output: `release/win-unpacked/`, `release/win/`

## Testing

### Unit Tests

- Vitest: `vitest.config.ts`
- Run: `npm run test`

### E2E Tests

- Playwright `_electron` API
- Run: `npm run test:e2e`

### UI Verification

- Playwright MCP
- Requires: `npm run dev` + MCP tools

## Development Commands

```bash
# Dev
npm run dev                    # Vite dev server only (port 3000)
npm run electron:dev           # Vite + Electron together

# Build
npm run build                  # Production build (Vite)
npm run build:web             # Web frontend only
npm run build:agent           # Build @duya/agent workspace (tsc)
npm run bundle:agent          # Bundle Agent subprocess entry (esbuild)
npm run bundle:verify         # Check packages/host/bundle/ is not older than its source
npm run electron:build         # Build Agent + bundle + Vite + Electron

# Typecheck
npm run typecheck:all         # Frontend + Agent

# Test
npm run test                   # Vitest tests
npm run test:watch            # Vitest watch mode
npm run test:coverage         # Tests with coverage
npm run test:e2e              # E2E tests

# Package
npm run electron:pack         # Package current platform
npm run electron:pack:win     # Windows (.exe installer)
npm run electron:pack:mac     # macOS (.dmg)
npm run electron:pack:linux   # Linux (AppImage, .deb, .rpm)
```

## Data Flow Examples

### Chat Message Flow

```
1. User types message in Renderer
2. Renderer calls Agent Server (HTTP POST /api/chat)
3. Agent Server spawns/gets Worker Process
4. Worker runs DuyaAgent.chat()
5. DuyaAgent calls @duya/ai for LLM
6. @duya/ai calls external LLM API
7. Response streamed back via SSE
8. Agent Server forwards to Renderer
9. Renderer updates UI
10. Message saved to DB + rollout file
```

### Tool Execution Flow

```
1. LLM returns tool_use in response
2. DuyaAgent emits tool_use event via SSE
3. Renderer displays tool call UI
4. User approves (or auto-approve)
5. ToolExecutor runs tool
6. Tool result streamed back to LLM
7. Continue conversation loop
```

### Tool-use Group Progress Titles

Tool-call groups may carry a short progress title with source metadata:
`provider_commentary`, `model_progress_tool`, or `tool_fallback`. The OpenAI
Responses adapter maps only output text explicitly marked with the
`commentary` phase; ordinary assistant text and reasoning stay on their
existing paths. Other adapters without a distinct commentary field can use
the private `progress_update({ title })` control call or the deterministic
fallback.

The agent intercepts `progress_update` before ordinary tool resolution,
permission checks, execution, and durable result persistence. It is replayed
only in the working model request context. Each emitted tool call captures a
stable group ID, title, and source, which travel through SSE to the renderer;
late tool results therefore remain attached to their original group. Fallback
titles use bounded, allowlisted display data and localized generic labels.

## Key Design Decisions

### Why SQLite?

- Single-file, portable
- FTS5 for full-text search
- Trigram for fuzzy matching
- ACID compliant

### Why separate Agent Server?

- Isolation: Agent runs in separate process
- Streaming: SSE requires HTTP server
- Memory: Long-running conversations in separate process
- Security: Limit blast radius

### Why Workspace Packages?

- Independent versioning
- Clear dependency boundaries
- Can be published separately
- TypeScript strict mode per package

## Glossary

| Term | Definition |
|------|------------|
| Agent | AI assistant that can use tools |
| Session | Chat conversation context |
| Rollout | Experiment/session data file |
| Skill | Composable tool set |
| Mode | Agent behavior modifier |
| Provider | LLM API adapter |
| MCP | Model Context Protocol |

### Chat attachment and mailbox delivery

- `packages/agent/src/utils/attachment-images.ts` loads image bytes by attachment object identity, so repeated clipboard filenames remain separate. Worker chat startup and checkpoint mailbox guidance share this pipeline. The worker passes the detected image-input capability to `ChatOptions`.
- `packages/agent/src/message/mailbox-attachment-context.ts` projects persisted mailbox attachments into text context and supported image blocks. Image-only followups and queued turns are valid; text-only models receive vision analysis when available. Runtime guidance retains the existing hidden/transient lifecycle.
- Chat edits restore text and attachments to `MessageInput`; transcript rewind happens on submission. Pending edits require a cancellation receipt before replacement. `MailboxPanel` is the single pending-message view and shows current-run versus next-turn routing with previews. Saved mailbox rows always enter the promotion path, including saves that finish after a run ends.
