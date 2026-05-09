# Multi-Agent System

> 更新时间：2026-04-09
> 
> **状态**：设计规格（未来功能）- 当前 DUYA 使用单 Agent 多进程架构

## 概述

DUYA 的 Multi-Agent 系统旨在提供一个开放的接口，让用户可以接入自己编写的、不同架构的、使用不同 memory 系统和上下文管理策略的 Agent。这些 Agent 可以通过 DUYA 的统一 UI 进行管理、调度和应用。

**当前架构说明**：
- DUYA 目前采用 **单 Agent 多进程** 架构（每个 Session 一个独立的 Agent Process）
- 所有 Session 共享相同的 `duyaAgent` 核心实现
- 通过 `AgentProcessPool` 管理并发和资源
- 本规格描述的是未来可能支持的 **多 Agent 类型** 架构（不同 Agent 实现共存）

### 设计目标

1. **开放性** - 任何符合接口规范的 Agent 都可以接入
2. **统一 UI** - 通过 duya 提供的统一界面管理所有 Agent
3. **可组合性** - Agent 之间可以协作、共享数据
4. **可发现性** - 支持 Agent 市场的安装和管理

### 核心挑战

1. Agent 接口标准化（包括统一的 AI Provider 传入方式）
2. Agent 的生命周期管理（注册、注销、调用）
3. Agent 市场机制
4. Agent 间的通信协议
5. Agent 间的数据共享

---

## 1. Agent 接口定义

### 1.1 核心接口

```typescript
// packages/agent/src/types/agent.ts

/**
 * Agent 运行时接口
 * 所有接入 DUYA 的 Agent 必须实现此接口
 */
export interface AgentRuntime {
  // ========== 标识属性 ==========

  /** Agent 唯一标识符 */
  readonly id: string;

  /** Agent 显示名称 */
  readonly name: string;

  /** Agent 版本 */
  readonly version: string;

  /** Agent 描述 */
  readonly description: string;

  /** Agent 所属类别 */
  readonly category: AgentCategory;

  /** Agent 能力标签 */
  readonly capabilities: string[];

  // ========== LLM 配置 ==========

  /** 默认 AI Provider */
  provider: LLMProvider;

  /** 默认模型 */
  model: string;

  /** API Key（可由用户在 UI 中配置） */
  apiKey?: string;

  /** 自定义 Base URL */
  baseURL?: string;

  /** 认证方式 */
  authStyle?: 'api_key' | 'auth_token';

  // ========== 生命周期方法 ==========

  /**
   * 初始化 Agent
   * @param context 初始化上下文
   */
  initialize(context: AgentContext): Promise<void>;

  /**
   * 销毁 Agent
   * 释放所有资源
   */
  shutdown(): Promise<void>;

  // ========== 对话方法 ==========

  /**
   * 流式对话
   * @param prompt 用户输入
   * @param options 对话选项
   * @yields SSE 事件
   */
  streamChat(
    prompt: string,
    options?: AgentChatOptions
  ): AsyncGenerator<AgentSSEEvent, void, unknown>;

  /**
   * 中断当前对话
   */
  interrupt(): void;

  // ========== 状态方法 ==========

  /**
   * 获取 Agent 状态
   */
  getStatus(): AgentStatus;

  /**
   * 获取消息历史
   */
  getMessages(): readonly Message[];

  /**
   * 清空消息历史
   */
  clearMessages(): void;

  // ========== 工具方法 ==========

  /**
   * 获取可用工具列表
   */
  getTools(): Tool[];

  /**
   * 注册工具
   */
  registerTool(tool: Tool): void;

  /**
   * 注销工具
   */
  unregisterTool(toolName: string): void;
}

/**
 * Agent 类别
 */
export type AgentCategory =
  | 'general'      // 通用助手
  | 'coding'        // 编程助手
  | 'research'      // 研究助手
  | 'creative'      // 创意助手
  | 'analysis'      // 分析助手
  | 'custom';       // 自定义

/**
 * Agent 状态
 */
export type AgentStatus =
  | 'idle'          // 空闲
  | 'busy'          // 工作中
  | 'error'          // 错误状态
  | 'unavailable';   // 不可用

/**
 * Agent 上下文（初始化时传入）
 */
export interface AgentContext {
  /** duya 根目录 */
  duyaRoot: string;

  /** 用户配置目录 */
  configDir: string;

  /** 数据目录 */
  dataDir: string;

  /** 工具注册表 */
  toolRegistry: ToolRegistry;

  /** 事件发射器（用于 Agent 间通信） */
  eventBus: EventBus;

  /** 日志记录器 */
  logger: Logger;

  /** AI Provider 解析器 */
  providerResolver: ProviderResolver;
}

/**
 * Agent 对话选项
 */
export interface AgentChatOptions {
  /** 系统提示词 */
  systemPrompt?: string;

  /** 消息历史（用于继续对话） */
  messages?: Message[];

  /** 工具列表 */
  tools?: Tool[];

  /** 工具注册表（优先级高于 tools） */
  toolRegistry?: ToolRegistry;

  /** 最大 token 数 */
  maxTokens?: number;

  /** 温度参数 */
  temperature?: number;

  /** 最大轮次 */
  maxTurns?: number;

  /** 中断信号 */
  abortSignal?: AbortSignal;
}

/**
 * Agent SSE 事件
 */
export type AgentSSEEvent =
  | { type: 'connected'; data: { agentId: string } }
  | { type: 'text'; data: string }
  | { type: 'tool_use'; data: ToolUse }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'tool_progress'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'tool_timeout'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'thinking'; data: string }
  | { type: 'done'; reason?: 'completed' | 'aborted' | 'max_turns' | 'error' }
  | { type: 'error'; data: string }
  | { type: 'result'; data: TokenUsage }
  | { type: 'turn_start'; data: { turnCount: number } }
  | { type: 'status'; data: { notification: boolean; message: string } }
  | { type: 'permission_request'; data: PermissionRequestEvent };
```

### 1.2 Provider 抽象

为了支持统一的 AI Provider 接入，定义 Provider 接口：

```typescript
// packages/agent/src/types/provider.ts

/**
 * AI Provider 配置
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: LLMProvider | 'custom';
  baseURL: string;
  apiKey?: string;
  authStyle: 'api_key' | 'auth_token';
  models?: string[];
  isDefault?: boolean;
}

/**
 * AI Provider 接口
 */
export interface AIProvider {
  readonly id: string;
  readonly type: LLMProvider | 'custom';
  readonly baseURL: string;

  createClient(config: ProviderConfig): LLMClient;

  listModels?(): Promise<string[]>;

  testConnection?(config: ProviderConfig): Promise<boolean>;
}

/**
 * Provider 解析器
 */
export interface ProviderResolver {
  resolve(providerId: string): AIProvider | null;

  resolveByURL(baseURL: string): AIProvider | null;

  getDefault(): AIProvider;

  listProviders(): ProviderConfig[];
}
```

### 1.3 内置 Agent 实现

duya 提供一个基于 `duyaAgent` 的内置 Agent 实现，作为参考：

```typescript
// packages/agent/src/agent/duya-agent-runtime.ts

export class duyaAgentRuntime implements AgentRuntime {
  readonly id = 'duya-builtin';
  readonly name = 'duya Assistant';
  readonly version = '1.0.0';
  readonly description = 'duya 内置通用助手';
  readonly category: AgentCategory = 'general';
  readonly capabilities = ['chat', 'tool-use', 'code-generation'];

  provider: LLMProvider = 'anthropic';
  model = 'claude-sonnet-4-20250514';
  apiKey?: string;
  baseURL?: string;
  authStyle?: 'api_key' | 'auth_token';

  private agent: duyaAgent | null = null;

  async initialize(context: AgentContext): Promise<void> {
    this.agent = new duyaAgent({
      apiKey: this.apiKey!,
      baseURL: this.baseURL,
      model: this.model,
      provider: this.provider,
      authStyle: this.authStyle,
    });
  }

  async shutdown(): Promise<void> {
    this.agent = null;
  }

  async *streamChat(
    prompt: string,
    options?: AgentChatOptions
  ): AsyncGenerator<AgentSSEEvent, void, unknown> {
    if (!this.agent) {
      throw new Error('Agent not initialized');
    }
    yield* this.agent.streamChat(prompt, options);
  }

  interrupt(): void {
    this.agent?.interrupt();
  }

  getStatus(): AgentStatus {
    return this.agent ? 'idle' : 'unavailable';
  }

  getMessages(): readonly Message[] {
    return this.agent?.getMessages() ?? [];
  }

  clearMessages(): void {
    this.agent?.clearMessages();
  }

  getTools(): Tool[] {
    return [];
  }

  registerTool(tool: Tool): void {
    // Not implemented for builtin agent
  }

  unregisterTool(toolName: string): void {
    // Not implemented for builtin agent
  }
}
```

---

## 2. Agent 管理

### 2.1 Agent 注册表

```typescript
// packages/agent/src/agent/registry.ts

/**
 * Agent 注册表
 * 负责管理所有已注册的 Agent
 */
export class AgentRegistry {
  private agents = new Map<string, AgentRuntime>();
  private metadata = new Map<string, AgentMetadata>();
  private activeAgentId: string | null = null;

  /**
   * 注册 Agent
   */
  register(agent: AgentRuntime, metadata?: AgentMetadata): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent ${agent.id} is already registered`);
    }
    this.agents.set(agent.id, agent);
    if (metadata) {
      this.metadata.set(agent.id, metadata);
    }
  }

  /**
   * 注销 Agent
   */
  async unregister(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    if (this.activeAgentId === agentId) {
      this.activeAgentId = null;
    }
    await agent.shutdown();
    this.agents.delete(agentId);
    this.metadata.delete(agentId);
  }

  /**
   * 获取 Agent
   */
  get(agentId: string): AgentRuntime | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 获取所有 Agent
   */
  list(): AgentRuntime[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取所有 Agent 元数据
   */
  listMetadata(): AgentMetadata[] {
    return Array.from(this.metadata.values());
  }

  /**
   * 按类别获取 Agent
   */
  listByCategory(category: AgentCategory): AgentRuntime[] {
    return this.list().filter(a => {
      const meta = this.metadata.get(a.id);
      return meta?.category === category;
    });
  }

  /**
   * 设置当前活跃 Agent
   */
  setActive(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent ${agentId} not found`);
    }
    this.activeAgentId = agentId;
  }

  /**
   * 获取当前活跃 Agent
   */
  getActive(): AgentRuntime | null {
    return this.activeAgentId ? this.agents.get(this.activeAgentId) ?? null : null;
  }

  /**
   * 检查 Agent 是否已注册
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }
}

/**
 * Agent 元数据
 */
export interface AgentMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  category: AgentCategory;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  icon?: string;
  source: AgentSource;
  baseDir?: string;
  dependencies?: Record<string, string>;
  configTemplate?: AgentConfigTemplate;
  createdAt: number;
  updatedAt: number;
}

/**
 * Agent 来源
 */
export type AgentSource =
  | 'builtin'      // 内置 Agent
  | 'local'        // 本地安装
  | 'marketplace'; // 市场安装

/**
 * Agent 配置模板
 */
export interface AgentConfigTemplate {
  fields: ConfigField[];
}

/**
 * 配置字段
 */
export interface ConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'password';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  placeholder?: string;
}
```

### 2.2 Agent 生命周期

```
                    ┌─────────────┐
                    │   LOADING   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
           ┌───────│ INITIALIZED │───────┐
           │       └─────────────┘       │
           │              │              │
           ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │  IDLE    │──▶│  BUSY    │   │  ERROR   │
    └──────────┘   └────┬─────┘   └──────────┘
           ▲           │              │
           │           ▼              │
           │     ┌──────────┐         │
           └─────│INTERRUPTED│─────────┘
                 └──────────┘

           │              │
           ▼              ▼
    ┌──────────┐   ┌──────────┐
    │ SHUTDOWN │   │ UNAVAIL  │
    └──────────┘   └──────────┘
```

**状态说明**：

| 状态 | 说明 |
| --- | --- |
| `LOADING` | 正在加载 Agent |
| `INITIALIZED` | 已初始化（初次注册后） |
| `IDLE` | 空闲，可接收请求 |
| `BUSY` | 正在处理请求 |
| `INTERRUPTED` | 被中断 |
| `ERROR` | 发生错误 |
| `SHUTDOWN` | 已关闭 |
| `UNAVAILABLE` | 不可用 |

---

## 3. Agent 市场

### 3.1 市场结构

```
Agent Marketplace
├── Registry Index     # 市场索引（远程 JSON）
├── Local Cache        # 本地缓存
└── Installation Dir   # 安装目录 (~/.duya/agents/)
```

### 3.2 市场索引格式

```typescript
// 市场索引条目
interface MarketplaceIndex {
  version: string;
  updatedAt: number;
  agents: MarketplaceEntry[];
}

interface MarketplaceEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  category: AgentCategory;
  author: {
    name: string;
    email?: string;
    homepage?: string;
  };
  repository?: string;
  license: string;
  tarball: string;       // 安装包 URL
  checksum: string;      // SHA256 校验
  dependencies: Record<string, string>;
  compatibility: {
    minduyaVersion: string;
    maxduyaVersion?: string;
  };
  metadata: {
    downloads: number;
    rating?: number;
    tags: string[];
  };
}
```

### 3.3 本地 Agent 存储

```
~/.duya/agents/
├── agent-1/
│   ├── agent.json      # Agent 元数据
│   ├── package.json    # npm 包配置
│   ├── src/            # 源代码
│   │   └── index.ts    # 入口文件
│   ├── dist/           # 编译输出
│   └── node_modules/   # 依赖
└── agent-2/
    └── ...
```

### 3.4 Agent 安装流程

```typescript
// 安装流程
async function installAgent(entry: MarketplaceEntry, installDir: string): Promise<void> {
  // 1. 下载 tarball
  const tarballPath = await downloadTarball(entry.tarball, entry.checksum);

  // 2. 解压到安装目录
  await extractTarball(tarballPath, installDir);

  // 3. 安装依赖
  await installDependencies(installDir);

  // 4. 验证安装
  await validateInstallation(installDir);

  // 5. 注册到本地
  await registerLocalAgent(installDir);
}
```

---

## 4. Agent 间通信

### 4.1 事件总线

duya 提供一个事件总线用于 Agent 间通信：

```typescript
// packages/agent/src/agent/event-bus.ts

/**
 * Agent 间事件
 */
export interface AgentEvent {
  /** 事件 ID */
  id: string;

  /** 事件类型 */
  type: string;

  /** 源 Agent ID */
  sourceAgentId: string;

  /** 目标 Agent ID（可选，空表示广播） */
  targetAgentId?: string;

  /** 事件负载 */
  payload: unknown;

  /** 时间戳 */
  timestamp: number;
}

/**
 * 事件订阅者
 */
type EventSubscriber = (event: AgentEvent) => void | Promise<void>;

/**
 * 事件总线
 */
export class EventBus {
  private subscribers = new Map<string, Set<EventSubscriber>>();

  /**
   * 发布事件
   */
  async publish(event: AgentEvent): Promise<void> {
    const typeSubscribers = this.subscribers.get(event.type);
    if (typeSubscribers) {
      await Promise.all(
        Array.from(typeSubscribers).map(sub => sub(event))
      );
    }

    // 广播到 all 类型订阅者
    const allSubscribers = this.subscribers.get('*');
    if (allSubscribers) {
      await Promise.all(
        Array.from(allSubscribers).map(sub => sub(event))
      );
    }
  }

  /**
   * 订阅事件
   * @param eventType 事件类型
   * @param callback 回调函数
   * @returns 取消订阅函数
   */
  subscribe(eventType: string, callback: EventSubscriber): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(callback);

    return () => {
      this.subscribers.get(eventType)?.delete(callback);
    };
  }
}
```

### 4.2 预定义事件类型

```typescript
// 预定义的 Agent 间事件类型
export const AgentEventTypes = {
  // 通用事件
  AGENT_REGISTERED: 'agent:registered',
  AGENT_UNREGISTERED: 'agent:unregistered',
  AGENT_STATUS_CHANGED: 'agent:status_changed',

  // 消息事件
  MESSAGE_SENT: 'message:sent',
  MESSAGE_RECEIVED: 'message:received',

  // 工具调用事件
  TOOL_CALLED: 'tool:called',
  TOOL_RESULT: 'tool:result',

  // 数据共享事件
  DATA_SHARED: 'data:shared',
  DATA_REQUEST: 'data:request',

  // 协作事件
  TASK_DELEGATED: 'task:delegated',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
} as const;
```

### 4.3 Agent 通信示例

```typescript
// Agent A 向 Agent B 发送消息
async function delegateTask(
  sourceAgent: AgentRuntime,
  targetAgentId: string,
  task: TaskPayload
): Promise<void> {
  const eventBus = getEventBus(); // 获取事件总线实例

  await eventBus.publish({
    id: crypto.randomUUID(),
    type: AgentEventTypes.TASK_DELEGATED,
    sourceAgentId: sourceAgent.id,
    targetAgentId,
    payload: task,
    timestamp: Date.now(),
  });
}

// Agent B 订阅任务委托事件
eventBus.subscribe(AgentEventTypes.TASK_DELEGATED, async (event) => {
  if (event.targetAgentId !== myAgentId) return;

  const task = event.payload as TaskPayload;
  const result = await executeTask(task);

  // 发送结果回去
  await eventBus.publish({
    id: crypto.randomUUID(),
    type: AgentEventTypes.TASK_COMPLETED,
    sourceAgentId: myAgentId,
    targetAgentId: event.sourceAgentId,
    payload: { taskId: task.id, result },
    timestamp: Date.now(),
  });
});
```

---

## 5. 数据共享

### 5.1 共享存储

DUYA 提供一个键值存储用于 Agent 间数据共享：

```typescript
// packages/agent/src/agent/shared-store.ts

/**
 * 共享数据存储
 * Agent 之间可以通过此存储共享数据
 */
export class SharedStore {
  private store = new Map<string, SharedDataEntry>();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * 设置数据
   */
  set(key: string, value: unknown, options?: SharedDataOptions): void {
    const entry: SharedDataEntry = {
      key,
      value,
      owner: options?.owner ?? 'system',
      visibility: options?.visibility ?? 'private',
      ttl: options?.ttl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.set(key, entry);

    // 发布数据变更事件
    this.eventBus.publish({
      id: crypto.randomUUID(),
      type: AgentEventTypes.DATA_SHARED,
      sourceAgentId: entry.owner,
      payload: { key, action: 'set', value },
      timestamp: Date.now(),
    });
  }

  /**
   * 获取数据
   */
  get(key: string): unknown | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // 检查 TTL
    if (entry.ttl && Date.now() - entry.createdAt > entry.ttl) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * 删除数据
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * 按前缀获取所有数据
   */
  getByPrefix(prefix: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        if (entry.ttl && Date.now() - entry.createdAt > entry.ttl) {
          this.store.delete(key);
        } else {
          result.set(key, entry.value);
        }
      }
    }
    return result;
  }

  /**
   * 列出所有可访问的键
   */
  listKeys(agentId?: string): string[] {
    const keys: string[] = [];
    for (const [key, entry] of this.store) {
      if (
        entry.visibility === 'public' ||
        entry.owner === agentId ||
        entry.visibility === 'protected'
      ) {
        keys.push(key);
      }
    }
    return keys;
  }
}

interface SharedDataEntry {
  key: string;
  value: unknown;
  owner: string;
  visibility: 'private' | 'protected' | 'public';
  ttl?: number;
  createdAt: number;
  updatedAt: number;
}

interface SharedDataOptions {
  owner?: string;
  visibility?: 'private' | 'protected' | 'public';
  ttl?: number;
}
```

### 5.2 上下文注入

除了显式的数据共享，Agent 之间还可以通过上下文注入传递信息：

```typescript
// 上下文注入机制
interface AgentContext {
  // ... 其他字段

  /** 共享上下文（可在 Agent 间传递） */
  sharedContext: Map<string, unknown>;

  /** 传递上下文给下一个 Agent */
  passContext?: (context: Map<string, unknown>) => void;
}

// 使用示例
async function agentA_task(agent: AgentRuntime) {
  const sharedContext = new Map<string, unknown>();
  sharedContext.set('taskId', '123');
  sharedContext.set('userId', '456');

  // 将上下文传递给工具调用
  const toolResult = await agent.callTool('delegate', {
    targetAgent: 'agent-b',
    context: Object.fromEntries(sharedContext),
  });
}
```

---

## 6. 数据库扩展

为支持 Multi-Agent 系统，扩展数据库表结构：

```sql
-- Agent 元数据表
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  source TEXT NOT NULL,  -- builtin/local/marketplace
  base_dir TEXT,
  config TEXT,           -- JSON 配置
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agent 会话表
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT,
  model TEXT,
  system_prompt TEXT,
  working_directory TEXT,
  status TEXT DEFAULT 'idle',
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Agent 消息表
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_usage INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);

-- Agent 关系表（用于记录 Agent 间的协作关系）
CREATE TABLE agent_relationships (
  id TEXT PRIMARY KEY,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,  -- delegated/collaborated/shared
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_agent_id) REFERENCES agents(id),
  FOREIGN KEY (target_agent_id) REFERENCES agents(id)
);

-- 共享数据表
CREATE TABLE shared_data (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON
  owner TEXT NOT NULL,
  visibility TEXT DEFAULT 'private',
  ttl INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_shared_data_owner ON shared_data(owner);
CREATE INDEX idx_shared_data_visibility ON shared_data(visibility);
```

---

## 7. API 设计

### 7.1 Agent API (HTTP - 未来设计)

> **注意**：当前 DUYA 使用 IPC + MessagePort 通信，而非 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/agents | 获取所有已注册 Agent |
| POST | /api/agents | 注册新 Agent |
| GET | /api/agents/:id | 获取单个 Agent |
| PATCH | /api/agents/:id | 更新 Agent |
| DELETE | /api/agents/:id | 注销 Agent |
| POST | /api/agents/:id/initialize | 初始化 Agent |
| POST | /api/agents/:id/shutdown | 关闭 Agent |
| GET | /api/agents/:id/status | 获取 Agent 状态 |
| POST | /api/agents/:id/chat | 与 Agent 对话 |
| GET | /api/agents/:id/messages | 获取消息历史 |

### 7.2 Agent 市场 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/marketplace | 获取市场索引 |
| GET | /api/marketplace/:id | 获取 Agent 详情 |
| POST | /api/marketplace/:id/install | 安装 Agent |
| DELETE | /api/marketplace/:id | 卸载 Agent |
| GET | /api/marketplace/categories | 获取分类列表 |

### 7.3 共享数据 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/shared | 获取所有可访问的共享数据 |
| GET | /api/shared/:key | 获取指定数据 |
| POST | /api/shared | 创建共享数据 |
| PUT | /api/shared/:key | 更新共享数据 |
| DELETE | /api/shared/:key | 删除共享数据 |

---

## 8. 实现计划

### Phase 1: 核心接口 (MVP)
- [ ] 定义 `AgentRuntime` 接口
- [ ] 实现 `AgentRegistry`
- [ ] 将现有 `duyaAgent` 适配为 `AgentRuntime` 实现
- [ ] 基础 UI（Agent 切换）

### Phase 2: Agent 市场
- [ ] 市场索引解析
- [ ] Agent 安装/卸载流程
- [ ] 市场 UI

### Phase 3: Agent 通信
- [ ] 实现 `EventBus`
- [ ] 实现 `SharedStore`
- [ ] Agent 协作 UI

### Phase 4: 高级功能
- [ ] Agent 组合工作流
- [ ] 分布式 Agent 支持
- [ ] 性能监控

---

## 9. 参考实现

- [Agent 核心包](../packages/agent/src/) - 现有 duyaAgent 实现
- [Tool 系统](../packages/agent/src/tool/) - 可复用的工具注册机制
- [Session 管理](../packages/agent/src/session/) - 会话生命周期参考
- [Skill 系统](../packages/agent/src/skills/) - 插件化机制参考

---

## 10. 附录

### A. 类型速查

```typescript
// 核心类型
AgentRuntime          // Agent 运行时接口
AgentRegistry         // Agent 注册表
AgentMetadata         // Agent 元数据
AgentStatus           // Agent 状态枚举
AgentCategory         // Agent 类别
AgentContext          // 初始化上下文
AgentChatOptions      // 对话选项
AgentSSEEvent         // SSE 事件类型

// Provider 类型
ProviderConfig        // Provider 配置
AIProvider            // Provider 接口
ProviderResolver      // Provider 解析器

// 通信类型
EventBus              // 事件总线
AgentEvent            // Agent 事件
SharedStore           // 共享存储

// 数据库类型
AgentSession          // Agent 会话
AgentMessage          // Agent 消息
SharedData            // 共享数据
```

### B. 配置示例

```json
// ~/.duya/agents/coding-agent/agent.json
{
  "id": "coding-agent",
  "name": "Coding Agent",
  "version": "1.0.0",
  "description": "Specialized agent for code generation and review",
  "category": "coding",
  "author": {
    "name": "Developer",
    "email": "dev@example.com"
  },
  "repository": "https://github.com/user/coding-agent",
  "license": "MIT",
  "compatibility": {
    "minduyaVersion": "1.0.0"
  },
  "configTemplate": {
    "fields": [
      {
        "name": "defaultModel",
        "type": "select",
        "label": "Default Model",
        "required": true,
        "options": [
          { "value": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4" },
          { "value": "claude-opus-4-20250514", "label": "Claude Opus 4" }
        ]
      },
      {
        "name": "maxTokens",
        "type": "number",
        "label": "Max Tokens",
        "default": 4096
      }
    ]
  }
}
```
