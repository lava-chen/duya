# Architecture

> Last updated: 2026-09

## Overview

DUYA is a Windows desktop AI agent client with a modular architecture:

- **Frontend**: Vite + React 19 + Zero Router (Electron renderer)
- **Desktop Shell**: Electron 28 (Main Process)
- **Agent Core**: `@duya/agent` workspace package
- **AI Layer**: `@duya/ai` multi-protocol adapter
- **Database**: SQLite via better-sqlite3

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vite 6, React 19, Zero Router, Tailwind |
| Desktop Shell | Electron 28 |
| Build | esbuild, electron-builder |
| Agent Core | TypeScript |
| Database | better-sqlite3 (FTS5, trigram) |
| Testing | Vitest, Playwright |

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop Shell (Electron)                  │
├─────────────────────────────────────────────────────────────┤
│  Main Process                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │  Core   │ │ Config  │ │ Memory  │ │Agents   │          │
│  │   DB    │ │  Store  │ │  State  │ │Manager  │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │   IPC   │ │Services │ │Gateway  │ │Auto-    │          │
│  │ Handlers│ │         │ │         │ │mation   │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
├─────────────────────────────────────────────────────────────┤
│              Agent Server (HTTP + SSE)                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Agent Worker Processes                  │   │
│  │  @duya/agent (workspace package)                    │   │
│  │  @duya/ai (multi-protocol LLM adapter)             │   │
│  └─────────────────────────────────────────────────────┘   │
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

DUYA uses two communication patterns:

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

- Agent Server runs as HTTP server in Main Process
- Each session spawns/is assigned to a Worker Process
- Streaming via Server-Sent Events

### 3. MessagePort

For high-frequency data: tool execution, tool streaming, config sync.

## App Connections (Connectors)

Unified AppConnector registry (Plan 455): first-party providers, plugin `.app.json`
declarations (`mcp-remote` / `rest` bindings), and custom connectors, resolved by
`electron/services/app-connections/app-connector.ts`. Tokens live in the main
process (encrypted vault) and never cross IPC.

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

## Database

### Location

- Windows: `%APPDATA%/DUYA/databases/duya-main.db`
- macOS: `~/Library/Application Support/DUYA/...`
- Linux: `~/.local/share/DUYA/...`

### Schema

Managed via `boot.json`. Core tables:

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

### Memory State DB (Plan 479)

Separate SQLite file (`memory-state.db`, next to `duya-main.db` in the same boot.json directory), managed by `electron/memory-state/`. Holds the memory control plane: projects / rollout catalog (0001), leases + stage1 outputs (0002-0003), curation runs / publications (0008), and the bot memory tier index (0010).

`memory_tier_index` (migration 0010, Plan 479 Phase 1) is a rebuildable query index over the file-manifest memory tree — the files remain the source of truth. Tiers: `agent` (own, `~/.duya/agents/<agentId>/memory/`), `user` (shared, `~/.duya/memory/`), `project` (`~/.duya/memory/projects/`). `entry_id` = sha256 of tier+writer+project+dedupe_key; shard-unique index enforces one entry per (tier, writer, project, key). Conflict rules live in `electron/memory-state/tierConflicts.ts`: newest-wins within a shard, earliest-via across shards, tier precedence agent > project > user. Store API in `electron/memory-state/tierIndex.ts` (`upsertTierEntry`, `listTierEntries`, `mergedTierRecall`, `rebuildTierIndexFromFiles` with dry-run).

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

## @duya/agent - Agent Core

### Entry Points

- `packages/agent/src/agent/DuyaAgent.ts` - Main agent class
- `packages/agent/src/session/MessageSession.ts` - Session management
- `packages/agent/src/session/TaskStore.ts` - Task state

### Tool System

- `packages/agent/src/tools/` - Built-in tools
- `packages/agent/src/mcp/` - MCP server integration
- Tool protocol adapter layer (Plan 418)

### Mode System (Plan 224)

Modes are declarative `ModeModifier` objects:

- `plan-task` - Plan + task execution
- `research` - Deep research (Plan 423)
- `conductor` - Orchestration
- `goal` - Goal tracking (Plan 411)

Registration: `packages/agent/src/modes/index.ts`

### Context Compaction (Plan 422)

Single grok-style strategy in `packages/agent/src/compact/` (`micro`/`snip`/`reactive` deleted; only `SessionMemoryCompactStrategy` remains):

- **Trigger**: 85% context threshold; background prefire pass1 starts at 75% (two-pass with prefix-fingerprint invalidation).
- **Rebuild order**: `system → user_prefix → AGENTS.md → last_user_query → summary → system_reminder` (recent tail dropped by default, configurable).
- **Summary prompt**: 9 structured sections wrapped in `<summary>`, tool use disabled, prior summary carried forward as authoritative.
- **Robustness**: tool-call sanitize/validate (orphan ToolResult stripping, `historySanitize.ts`), degenerate-summary detection (<500 chars retry, `summaryGuard.ts`), Deterministic/Transient/Cancelled error classification with scope suppression, input ladder (Verbatim → Fitted → Lossy), wall-clock budget, dedicated `compact_model`, memory flush.
- **Storage**: append-only `CompactionEntry` (Plan 315) + rollout JSONL full retention (Plan 441). Original history is always recoverable from rollouts, so no separate segment/transcript store (won't-fix decision, plan 422 P3.4).

### Long-Session Parity Additions (Plan 495)

Grok-parity gap closure on top of Plan 422, from the 2026-09-05 grok-bot compaction/epoch study:

- **Background prefire** (`compact/BackgroundPrefire.ts` + `CompactionManager.maybeStartPrefire`): when usage crosses 75% of the compaction threshold a passive pass1 summarization runs best-effort; `MessageCompactionController.compactProactive` consumes the completed pass as the `previousSummary` seed (grok two-pass semantics). Validity is a message-id prefix fingerprint — append-only growth keeps it valid; a rewrite (mid-pass compaction) discards the result as prefix-invalid. Kickoff happens at DuyaAgent's per-turn proactive checkpoint; failures never block the turn.
- **Image-parts trigger** (`compact/imageParts.ts`, `IMAGE_COMPACTION_TRIGGER_COUNT = 85`, grok parity): counted at the turn-start checkpoint and the mid-loop preflight-overflow checkpoint; firing forces compaction via `CompactOptions.force` even under the token budget (screenshot-heavy runs degrade attention before the budget does).
- **Summary retry ladder** (`compact/summaryRetry.ts`): up to 3 attempts; output-length errors get a one-shot shorter-output instruction; input-length errors shrink the summarized range (tool traffic drops first, `TOOL_MESSAGE_DROP_THRESHOLD = 0.25`, grok `reduceSelfSummaryInputMessages` parity); fatal errors throw immediately; empty/degenerate exhaustion returns '' so the strategy's placeholder path keeps the compaction successful.
- **Wake preemption / redrive / tail guard** (`electron/wake/wake-dispatcher.ts`, 476 §2.2 close-out): a preempting wake (user message / priority DM) interrupts a dispatcher-owned in-flight run at enqueue time (`interruptRun` dep, best-effort `DELETE /sessions/:id/chat`); the displaced item re-queues as `isRedriven` (exempt from the epoch-stale skip and the recently-dispatched dedupe) and runs after the preempting turn. A run whose epoch advanced mid-flight has its user-facing tail side-effects (DM auto-return) suppressed — grok turn-runtime parity. Dispatching a user-lane wake does not advance the epoch (existing 476/477 contract).

### Bot Run Scheduler (Plan 500, grok SandRunScheduler parity)

For `bot:<agentId>` sessions the wake dispatcher is the **authoritative run queue**: busy-time messages queue, queued work is graded into the three wake lanes assigned by source (user DMs → `user`, bot DMs / room member turns → `agent`, connector/automation/completion → `background`), and a priority judgment decides preemption. Normal (non-bot) sessions keep the mailbox path.

- **Run attribution** (`session_runtime_locks.origin`, Plan 500 P1): every chat run persists its origin (`user` / `agent` / `background`) on the runtime-lock row — the agent-server derives it from `options.runOrigin` (wake dispatches declare their lane; renderer chats are `user`), so main can classify ANY in-flight run, including renderer-driven ones. `LockStore.lockOrigin()` reads it.
- **Preemption rules** (`packages/agent/src/wake/preemption.ts`, grok "superseded" parity): a new user message preempts ANY in-flight run — including a user turn (displaced user runs are NOT redriven; the user replaced them on purpose and the partial transcript is persisted). Priority DMs still preempt only non-user runs. `tryPreemptRunning` classifies foreign lock holders via the lock origin and applies the same decision.
- **User-lane producer** (`bot:sendTurn` IPC, Plan 500 P2): every bot-DM send goes through the main gate. Idle → `{action:'start'}` and the renderer runs its normal streaming path; busy → the message parks on the user lane (preemption already applied at enqueue). When a queued user turn's slot arrives, main broadcasts `bot:scheduled-turn`; one renderer window claims it (IPC CAS) and streams it, otherwise a hidden user-turn fallback (`runUserTurnInSession`, session's own model, `userTurn` semantics) runs it. The renderer's queued bubble and the push are matched by the minted `messageId`.
- **Group integration** (Plan 500 P4): room member turns run through `dispatchBotTurn` as `group.turn` agent-lane items (`turnWaiters` resolve the room chain's promise when the run finishes). A busy member parks instead of 409-passing; user messages preempt member runs with redrive; room-level epoch/serialization is unchanged.
- **Watchdog + persistence** (Plan 500 P5): a user item parked longer than `DUYA_BOT_WATCHDOG_MS` (default 120 s) interrupts the wedged run; queued `user.message`/`agent.dm` items persist to `pending_wakes` and rearm after restart. `PendingWakeStore` is wired into `CoreStores` (it previously existed unwired).

### Bot Identity & Avatar (Plans 483/485, 481 amendment)

A bot's runtime identity lives in `<duyaRoot>/agents/<id>/profile.json` (`electron/config/bot-profile.ts`): `name` / `description` (model-updatable via `update_state`), `title` (host-managed only), `avatarColor` (color token for the initial-circle avatar) and `avatarImage` (filename of an image inside the agent dir). `config.toml [agents.<id>]` name/description only seed the profile on first creation and act as fallback (485 §2.4). Avatars were (shape, color) tokens until 2026-09-05 — shape tokens are removed; legacy files' `avatarShape` is ignored on read.

Avatar rendering priority (`src/components/layout/sidebar/BotCharacterAvatar.tsx`): image → colored initial circle → deterministic-hue fallback. The image is served to the renderer over the `duya-file://` protocol (`electron/main.ts`); `listBots()` pre-builds the URL with a `?v=<mtime>` cache-buster, so the renderer never handles raw paths.

Write paths, all converging on profile.json:

- **UI edit** (`EditBotDialog` / `BotSettingsPanel`, shared `useBotContactForm`): identity via `config:agents:updateBotProfile` → `updateBotProfileIdentity`; avatar image upload via `config:agents:uploadBotAvatar` (file dialog + copy in the main process) and `config:agents:clearBotAvatarImage`.
- **Model self-edit** (`update_state` profile.set / avatar.set / avatar.clear): routed through the `bot-identity:rpc` channel (agent subprocess → agent-server-lifecycle → `electron/config/bot-identity-rpc.ts`), which binds the subaction to the session's `bot:<agentId>` identity (a bot can only edit its own profile), validates color tokens and image sources, and calls the same identity writers. `avatar.set` accepts `avatarColor` and/or `avatarImagePath` (e.g. the model's own `image_generate` output; validated extension whitelist + 5 MB cap + magic bytes, then copied to `agents/<id>/avatar.<ext>` by `setBotAvatarImage`).

### Bot Routines & Event Listeners (Plan 499, 476 P2.3b/P2.3d)

A **routine** is a `cronjob.toml` entry with `agent` set (bot binding): `name` + `prompt` (the standing order) + a time `schedule` and/or declarative `eventTriggers` (`electron/automation/trigger-match.ts` — github: repo/events/userAllowlist, slack: channel + mention/keyword/message). Fires wake the bot's **resident session** through the wake bus as hidden `[routine]` turns (`enqueueAutomationWake` in `electron/wake/wake-dispatcher.ts`, background lane); the prompt is built at **dispatch time** from cronjob.toml by the dispatcher's `resolveRoutinePrompt` dep (`electron/automation/routine-wake.ts`), so a queued fire wakes with the routine's current definition and a deleted/disabled one skips silently.

- **Scheduled/manual fires** (`electron/automation/Scheduler.ts`): the former agent-bound stubs now claim the fire (`lastRunAt`, at-least-once) and enqueue a wake; standalone cron behavior is unchanged.
- **Event fires** (`electron/automation/listener-hub.ts`): a poll-driven hub (grok SandTriggerHub collect→match→fire shape, no cloud arbitration — duya is local-first). Each tick it polls github `/repos/{r}/events` and slack `conversations.history` with the OAuth token from App Connections (`listener-polls.ts`, injectable fetch), persists per-listener cursors in cronjob.toml (`listener_state`), seeds cursors on first run without replaying history, keeps cursors on poll failure, and coalesces matches into ONE wake carrying a sanitized event summary + escaped `<github_event>`/`<slack_message>` context blocks (payload fields `eventSummary`/`eventContext`). A platform with no connected App Connection stays silent.
- **Bot tool** (`manage_routine`, `packages/agent/src/tool/ManageRoutineTool/`): single action tool (create/update/pause/resume/delete/list) over the existing `automation:cron:*` db-bridge channels; ownership enforced agent-side from the calling bot's session id (SendToAgentTool precedent — the bridge has no session context). Schedule etiquette (weekday daytime default, minute rule, self-expiry, auth-failure pause) lives in the tool description; wake-cue conduct plus the bot's inventory render in the `botAutomations` prompt section.
- **UI**: `BotSettingsPanel` embeds `BotRoutinesSection` (rakazo-style rows + inline editor; run history stays in the bot conversation); the global AutomationView badges bot-bound entries. Event-only routines keep their trigger set bot-managed (UI read-only).

### Shared Rooms / Group Chat (Plan 478, grok group-chat port)

Multi-bot rooms (≤6 members + user) in one shared transcript. The room is a **logical config room** (`~/.duya/groups.toml` `[groups.<id>]`: name / members / max_rounds=3 / max_member_turns=10) — it never runs an LLM; its transcript is the MessageLog session `room:<roomId>` (`electron/wake/group-turn-dispatcher.ts::ensureRoomSession`, `agentType: 'room'`).

- **Pure mechanics** (`packages/agent/src/wake/groupTurn.ts`): faithful grok `group-chat.ts` + `group-chat-orchestrator.ts` port — mention parsing (`@Name` word-bounded handles + `@everyone`/`@all`), `resolveResponders` (only messages since the last user post count; no mentions = all members), round-robin `orderRoundSpeakers`, `(pass)` silence, `GROUP_MAX_ROUNDS`/`GROUP_MAX_MEMBER_TURNS`/2-messages-per-turn caps, epoch-cancellable rounds, failed member turn = pass.
- **Delivery**: the member's only room voice is the `post_to_room` tool (in `BOT_TOOLSET`; discoverable via exact-name promotion). It validates the room + membership against groups.toml (`validateRoomTarget`, `packages/agent/src/session/room-db.ts`) and appends the authored entry (`source: 'group'`, `metadata.groupPost` — whitelisted in `PERSISTED_METADATA_KEYS`, surfaced as `group_post_meta`) directly to the room transcript session; the `message:append` db-bridge broadcast gives every renderer the room view in realtime. Turn budget Map uses a CONSTANT run key (Mimosa scanner false-positives on `Map.get(<tool input>)`).
- **Orchestration** (`electron/wake/group-turn-dispatcher.ts`): per-room turn epoch + promise chain; each member turn is one hidden wake on the member's `bot:<agentId>` session via `runWakePromptInExistingSession` (profile-bound, 409/失败 = pass), prompt = grok group member contract + transcript window since the member last spoke. Triggers: user post (`room:post` IPC — bumps epoch, interrupts the in-flight member run, voids the remaining plan) and bot post (db-bridge append hook); a group_system conclusion row closes each turn. Pending: automation seeding, DM-preemption redrive, token budget fuse.
- **Prompts**: groups render inside the agent-messaging contract — `loader.ts` reads groups.toml (worker-side) → `ctx.agentGroups` → `renderBotRoster` passes `AgentGroupSummary[]` into `buildAgentMessagingSystemPrompt`.
- **UI**: sidebar Bots section gains a 群聊 group (`buildRoomContacts` + `RoomContactListItem`, composite room avatar); `GroupRoomChatView` (source-filtered `useRoomTranscript`, speaker-name lines, group_system rows, @mention composer with member picker dropdown); `GroupSettingsDialog` (create/edit ≤6 members/delete) over `config:groups:*` + `room:ensure|post|getTranscript|members` IPC (`electron/ipc/group-handlers.ts`, preload `groups`/`room`). `App.tsx` mounts it for `resolveChatMode === 'room'`; ChatView no longer falls through for room sessions.

## Package Workspace

```
packages/
├── agent/            @duya/agent - Agent core
├── ai/               @duya/ai - Multi-protocol LLM adapter
├── cli/              @duya/cli - CLI tools
├── computer-use/     @duya/computer-use - Computer use capability
├── computer-use-demo/@duya/computer-use-demo - Computer use demo
├── conductor/        @duya/conductor - Conductor component
├── gateway/          @duya/gateway - Gateway component
├── plugin-core/      @duya/plugin-core - Plugin system
└── voice/            @duya/voice - Voice component
```

## Frontend Architecture

### Directory

```
src/
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

- Zustand stores in `src/stores/`
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
approval card instead of (or in addition to) the in-memory interactive wait:

- **Persist**: approval row in `tool_approval_state` (legacy main DB,
  `electron/db/toolApprovalState.ts`) + a chat card message
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
  syncs card state via `syncApprovalCard` and burns the ledger entry.
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

`electron/logging/logger.ts` - Structured logger

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
