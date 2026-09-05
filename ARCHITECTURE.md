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
