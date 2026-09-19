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

### Channel Attachments (Plan 507)

Per-bot channel connectors (`electron/channels/*-connector.ts`) and the gateway
route path carry inbound media to the bot and upload outbound files to the
platform. Two data flows:

- **Inbound persist + path injection**: adapters (`gateway-manager.ts`
  `forwardInbound`, Feishu/Weixin/TG deep adapters) download media to temp
  cache; the main process persists each to stable storage via
  `electron/channels/attachment-store.ts` →
  `~/.duya/agents/<ownerId>/attachments/inbound/<platform>/<ts>_<name>`
  (shared agents root, plan 526; atomic write, per-kind size caps mirroring
  `attachment-builder.ts`, traveral
  guard on owner/platform/name). The `ChannelInboundEnvelope.attachments`
  (`packages/agent/src/channels/types.ts`) feeds
  `packages/agent/src/channels/prompts.ts`, which renders
  `[attachment saved to: <path> (...)]` lines under each inbound message so the
  bot can Read/Bash the file. Oversize/unreadable entries become
  `[attachment skipped: <reason>]` lines instead.
- **Outbound real upload**: `SendMessage type:"attachment"` with a `file://` url
  becomes a `MediaReply` (`gateway` `NormalizedReply.type==='media'`) mapped in
  `electron/channels/connector-runtime.ts` (feishu/weixin live adapters) or a
  multipart send in `electron/channels/channel-delivery.ts` (`file-url.ts`
  decodes `file://` and infers MIME/key); media type follows MIME:
  image→photo, audio→voice, video→video, else document. A missing/empty file or
  `https://` url degrades to the existing text-with-link. Slack stays
  text-with-link.

### Gateway = Router + Status Broadcast (Plan 520)

`packages/gateway` serves the **legacy direct-channel line** only (settings
BridgeSection bindings). Bots ride the per-bot `electron/channels` pipeline
and never touch it. The gateway subprocess no longer:

- resolves sessions (`user-mapper.ts` deleted) — Main resolves/creates the
  session from the `gateway_user_map` row in
  `message-bus.ts:resolveOrCreateGatewaySession`;
- executes slash commands — `commands/dispatcher.ts` detects known commands
  and wraps them as `gateway:inbound { kind: 'command', command, args }`;
  Main executes help/new/reset/clear/status/stop and answers via
  `requestChannelSend`;
- gates senders — pairing (`electron/gateway/pairing.ts`,
  `gateway:pairing:*`, `/pair` `/approve` `/deny`) is fully removed;
  Main enforces a per-platform channel allow-list
  (`channel-directory.ts`, settings key `gateway_allowlist`, empty list =
  open) and replies `gateway:inbound:response { authorized }`.

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

### Rollout as First-Class Data (Plan 506)

The JSONL rollouts are the source of truth; `message_index` is a rebuildable projection. Core: `electron/db/core/message-log.ts` (export/import/reconcile + non-bot generation rotation), `electron/db/core/session-fork.ts` (checkpoint fork). IPC (`electron/ipc/db-handlers.ts`) + preload (`session.forkAt/archive/unarchive/listArchived`, `rollout.export/import/reconcile`):

- **Export** (`db:rollout:export`): one file is one session — bot sessions concatenate `archive-<g>.jsonl` generations in order + `active.jsonl`; read-only.
- **Import** (`db:rollout:import`): `restore` builds a new session from an external .jsonl; `continue` appends onto an existing session. All-or-nothing validation (1-based line numbers); ids colliding on the `message_index` GLOBAL PK are remapped into `import:<sessionId>:<oldId>` with every cross-reference (parentId / replyToId / compaction refs / rebase newMessages) following.
- **Reconcile** (`db:rollout:reconcile`): explicit whole-store index rebuild from the rollout files, reporting missing/orphan files; orphans are never deleted.
- **Fork** (`db:session:forkAt`): new session seeded from the source's projected timeline through a message id; fresh ids (`fork:<newSessionId>:<oldId>`), `parent_session_id` + `session_spawn_edges` edge of type `fork`.
- **Archive** (`db:session:archive/unarchive/listArchived`): status flip only — archived sessions leave the default `list()` result (`includeArchived` to reveal) but rollout files stay on disk.
- **Non-bot rotation** (Plan 506 C1): long ordinary chats rotate on the same `archive-<g>.jsonl` layout as bots once they cross `NON_BOT_ROTATION_THRESHOLD_BYTES` (4 MB) — compaction triggers rotation for already-rotated sessions; the active file's generation directory is sticky so segments never split.

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

#### Four-Tier Tool Exposure

Every registered tool carries an `ExposeMode`
(`packages/agent/src/tool/registry.ts`) that decides how the model sees it.
All discovery/invocation paths funnel through one set of rules:

| Tier | ExposeMode | Request tools array | Discovery | Invocation |
| ---- | ---------- | ------------------- | --------- | ---------- |
| T1 | `always` | full schema entry | n/a (declared) | direct call |
| T2 | `hint` | stub entry: name + description + argument summary, empty schema (`tool/hint-stub.ts`) | full schema via `tool_schema` | direct call |
| T3 | `discoverable` | absent until found | `tool_search` hit → schema appended as a conversation-tail block (`agent/tool-search-discovery.ts`) | `tool_invoke` |
| T4 | `hidden` | never | invisible to `tool_search` and the `tool_schema` catalog | unreachable by the model |

Key wiring:

- Visibility policy: `isToolVisible` (`agent-profile/ToolFilter.ts`) — deny
  wins over allow; an exact allowlist entry promotes a `discoverable` tool
  (plan 496); `hidden` is never promotable.
- MCP tier: `[tools] exposure = "full" \| "hint" \| "search"` in
  `config.toml` maps to `always` / `hint` / `discoverable`
  (`config/tool-exposure.ts`); default `hint`, legacy `catalog` normalizes
  to `hint`.
- Guard: a model call to a name not declared on the request's tools array
  is always rejected (`tool/visibility-guard.ts`), pointing the model at
  `tool_search` → `tool_schema` → `tool_invoke`. Compaction may promote the
  discovered set into the array at runtime (`discoveredPromotedToToolList`)
  — the sole array-merge path after the config-driven `array` delivery was
  retired.

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
- **Robustness**: tool-call sanitize/validate (orphan ToolResult stripping, `historySanitize.ts`), degenerate-summary detection (<500 chars retry, `summaryGuard.ts`), `classifySuppressReason` failure classification feeding the 3-scope `Suppression` (size: sticky on budget change; auth: 5-min window, plan 552; other: turn-scoped), input ladder (Verbatim → Fitted → Lossy), wall-clock budget, dedicated `compact_model`, memory flush.
- **Storage**: append-only `CompactionEntry` (Plan 315) + rollout JSONL full retention (Plan 441). Original history is always recoverable from rollouts, so no separate segment/transcript store (won't-fix decision, plan 422 P3.4).

### Compaction Consolidation (Plan 552)

Convergence pass over the eight incrementally-stacked compaction plans (422 → 495 → 517 → 523 → 475 → 315 → 441 → 486), audited against minimax-code v2's single-path design:

- **Dead code removed**: the grok 5-state `CompactSuppression` machine (`compactErrors.ts`, zero production call sites), `adjustSliceBoundary` (imported, never called), `CompactionStore`, and the `SessionManager`/`SessionStoreManager` pair. Failure classification is single-sourced in `classifySuppressReason` (the live 3-scope `Suppression` inside `CompactionManager` is the only machine; plan 523 should extend it, not revive the deleted one). `auth` suppression is time-windowed (5 min) and self-heals — the previous `onAuthRefresh()` clear trigger had no callers, so one 401 permanently disabled proactive compaction.
- **Single token estimator + single window resolver**: all ad-hoc char divisors (`len/4`, `CHARS_PER_TOKEN = 3/4` copies in hooks/memory-rollout/session, a verbatim CJK-heuristic copy in `DuyaAgent`) now route through `@duya/ai`'s `estimateContextTextTokens` (plan 443 canonical); reverse (tokens→chars) budgets import the exported `CJK_CHARS_PER_TOKEN` / `ASCII_CHARS_PER_TOKEN`. Context-window resolution exists once in `@duya/ai` `resolveContextWindow` — the agent budget (`compact/contextWindow.ts` re-export) and the renderer ring (`useContextUsage.ts`) share one precedence chain (capability → catalog → 200K), closing the plan 517 R1 drift class.
- **Single trigger probe**: `CompactionManager.probeCompaction()` measures tokens, image count and both decision lines (`getTriggerLine` = max − reserve; `getHardLimit` = full window) from the manager's budget. The pre-turn proactive checkpoint (`CompactionCoordinator.runPreTurn`) and the mid-loop preflight overflow (`DuyaAgent`) both consume the probe — the mid-loop no longer compares against a local `contextWindow` copy that could drift from the budget. Suppression/cooldown gating stays with the callers; the image trigger keeps bypassing both (grok semantics).
- **Single reinjection channel**: `PostCompactReinjector.reinject` returns `systemSegments` instead of splicing system-role messages into the result array; the controller reads `result.reinjection.systemMessages` directly (no fragile re-scan of result messages). Producers (reinjector segments, `legacy_system` capture, bot `postSummarySections`) write into `CompactionEntry.reinjectedSystemMessages`; `extractLegacySystemSegments` is the sole reader at the model boundary. Over-threshold loop-brake accounting adds the restored segments' token cost back so totals match the pre-552 layout.
- **Summarizer input hygiene**: `SessionMemoryCompactStrategy.stripImagesFromMessages` was a no-op (images silently rode into the summarizer); image blocks are now replaced with a text note (mcode `[image]` flattening).

### Compaction Loop Brake + Capability Audit (Plan 517)

Three surgical fixes layered on top of the Plan 422 / Plan 495 stack after a user-reported compaction-loop bug in 2026-09-10:

- **Capability resolution audit log** (`electron/services/providers/provider-store.ts:resolveRuntimeCapability`): the silent `DEFAULT_CONTEXT_WINDOW = 200_000` fallback (`packages/agent/src/compact/types.ts`) was hidden from users on 1M-context models whose id is not in `allProviderModels` (custom OpenRouter-style ids, third-party relays). Each call now emits an info-level audit line with `{ providerId, modelId, contextWindow, source: 'config' | 'db' | 'preset' }` on the three success branches and a warn-level line with `{ providerId, modelId, apiFormat }` plus a concrete pointer to `[options].model_context[modelId]` in `config.toml` when all three layers miss. `DuyaAgent`'s constructor mirrors the same warn with `{ runtimeConfigHasCapabilities, model, apiFormat }`. Users can `grep 'fallback to 200000' app.log` and recover in one step. Override priority: `config.options.model_context[modelId]` > DB row > built-in `allProviderModels`.
- **Turn-based + token-based cooldown** (`packages/agent/src/agent/DuyaAgent.ts:1594`, gates `imageTriggered || compactionController.shouldCompact()`): the proactive checkpoint now skips when `turnsSinceLastCompact < MIN_TURNS_SINCE_COMPACT (3)` OR `tokensGrowthSinceCompact < MIN_TOKENS_GROWTH_SINCE_COMPACT (30_000)`. Cooldown baseline pins on every successful proactive compaction via the new `lastCompactionTurn` and `lastCompactionObservedTokens` instance fields. The Pi/grok-style design lets the agent run at least three tool-use turns after each compaction; image-volume triggers (`compact/imageParts.ts`, Plan 495) bypass the gate so multimodal floods are still handled immediately.
- **`overThresholdAfterCompact` becomes an active loop brake** (`packages/agent/src/compact/CompactionManager.ts:compact`): the flag that Plan 422 computed but never consumed is now wired. When `overThresholdAfterCompact === true` (e.g. system prompt + reinject overshoot), `suppression.trySuppress('size')` fires and a new `compaction_over_threshold` event emits with `{ tokensRetained, available }`. The next `shouldCompact()` returns false at the existing suppression gate until a future successful compaction shrinks `finalTokens` below `available` — breaking the loop where Plan 422 ran every other turn because the post-compaction context kept re-crossing the threshold. `Suppression.trySuppress(type): boolean` (idempotent) lives on the 3-state `Suppression` machine inside `CompactionManager`; the former 5-state `CompactSuppression` API in `compactErrors.ts` was deleted in plan 552 (zero production call sites).
- **Per-step lifecycle events** (`packages/agent/src/compact/CompactionManager.ts` + `packages/agent/src/process/worker-protocol.ts` + `src/lib/stream-session-manager.ts` + `src/stores/compaction-store.ts`): a new `compaction_step` event (`projecting | cutting | summarizing | rebuilding | reinjecting | trimming`, `started | finished`) plus `compaction_over_threshold` flow as `compact:step` and `compact:over_threshold` SSE frames. The renderer mirrors them into the `compaction-store` (`CompactionPhase` union extended) and into the inline `CompactSummary` row, replacing the legacy single-spinner `'Compacting context...'` with `Summarizing 32 messages...`, `Re-injecting files, skills and tools (6 cached)...`, `Trimming — still over budget`, etc. i18n keys live in `src/i18n/en.ts` / `src/i18n/zh.ts` under `streaming.toolAction.compact.step.{phase}`. `ActionRowChrome` accepts a `verbText?: string` precedence over `verbKey` for callers that need interpolation variables. `@duya/ai`'s `SSEEvent` union gained the four `compact:*` frame types so the legacy `as unknown as SSEEvent` casts in `DuyaAgent.ts` could finally be removed at a future cleanup.

### Long-Session Parity Additions (Plan 495)

Grok-parity gap closure on top of Plan 422, from the 2026-09-05 grok-bot compaction/epoch study:

- **Background prefire** (`compact/BackgroundPrefire.ts` + `CompactionManager.maybeStartPrefire`): when usage crosses 75% of the compaction threshold a passive pass1 summarization runs best-effort; `MessageCompactionController.compactProactive` consumes the completed pass as the `previousSummary` seed (grok two-pass semantics). Validity is a message-id prefix fingerprint — append-only growth keeps it valid; a rewrite (mid-pass compaction) discards the result as prefix-invalid. Kickoff happens at DuyaAgent's per-turn proactive checkpoint; failures never block the turn.
- **Image-parts trigger** (`compact/imageParts.ts`, `IMAGE_COMPACTION_TRIGGER_COUNT = 85`, grok parity): counted at the turn-start checkpoint and the mid-loop preflight-overflow checkpoint; firing forces compaction via `CompactOptions.force` even under the token budget (screenshot-heavy runs degrade attention before the budget does).
- **Summary retry ladder** (`compact/summaryRetry.ts`): up to 3 attempts; output-length errors get a one-shot shorter-output instruction; input-length errors shrink the summarized range (tool traffic drops first, `TOOL_MESSAGE_DROP_THRESHOLD = 0.25`, grok `reduceSelfSummaryInputMessages` parity); fatal errors throw immediately; empty/degenerate exhaustion returns '' so the strategy's placeholder path keeps the compaction successful.
- **Wake preemption / redrive / tail guard** (`electron/wake/wake-dispatcher.ts`, 476 §2.2 close-out): a preempting wake (user message / priority DM) interrupts a dispatcher-owned in-flight run at enqueue time (`interruptRun` dep, best-effort `DELETE /sessions/:id/chat`); the displaced item re-queues as `isRedriven` (exempt from the epoch-stale skip and the recently-dispatched dedupe) and runs after the preempting turn. A run whose epoch advanced mid-flight has its user-facing tail side-effects (DM auto-return) suppressed — grok turn-runtime parity. Dispatching a user-lane wake does not advance the epoch (existing 476/477 contract).

### Compact Lazy-Spawn Handshake (Plan 508)

Bot sessions whose worker has been idle-reaped and is being lazy-spawned by `POST /sessions/:id/compact` previously hit a misleading `Agent not initialized` error: the router's ready handshake only filtered on event type, never on `ready.status`, so a worker that emitted `ready { status: 'error' }` (e.g. bot session missing `provider_id`) was treated as ready and the subsequent `compact` command ran against a worker whose `initAgent` had thrown. Plan 508 fixes this:

- **`waitForWorkerReady(child, timeoutMs)`** (`electron/agents/server/router.ts`): typed `WorkerReadyOutcome` distinguishing `status: 'error'` (HTTP 503 + worker error verbatim), `status: 'deferred'` (HTTP 409), and timeout (HTTP 504). Extracted from `lazySpawnWorkerForCompact` so the contract is unit-testable.
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

### Stability Layers (Plan 501)

- **Frozen-prompt discipline** (`packages/agent/src/prompts/bot/`): bot sections split into stable (identity/roster/promptConfig — content-hash keyed) and `volatile` (memory×3 / automations / channels / spotlight — keyed on the compaction epoch ALONE). Mid-epoch memory writes no longer invalidate any section render; volatile data refreshes at the next compaction boundary (grok `resolveFrozenMemoryPrompt` parity). Identity changes mid-epoch stay covered by the profileUpdate envelope.
- **Compaction → rotation trigger** (`electron/db/core/message-log.ts`): `appendBatch` rotating a bot session's rollout file whenever a compaction payload lands (plan 493 Phase B now actually fires) — each compaction bumps `chat_sessions.generation` and the compacted summary becomes the first data entry of the fresh generation, so the agent-side `countTimelineCompactions` (summaryEpoch) and the storage generation stay aligned. Rotation failure is fail-open (append proceeds).
- **Delivery counting** (`packages/agent/src/hooks/send-message-reminder.ts`): `post_to_room` counts as a delivery alongside `SendMessage`, so the mechanical delivery-owed backstops read a room turn that already spoke as delivered.

### Bot Identity & Avatar (Plans 483/485, 481 amendment)

A bot's runtime identity lives in `<duyaRoot>/agents/<id>/profile.json` (`electron/config/bot-profile.ts`): `name` / `description` (model-updatable via `update_state`), `title` (host-managed only), `avatarColor` (color token for the initial-circle avatar) and `avatarImage` (filename of an image inside the agent dir). `config.toml [agents.<id>]` name/description only seed the profile on first creation and act as fallback (485 §2.4). Avatars were (shape, color) tokens until 2026-09-05 — shape tokens are removed; legacy files' `avatarShape` is ignored on read.

Plan 502: `title` is fully wired for the host side — create/edit dialogs and `BotSettingsPanel` expose a role-title input, creation seeds it via `AgentUpsertInput.title` → `seedBotProfileIfMissing`, and the sidebar renders it as the contact subtitle (`BotContactListItem`: `title || description`). The model still cannot set it. Bot ids are minted at a SINGLE point in the main process (grok `agent-session.ts` parity: ids are never user-authored): `config:agents:create` accepts an empty id and slugs it from the display name via `slugifyBotIdFromName`, then `allocateBotId` allocates a collision-free id against config keys, on-disk trees, and `.deleted` tombstones; the old renderer-side `deriveBotIdFromName` duplicate is removed. Ids stay readable slugs (unlike grok's opaque uuids) because they double as config keys and `send_to_agent` addresses.

Avatar rendering priority (`src/components/layout/sidebar/BotCharacterAvatar.tsx`): image → colored initial circle → deterministic-hue fallback. The image is served to the renderer over the `duya-file://` protocol (`electron/main.ts`); `listBots()` pre-builds the URL with a `?v=<mtime>` cache-buster, so the renderer never handles raw paths.

Write paths, all converging on profile.json:

- **UI edit** (`EditBotDialog` / `BotSettingsPanel`, shared `useBotContactForm`): identity via `config:agents:updateBotProfile` → `updateBotProfileIdentity`; avatar image upload via `config:agents:uploadBotAvatar` (file dialog + copy in the main process) and `config:agents:clearBotAvatarImage`.
- **Model self-edit** (`update_state` profile.set / avatar.set / avatar.clear): routed through the `bot-identity:rpc` channel (agent subprocess → agent-server-lifecycle → `electron/config/bot-identity-rpc.ts`), which binds the subaction to the session's `bot:<agentId>` identity (a bot can only edit its own profile), validates color tokens and image sources, and calls the same identity writers. `avatar.set` accepts `avatarColor` and/or `avatarImagePath` (e.g. the model's own `image_generate` output; validated extension whitelist + 5 MB cap + magic bytes, then copied to `agents/<id>/avatar.<ext>` by `setBotAvatarImage`).

### Shared Agents Root (Plan 526)

The ENTIRE `agents/<agentId>/` tree — identity (profile.json, settings.json,
avatar), sessions, memory shards, skills AND the channels subsystem
(`channels/<platform>/connection.json`, `connector-secrets/<platform>.json`,
`gateway/weixin/` state, `attachments/inbound/`) — lives under the shared
`<duyaRoot>/agents` root (`~/.duya/agents`), resolved via
`getSharedAgentsRoot()` (`electron/config/agent-paths.ts` →
`ConfigStore.getConfigDir()`). This is what makes a bot fully portable
across dev and packaged installs: previously channel bindings lived under
`<userData>/agents/`, which is namespaced per install mode (`duya-dev` vs
packaged), so a packaged app could never see bindings configured in dev.
The worker already read `connection.json` from the shared root
(`packages/agent/src/prompts/bot/loader.ts`), so main and worker now agree.
At boot, `electron/channels/legacy-root-migration.ts` merges any remaining
`<userData>/agents/*` channel data into the shared root (per-file,
target-exists wins, source kept). Soft delete/hard delete of a bot moves or
removes the whole directory, so credentials are purged with the bot.

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
