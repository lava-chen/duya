# @duya/agent Architecture

## 1. Overview

**Package**: `@duya/agent`
**Purpose**: AI Agent framework providing streaming chat, tool execution, permission management, session persistence, and multi-agent coordination.

**Architecture Philosophy**: Modular design separating LLM clients, tool execution, permissions, memory, and session concerns.

---

## 2. Directory Structure

```
packages/agent/src/
├── index.ts                    # Main entry: duyaAgent class
├── types.ts                    # Core type definitions
├── compact/                    # Message history compression
├── coordinator/                # Coordinator mode for multi-agent orchestration
├── hooks/                      # Event hook system for agent lifecycle
├── llm/                        # LLM client implementations
│   ├── index.ts               # Factory: createLLMClient, inferProvider
│   ├── base.ts                # LLMClient interface
│   ├── anthropic-client.ts    # Anthropic API implementation
│   └── openai-client.ts       # OpenAI-compatible API implementation
├── mcp/                        # Model Context Protocol client
├── memdir/                     # File-based persistent memory system
├── permissions/                # Permission checking and rule management
├── prompts/                     # Prompt engineering system
│   ├── index.ts              # Main exports
│   ├── PromptManager.ts      # System prompt orchestrator
│   ├── types.ts              # Prompt types
│   ├── cache.ts              # Prompt caching
│   ├── constants/            # Prompt section helpers
│   └── sections/             # Individual prompt sections
├── sandbox/                     # Sandbox execution for security
├── session/                     # SQLite-backed session persistence
├── swarm/                       # Team coordination utilities
└── tool/                        # Tool system
    ├── registry.ts             # Tool registry
    ├── builtin.ts             # Built-in tools registration
    ├── StreamingToolExecutor.ts # Concurrent tool execution
    ├── BashTool.ts            # Shell command execution
    ├── ReadTool.ts            # File reading
    ├── WriteTool.ts           # File writing
    ├── EditTool.ts            # File editing
    ├── GrepTool.ts            # Pattern search
    ├── GlobTool.ts            # File globbing
    ├── AgentTool/             # Sub-agent spawning tool
    └── [Task*Tool]/           # Task management tools
```

---

## 3. Core Types (`types.ts`)

### Message Types

```typescript
type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

interface Message {
  id: string
  role: MessageRole
  content: MessageContent
  timestamp: number
}

type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
```

### Tool Types

```typescript
interface Tool {
  name: string
  description: string
  input_schema: z.ZodSchema | Record<string, unknown>
}

interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResult {
  id: string
  name: string
  result: unknown
  error?: boolean
}
```

### SSE Event Types

```typescript
type SSEEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: ToolUse }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'tool_progress'; toolUseId: string; progress: string }
  | { type: 'tool_timeout'; toolUseId: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'done'; tokenUsage?: TokenUsage }
  | { type: 'error'; error: string }
  | { type: 'result'; tokenUsage: TokenUsage }
```

---

## 4. Main Entry Point (`index.ts`)

### duyaAgent Class

The central orchestrator for agent operations.

```typescript
class duyaAgent {
  constructor(options: AgentOptions)

  // Streaming chat - yields SSE events
  streamChat(prompt: string, options?: ChatOptions): AsyncGenerator<SSEEvent>

  // Control
  interrupt(): void

  // Message history
  getMessages(): Message[]
  clearMessages(): void

  // History compression
  compressHistory(options?: CompressOptions): Promise<void>
}
```

**Key Fields**:
- `llmClient: LLMClient` - Provider-specific LLM client
- `messages: Message[]` - Message history
- `promptManager: PromptManager` - System prompt builder
- `sessionInfo: SessionInfo` - Session metadata

---

## 5. LLM Client System (`llm/`)

### Interface

```typescript
interface LLMClient {
  streamChat(
    prompt: string,
    options?: {
      systemPrompt?: string
      tools?: Tool[]
      maxTokens?: number
      temperature?: number
    }
  ): AsyncGenerator<SSEEvent, void, unknown>
}
```

### Factory (`index.ts`)

- `createLLMClient(provider, options)` - Create Anthropic or OpenAI client
- `inferProvider(baseURL)` - Heuristic provider detection

### AnthropicClient

Wraps `@anthropic-ai/sdk`:
- Streams via `client.messages.stream()`
- Emits `tool_use`, `text`, `content_block_delta` events
- Reports token usage via `result` event
- Supports extended thinking via `thinking` events

### OpenAIClient

Wraps `openai` SDK for OpenAI-compatible APIs:
- Handles `tool_calls` delta streaming
- Accumulates function arguments incrementally

---

## 6. Tool System (`tool/`)

### ToolRegistry (`registry.ts`)

Central tool registration and lookup.

```typescript
class ToolRegistry {
  register(definition: Tool, executor: ToolExecutor): void
  execute(name: string, input, workingDirectory?): Promise<ToolResult | null>
  getTool(name): Tool | undefined
  getAllTools(): Tool[]
  has(name): boolean
}

interface ToolExecutor {
  execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult>
}
```

### StreamingToolExecutor (`StreamingToolExecutor.ts`)

Manages concurrent tool execution with queue-based scheduling.

**Concurrency Rules**:
| Tool Type | Behavior |
|-----------|----------|
| Safe tools (read, write, edit, grep, glob, task_*, web_*, etc.) | Can run in parallel |
| Unsafe tools (bash) | Run alone; errors cancel siblings |

**Key Methods**:
- `addTool(block)` - Queue a tool for execution
- `processQueue()` - Start tools when concurrency allows
- `getRemainingResults()` - Async generator yielding results
- `discard()` - Abandon all pending tools

**Concurrency-Safe Tools**:
```typescript
const CONCURRENCY_SAFE_TOOLS = new Set([
  'read', 'write', 'edit', 'grep', 'glob',
  'task_get', 'task_list', 'task_output', 'task_stop', 'task_update',
  'enter_worktree', 'exit_worktree',
  'enter_plan_mode', 'exit_plan_mode',
  'list_mcp_resources', 'read_mcp_resource',
  'web_search', 'web_fetch',
  'lsp', 'repl', 'skill', 'brief', 'config',
  'team_create', 'team_delete'
])
```

### Built-in Tools (`builtin.ts`)

Function `createBuiltinRegistry()` registers:

| Tool | Description |
|------|-------------|
| `Bash` | Shell command execution |
| `Read` | File reading with line ranges |
| `Write` | File writing with security checks |
| `Edit` | Diff-based file editing |
| `Grep` | Pattern search |
| `Glob` | File globbing |
| `Agent` | Spawn sub-agents |
| `task_*` | Task management |
| `enter/exit_worktree` | Git worktree management |
| `enter/exit_plan_mode` | Plan mode control |
| `list/read_mcp_resource` | MCP resource access |
| `web_search`, `web_fetch` | Web browsing |
| `team_create`, `team_delete` | Team management |

### BashTool Security (`BashTool.ts`)

**Dangerous Patterns Blocked**:
- `rm -rf /` or system directories
- `curl/wget | sh` (pipe to shell)
- `nc`, `nmap` (network scanning)
- `chmod 777`, `dd` to devices
- `kill -9 1` (kill init)
- `eval $(...)` (command injection)

**Read-only Commands**:
- Safe: `ls`, `pwd`, `cat`, `grep`, `git status`, `npm ls`
- Read-only git: `status`, `log`, `diff`, `show`, `branch`
- Read-only npm: `ls`, `pack`, `view`, `info`, `search`

### ReadTool Security (`ReadTool.ts`)

- UNC path blocking (`\\server\share`)
- `/proc` and `/sys` access blocking
- Path traversal detection
- Max 10,000 lines per read

### WriteTool Security (`WriteTool.ts`)

- Blocked paths: `/etc`, `/Windows`, `/System32`, `/Program Files`
- Path traversal detection
- UNC path blocking
- Max content size: 10MB

### AgentTool (`tool/AgentTool/`)

Spawn sub-agents for complex multi-step tasks.

**Built-in Agent Types**:
| Type | When to Use |
|------|-------------|
| `general-purpose` | Research, searching, multi-step tasks |
| `explore` | Codebase exploration |
| `plan` | Planning and spec creation |
| `verification` | Testing and verification |

---

## 7. Prompt System (`prompts/`)

### PromptManager (`PromptManager.ts`)

Builds system prompts from composable sections.

```typescript
class PromptManager {
  buildSystemPrompt(enabledTools?: Set<string>, mcpServers?: MCPServerConnection[]): string
  clearCache(): void
  getCache(): PromptCache
}
```

### Prompt Section Types

```typescript
interface PromptSection {
  name: string
  compute: () => string | null | Promise<string | null>
  volatile: boolean  // If true, recomputes every turn
}
```

### Section Categories

**Cached Sections** (static, reused across turns):
- `intro` - Introduction to duya
- `system` - System-level guidance
- `taskHandling` - Task management instructions
- `actions` - Action guidelines
- `toolUsage` - Tool usage guidance
- `toneAndStyle` - Tone and style guidelines
- `outputEfficiency` - Output optimization

**Volatile Sections** (recompute every turn):
- `environment` - Current directory, platform, shell
- `mcpInstructions` - MCP server instructions
- `sessionGuidance` - Session-specific guidance

### Dynamic Boundary

`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` separates cached and volatile sections, enabling intelligent caching.

---

## 8. MCP System (`mcp/`)

### MCPManager

Manages multiple MCP server connections.

```typescript
class MCPManager {
  connect(config: MCPServerConfig): Promise<void>
  disconnect(name: string): Promise<void>
  getAllTools(): Tool[]
  getAllToolExecutors(): Map<string, ToolExecutor>
  listServers(): string[]
}
```

### MCPToolAdapter

Adapts MCP tools to internal `Tool` interface.

---

## 9. Session System (`session/`)

SQLite-backed session persistence via `better-sqlite3`.

```typescript
class SessionManager {
  createSession(metadata?): string
  loadSession(sessionId): SessionData | null
  addMessage(message: Message): void
  getMessages(): Message[]
  clearMessages(): void
  estimateTokens(content: string): number
  compressHistory(): Promise<void>
}
```

**Database Path**: `.duya/duya.db` (dev), `%APPDATA%/duya/duya.db` (prod)

---

## 10. Permissions System (`permissions/`)

### Permission Modes

```typescript
type PermissionMode =
  | 'acceptEdits'    // Accept all edits
  | 'bypassPermissions' // Skip permission checks
  | 'default'        // Default behavior
  | 'dontAsk'        // Deny without prompting
  | 'plan'           // Plan mode
  | 'auto'           // Automatic permission checking
```

### Permission Check Flow

```
Tool Execution Request
    │
    ├─ Check deny rules ─────────► Deny if matched
    │
    ├─ Check ask rules ──────────► Return ask behavior
    │
    ├─ Check bypass mode ────────► Allow if bypass
    │
    ├─ Check always-allow rules ─► Allow if matched
    │
    ├─ Check dontAsk mode ───────► Deny if dontAsk
    │
    └─ Default ─────────────────► Ask for permission
```

### Bash Classifier (`bashClassifier.ts`)

Classifies bash commands for risk assessment:
- `isReadOnlyCommand()` - Detect read-only commands
- `isAutoModeAllowlistedTool()` - Check auto mode allowlist

### Denial Tracking (`denialTracking.ts`)

Prevents permission denial DoS:
- `DENIAL_LIMITS.maxTotal` - Maximum total denials
- `DENIAL_LIMITS.maxConsecutive` - Maximum consecutive denials

---

## 11. Memory System (`memdir/`)

File-based persistent memory system.

### Memory Types

| Type | Scope | Description |
|------|-------|-------------|
| `user` | private | User's role, goals, preferences |
| `feedback` | private/team | Guidance on approach (what to avoid/continue) |
| `project` | private/team | Ongoing work, goals, bugs, incidents |
| `reference` | team | Pointers to external systems |

### Memory Paths

```typescript
getMemoryBaseDir()     // ~/.duya
getAutoMemPath()       // ~/.duya/memory/
getAutoMemEntrypoint() // ~/.duya/memory/MEMORY.md
```

### Memory Management

- `MAX_ENTRYPOINT_LINES` = 200
- `MAX_ENTRYPOINT_BYTES` = 25,000
- MEMORY.md acts as index to all memories

---

## 12. Coordinator System (`coordinator/`)

Multi-agent orchestration mode.

```typescript
isCoordinatorMode()              // Check duya_COORDINATOR_MODE env var
getCoordinatorSystemPrompt()     // Get coordinator system prompt
getCoordinatorUserContext()       // Get worker tools context
```

**Coordinator Role**:
- Orchestrates software engineering tasks across workers
- Spawns agents via `Agent` tool
- Synthesizes results and communicates with user

---

## 13. Hooks System (`hooks/`)

Event hook system for agent lifecycle.

### Hook Events

| Event | Description |
|-------|-------------|
| `PreToolUse` | Before tool execution |
| `PostToolUse` | After tool success |
| `PostToolUseFailure` | After tool failure |
| `PermissionDenied` | Permission denied |
| `PermissionRequest` | Permission requested |
| `UserPromptSubmit` | User prompt submitted |
| `SessionStart` | Session started |
| `SubagentStart` | Subagent started |
| `CwdChanged` | Working directory changed |
| `FileChanged` | File changed |

### Hook Types

**Command Hooks**:
- `bash` - Bash command hook
- `http` - HTTP request hook
- `agent` - Agent verification hook

---

## 14. Swarm/Team System (`swarm/`)

Team coordination utilities.

```typescript
type TeamMember = {
  agentId: string
  name: string
  agentType?: string
  model?: string
  color?: string
  joinedAt: number
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  sessionId?: string
}
```

### Key Functions

- `sanitizeName(name)` - Sanitize for tmux/file paths
- `getTeamDir(teamName)` - Get team directory
- `readTeamFile(teamName)` - Read team config (sync)
- `writeTeamFileAsync(teamName, teamFile)` - Write team config

---

## 15. Sandbox System (`sandbox/`)

Sandboxed command execution with filesystem/network restrictions.

```typescript
class SandboxManager {
  execute(command: string, options?: SandboxOptions): Promise<SandboxResult>
}

setSandboxEnabled(enabled: boolean): void
addExcludedCommand(command: string): void
```

---

## 16. Data Flows

### Chat Streaming Flow

```
User Prompt
    │
    ▼
duyaAgent.streamChat()
    │
    ▼
PromptManager.buildSystemPrompt()
    │
    ▼
LLM Client (Anthropic/OpenAI)
    │
    ├───── text ────────────────────► Yield text event
    │
    ├───── tool_use ────────────────┐
    │                              │
    ▼                              ▼
StreamingToolExecutor          Yield tool_use event
    │
    ├───── tool_result ───────────► Yield tool result
    │
    └───── done ──────────────────► Yield done event
```

### Tool Execution Queue

```
addTool() called
    │
    ▼
isConcurrencySafeTool() check
    │
    ├── Safe ──► Execute immediately (parallel)
    │
    └── Unsafe ──► Wait for queue empty, then execute
    │
    ▼
Tool completes ──► getRemainingResults() yields
```

---

## 17. Package Exports

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./session": { "types": "./dist/session/index.d.ts", "default": "./dist/session/index.js" }
  },
  "bin": {
    "duya-agent": "./dist/cli/index.js"
  }
}
```

---

## 18. Key Interfaces Summary

### ToolExecutor
```typescript
interface ToolExecutor {
  execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult>
}
```

### ToolUseContext
```typescript
interface ToolUseContext {
  toolUseId: string
  getAppState: () => AppState
  setAppState: (fn: (prev: AppState) => AppState) => void
  abortController: AbortController
  options: ToolUseContextOptions
}
```

### AgentOptions
```typescript
interface AgentOptions {
  apiKey?: string
  authToken?: string
  baseURL?: string
  model: string
  provider?: 'anthropic' | 'openai' | 'openrouter'
  maxTokens?: number
  temperature?: number
}
```

---

## 19. Dependencies

**Production**:
- `@anthropic-ai/sdk` - Anthropic API client
- `@modelcontextprotocol/sdk` - MCP protocol
- `openai` - OpenAI API client
- `better-sqlite3` - SQLite for session persistence
- `execa` - Shell command execution
- `zod` - Schema validation
- `ws` - WebSocket support
- `chokidar` - File watching
