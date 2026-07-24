# DUYA 架构文档

> 更新时间：2026-05-11（修正技术栈：移除不存在的 Zero Router，更新安全扫描器描述、BashClassifier 为 stub 实现、Gateway 组件名称）
>
> 历史更新：2026-04-24（新增安全扫描系统与提示词系统工程文档）
>
> 历史更新：2026-04-18（Golden Trident 数据架构重构：物理分离、单一职责、原子防御）

DUYA 是一个基于 Electron + Vite 的 AI Agent 客户端应用，采用 **Multi-Agent Process + SQLite 单点写入 + MessagePort 直连**架构。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面外壳 | Electron 28 |
| 前端框架 | Vite 6 + React 19（条件渲染，无 router 库）|
| Agent 核心 | `@duya/agent` + `@anthropic-ai/sdk` |
| 状态管理 | Zustand + SQLite (better-sqlite3) |
| 样式 | Tailwind CSS 4 |
| 构建工具 | esbuild (Electron) + Vite (Frontend) |
| 测试 | Vitest + Playwright |
| 定时任务 | croner |
| 更新 | electron-updater |

## 核心架构

### 当前架构：Multi-Agent Process + Main 总控

DUYA 采用 **Multi-Agent Process** 模式，每个 Agent 运行在独立的 **Child Process** 中：

- **进程隔离**：每个 Agent 实例运行在独立进程中，崩溃互不影响，LLM 调用和工具执行完全隔离
- **Resource Governor**：Main Process 中的 Resource Governor 限制并发 Agent 数量（CPU核数/2），防止 CPU/内存打爆
- **SQLite 单例写入**：数据库只在 Main 进程中操作，WAL 模式支持读写并发
- **消息先落库后转发**：Agent 发出的每条消息先通过 IPC 落库（SQLite-backed 队列），再转发给 Renderer，断线重连后可回放
- **Process Pool**：Main 维护进程池（spawn/kill），心跳监控检测僵尸进程并清理

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Main Process（总控层）               │
│                                                                  │
│  ┌──────────────────────────┐  ┌────────────────────────────┐   │
│  │    SQLite 数据库          │  │    Resource Governor       │   │
│  │    唯一写入方             │  │    并发 Agent 上限（CPU/2） │   │
│  │    WAL 模式               │  │    心跳监控（杀僵尸进程）   │   │
│  └───────────┬──────────────┘  └────────────────────────────┘   │
│              │                                                   │
│  ┌───────────┴──────────────────────────────────────────────┐   │
│  │        持久化消息队列 (SQLite-backed)                      │   │
│  │  Agent 发出的每条消息先落库，再转发给 Renderer             │   │
│  └───────────┬──────────────────────────────────────────────┘   │
└──────────────┼──────────────────────┬───────────────────────────┘
               │ child_process IPC    │ ipcRenderer
               ▼                      ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  Agent Process A    │  │  Agent Process B    │  │  Agent Process C    │
│  Session A          │  │  Session B          │  │  (排队等待)         │
│  LLM调用/工具执行   │  │  LLM调用/工具执行   │  │  等待 Resource       │
│  sub-agents         │  │  sub-agents         │  │  Governor 释放槽位  │
│  ⚙ TokenBucket     │  │  ⚙ TokenBucket     │  │  ⚙ TokenBucket     │
│  (进程内工具限速)   │  │  (进程内工具限速)   │  │  (进程内工具限速)   │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### 核心组件分工

| 组件 | 职责 | 文件 |
|------|------|------|
| **Main Process** | SQLite 单例（唯一写入方）、持久化消息队列、会话管理、配置管理、生命周期协调 | `electron/main.ts` |
| **BootConfig** | 引导配置（指南针），管理 boot.json 中的数据库路径 | `electron/boot-config.ts` |
| **AgentProcessPool** | 并发 Agent 上限（CPU核数/2）、spawn/kill 管理、心跳监控（杀僵尸进程）、排队队列、每条消息落库 | `electron/agent-process-pool.ts` |
| **Session Manager** | Session 状态跟踪与会话生命周期管理 | `electron/session-manager.ts` |
| **Channel Manager** | MessagePort 通道管理（用于持久化连接）；invoke 通道用于主动查询（session 列表、历史加载）。注意：MessagePort 不可重连（窗口关闭即端口销毁） | `electron/message-port-manager.ts` |
| **Config Manager** | 加密配置存储、权限控制、实时广播 | `electron/config-manager.ts` |
| **DB Handlers** | 数据库 IPC 处理器、Schema 管理、迁移、Safe Mode | `electron/db-handlers.ts` |
| **Agent Communicator** | Agent IPC 处理器、DB 请求分发 | `electron/ipc/agent-communicator.ts` |
| **Gateway Communicator** | Gateway/Bridge 进程管理、IPC 转发 | `electron/ipc/gateway-communicator.ts` |
| **Performance Monitor** | 性能指标采集、Prometheus 导出 | `electron/performance-monitor.ts` |
| **Automation Scheduler** | 定时任务调度、Cron 管理、执行历史 | `electron/automation/Scheduler.ts` |
| **Logger** | 结构化日志、文件轮转、日志级别管理 | `electron/logger.ts` |
| **Updater** | 自动更新检查、下载、安装 | `electron/updater.ts` |
| **Browser Daemon** | 浏览器扩展守护进程管理 | `electron/browser-daemon.ts` |
| **Agent Process** | 运行 duyaAgent 实例、LLM 调用、工具执行、**TokenBucket 工具限速**（进程内自管理）、sub-agents 管理、沙箱约束 | `packages/agent/src/process/` |
| **Renderer** | React UI（session tabs）、只读订阅状态，不直接操作数据库 | `src/` |

### 消息流

#### 标准 Agent 会话流

```
1. Renderer 发送 chat:start
   └─ MessagePort → Main Process

2. Main 通过 Resource Governor 检查并发限制
   └─ 有槽位：spawn Agent Process
   └─ 无槽位：进入排队队列，等待释放

3. Agent Process 启动 streamChat
   └─ 用户消息通过 IPC 发给 Main → Main 落库（message:add）

4. Agent 流式输出（每条消息先落库再转发）
   └─ Agent Process → Main（child_process IPC）
   └─ Main 落库（SQLite-backed 队列）→ 推 Renderer（MessagePort）
   └─ 断线重连后可从队列回放

5. 工具调用结果同样先落库再转发
   └─ tool_result/tool_progress → Main → DB → Renderer

6. 切换 session 时，Renderer 从 SQLite 读消息历史
   └─ ipcRenderer.invoke('db:message:getBySession', sessionId)
   └─ 即使 Agent 已崩溃或仍在运行，历史消息完整可用

7. 权限请求：Main 转发给 Renderer → 用户决策 → 发回 Agent
```

#### Gateway/Bridge 外部消息流

```
外部平台（Telegram/微信等）
         │
         ▼
┌─────────────────┐
│  Gateway Process │ 独立进程，管理外部平台连接
│  (gateway-communicator.ts)
└────────┬────────┘
         │ MessagePort
         ▼
┌─────────────────┐
│   Main Process   │ 转发到对应 Session
│  (查找或创建 Session)
└────────┬────────┘
         │ child_process IPC
         ▼
┌─────────────────┐
│  Agent Process   │ 处理消息，生成回复
└────────┬────────┘
         │
         ▼
    回复原路返回给外部平台
```

#### Gateway Agent runtime contract

- Gateway sessions use `agentProfileId: 'gateway'` and fixed
  `permission_profile='default'`; an inbound turn repairs legacy rows that still
  contain another permission profile.
- The configured `bridge_workspace` is prepared before use and defaults to
  `~/.duya/workspace`. `electron/gateway/message-bus.ts` passes it as the
  Agent Server request's top-level `workingDirectory` and
  `defaultWorkspaceDirectory`; placing it only under `options` does not
  initialize the worker cwd.
- The Gateway profile can use read/search plus Bash/PowerShell. Read-only shell
  commands execute directly, while the shell security classifier retains
  confirmation requirements for risky commands.
- Desktop-only, recursive-agent, mode/worktree, and the incomplete file-backed
  `TeamCreate` / `TeamDelete` tools are excluded using their exact,
  case-sensitive wire names.
- Channel media delivery accepts accessible absolute paths through
  `MEDIA:<absolute-path>`; a file does not need to be copied into the Gateway
  workspace first.
- `SessionSearch` / `MessageSession` are optional continuity tools, not a
  default substitute for handling the user's task with local tools.

### 消息持久化流程

```
Agent 发出消息
  │
  ├─ 1. Agent Process 通过 child_process IPC 发给 Main
  │
  ├─ 2. Main 落库（SQLite-backed 队列）
  │     └─ INSERT INTO messages ...
  │     └─ 如果是用户消息，同时更新 chat_sessions.updated_at
  │
  ├─ 3. Main 推送 Renderer
  │     └─ BrowserWindow.webContents.send() → Renderer 更新 Zustand
  │
  └─ 4. 断线重连时，Renderer 从队列重放未确认消息
         └─ query messages WHERE id > last_acknowledged_id

streamChat 完成（最终快照）
  │
  ├─ Agent 发最终消息列表
  ├─ Main 执行 message:replace（DELETE + INSERT 原子替换）
  └─ Main 通知 Renderer 持久化完成
```

### IPC 消息协议

**Main ↔ Agent Process (child_process IPC)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `init` | Main → Agent | 初始化 Provider 配置 |
| `chat:start` | Main → Agent | 聊天请求 |
| `chat:interrupt` | Main → Agent | 中断当前操作 |
| `permission:resolve` | Main → Agent | 权限决策 |
| `spawn` / `kill` | Main → Agent | 进程生命周期 |
| `ready` | Agent → Main | Agent 就绪通知 |
| `chat:text/thinking/tool_use/tool_result/tool_output` | Agent → Main | 流式输出（先落库再转发） |
| `chat:permission` | Agent → Main | 权限请求 |
| `chat:done/error/status` | Agent → Main | 状态通知 |
| `chat:db_persisted` | Agent → Main | 数据库持久化结果通知 |
| `chat:token_usage` | Agent → Main | Token 使用量 |
| `chat:context_usage` | Agent → Main | 上下文窗口使用量 |
| `chat:tool_progress` | Agent → Main | 工具执行进度 |
| `db:request` | Agent → Main | 数据库操作请求 |
| `db:response` | Main → Agent | 数据库操作响应 |
| `ping/pong` | 双向 | 心跳检测（Process Pool 健康监控） |

**Renderer ↔ Main (MessagePort - agentControl)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `chat:start` | Renderer → Main | 开始聊天 |
| `chat:interrupt` | Renderer → Main | 中断聊天 |
| `permission:resolve` | Renderer → Main | 权限决策 |
| `chat:text/thinking/tool_use/tool_result/tool_output` | Main → Renderer | 流式输出 |
| `chat:permission` | Main → Renderer | 权限请求 |
| `chat:done/error/status` | Main → Renderer | 状态通知 |
| `chat:db_persisted` | Main → Renderer | 数据库持久化通知 |
| `chat:token_usage` | Main → Renderer | Token 使用量 |
| `chat:context_usage` | Main → Renderer | 上下文窗口使用量 |
| `chat:tool_progress` | Main → Renderer | 工具执行进度 |

**Renderer ↔ Main (MessagePort - config)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `config:get` | Renderer → Main | 获取配置 |
| `config:set` | Renderer → Main | 设置配置 |
| `config:subscribe` | Renderer → Main | 订阅配置变更 |
| `config:update` | Main → Renderer | 配置变更广播 |
| `config:response` | Main → Renderer | 配置查询响应 |

**Renderer ↔ Main (Electron IPC invoke)**:

| 通道 | 说明 |
|------|------|
| `db:session:*` | Session CRUD 操作 |
| `db:message:*` | Message CRUD 操作 |
| `db:task:*` | Task CRUD 操作 |
| `db:permission:*` | Permission 操作 |
| `db:setting:*` | Settings 操作 |
| `config:provider:*` | Provider 操作 (ConfigManager 管理) |
| `db:search:*` | 搜索操作 |
| `db:channel:*` | Channel 操作 |
| `db:project:*` | Project 操作 |
| `net:testProvider` | Provider 连接测试 |
| `dialog:openFolder` | 原生文件夹选择 |
| `shell:openPath` | 打开路径 |
| `projects:*` | 最近项目 |
| `gateway:*` | Gateway/Bridge 管理（启动、停止、状态查询） |
| `automation:cron:*` | 定时任务 CRUD 操作 |
| `updater:*` | 自动更新检查、下载、安装 |
| `logger:*` | 日志查询、导出 |
| `browser:*` | 浏览器扩展守护进程管理 |

**Main ↔ Gateway Process (MessagePort)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `gateway:init` | Main → Gateway | 初始化 Gateway 配置 |
| `gateway:start` | Main → Gateway | 启动平台连接 |
| `gateway:stop` | Main → Gateway | 停止平台连接 |
| `gateway:message` | 双向 | 消息转发 |
| `gateway:status` | Gateway → Main | 连接状态更新 |
| `gateway:error` | Gateway → Main | 错误通知 |

### Resource Governor

Resource Governor 负责防止 CPU/内存被打爆，是 Main Process 中的核心调度组件：

#### ① 并发 Agent 上限（进程级）

限制同时运行的 Agent Process 数量，防止系统过载：

- **`maxConcurrent`** 动态计算：`Math.min(os.cpus().length / 2, 4)`
- 且空闲内存 > 2GB 时才允许开新槽位
- 超出限制的请求进入 **排队队列**，等待槽位释放

#### ② Token 桶限速（进程内，Agent Process 自管理）

**TokenBucket 在每个 Agent Process 内独立运行**，不属于 Main Process：

- **位置**：每个 Agent Process 内部（`agent-process-entry.ts`）
- **容量**：最多 5 个并发工具调用
- **补充速率**：每秒补充 2 个令牌
- **理由**：工具调用频率不需要跨进程协调，每个 Agent Process 独立限速即可，Main 无法感知 Agent 内部工具调用频率
- 工具调用前必须获取令牌，无令牌则等待（进程内自旋，不阻塞 Main）

#### ③ 健康监控（心跳 + 僵尸清理）

AgentProcessPool 对每个 Agent Process 定期发心跳，超时未响应则强杀并清理：

```typescript
setInterval(() => {
  for (const [sid, proc] of this.running) {
    proc.send({ type: 'ping' });
    setTimeout(() => {
      if (!this.lastPong.get(sid) || Date.now() - this.lastPong.get(sid) > 5000) {
        proc.kill('SIGKILL');
        this.release(sid);  // 释放槽位，让排队的新请求有机会运行
      }
    }, 3000);
  }
}, 10000);
```

#### 进程池生命周期

```
Main 收到 chat:start
  │
  ├─ AgentProcessPool 检查 maxConcurrent
  │    └─ running.size < maxConcurrent → spawn Agent Process
  │    └─ running.size >= maxConcurrent → 进排队队列（Queue）
  │
  ├─ Agent Process 启动完成，发送 ready → Main
  │
  ├─ Agent 运行中，心跳监控持续检测
  │    └─ ping 超时 → kill → release 槽位 → 触发队列下一个
  │
  └─ chat:done → Agent 退出 → release 槽位 → 触发队列下一个
```

### 安全设计

#### Golden Trident 数据架构："物理分离、单一职责、原子防御"

DUYA 的所有本地数据彻底划分为三个独立的物理文件，存放在 `userData` 目录下：

| 文件类别 | 路径 | 管理者 | 核心内容 | 加密策略 |
|:---|:---|:---|:---|:---|
| **引导基建** (指南针) | `/config/boot.json` | Main Process (`boot-config.ts`) | 仅包含 `databasePath` (数据库的绝对路径) | **明文** (必须在应用极早期能被快速读取) |
| **机密配置** (保险箱) | `/config/settings.json` | `ConfigManager` | `apiProviders` (API 密钥)、`agentSettings` (模型配置)、`uiPreferences` (界面偏好) | **OS 级加密** (依赖 Electron `safeStorage`) |
| **业务流水** (账本) | `/databases/duya-main.db` | `Database Service` (SQLite 单例) | `sessions` (会话列表)、`messages` (聊天明细)、`permissions` (工具授权记录) | **明文** (依赖系统文件权限保护) |

#### 主进程生命周期时序

三个文件在主进程启动时的介入时机有严格的先后顺序：

1. **第 0 步：独占锁检查** — `app.requestSingleInstanceLock()`，防止多开引起的文件争抢
2. **第 1 步：读取引导文件 (Boot)** — 主进程同步读取 `boot.json`，拿到 `databasePath`
3. **第 2 步：初始化数据库网关 (DB Init)** — 根据拿到的路径，实例化 `better-sqlite3`，持有 SQLite 文件排他锁
4. **第 3 步：初始化配置中心 (Config Init)** — 实例化 `ConfigManager`，解密读取 `settings.json` 中的 API Keys
5. **第 4 步：拉起 Daemon 与 UI** — 数据库和配置双双就绪后，启动子系统并加载前端窗口

#### 数据库迁移 (搬家) 工作流

当用户要求将数据库转移到其他位置时，遵循 **"锁定 → 迁移 → 篡改引导 → 重启"** 的流程：

1. **暂停 I/O**：通知 Daemon 暂停所有后台流式写入任务
2. **安全复制**：主进程获取用户选择的新路径，将 `.db`、`.db-wal`、`.db-shm` 三个文件完整复制到新位置
3. **更新指南针**：修改 `boot.json`，将 `databasePath` 覆写为新路径（原子写入）
4. **强制重启**：主进程调用 `app.relaunch()` + `app.exit(0)` 释放旧锁并接管新库

#### Bulletproof 防御策略

* **防御 1：原子写入 (防断电损坏)** — 使用 `write-file-atomic` 库，先写入临时文件 `.tmp`，落盘成功后由 OS 执行原子级 Rename 覆盖原文件
* **防御 2：Safe Mode 回退 UI (防幽灵磁盘)** — 数据库寻址失败时不退出应用，渲染极简的"安全恢复模式"页面，提供"重新定位文件"或"重置到默认路径"按钮
* **防御 3：防止 API 密钥裸奔 (防黑客拖库)** — Provider 数据必须且只能由 `ConfigManager` 掌管，确保高价值数据永远处于 `safeStorage` 的加密保护伞下

#### API Key 保护

- **Provider 存储**：API Provider 配置统一由 ConfigManager 管理，使用 Electron `safeStorage` 加密存储在 `config/settings.json`
- Provider 查询结果返回给 Renderer 时，API Key 自动脱敏（`sk-xxxx***xxxx`）
- Agent Process 获取完整 API Key 用于实际 API 调用（Main 在 `init` 消息中传递）

#### IPC 输入验证

- `shell:open-path`：验证路径类型、长度、空字节
- `projects:add-recent-folder`：验证路径合法性
- `notification:show`：验证标题和内容长度

#### 崩溃恢复

Process Pool 对每个 Agent Process 心跳监控，僵尸进程自动清理：

```typescript
// Process Pool 检测到 Agent 崩溃
proc.on('exit', (code) => {
  // 1. 从 running Map 移除
  this.running.delete(sessionId);
  // 2. 释放槽位，触发队列下一个
  this.release(sessionId);
  // 3. 通知 Renderer
  broadcastToRenderers('agent:disconnected', { sessionId, code });
  // 4. 如果有排队请求，spawn 新的 Agent
  if (this.queue.length > 0) {
    const next = this.queue.shift()!;
    this.spawn(next.sessionId);
  }
});
```

Renderer 通过 `agent:disconnected` 感知 Agent 崩溃，已落库的消息不丢失。

### Provider 模型（多服务商并存）

DUYA 采用**多服务商并存**（multi-provider）模型：用户可以在 `settings.json` 中配置任意数量的 LLM 服务商，每位服务商都**可独立选用**。系统不再强制全局"唯一活跃服务商"约束。

#### 数据结构

- **`AppConfig.apiProviders: Record<string, ApiProvider>`** — 全部已配置服务商，按 id 索引。
- **`AppConfig.defaultProviderId: string | null`** — **软默认**。仅作为隐式回退，不锁定其他服务商。
- **渲染层 DTO (`RendererLlmProviderDTO.isDefault`)** — 由 `defaultProviderId` 派生；取代旧字段 `isActive`。

#### 路由优先级

会话、视觉、网关、Wiki Agent、标题生成、嵌入、定时任务等子系统，按以下优先级选择服务商：

1. **会话级 pin** — 主进程 `AgentProcessPool` 接收渲染层 `setSessionProvider(sessionId, providerId)`，将该会话钉到指定服务商。
2. **任务级显式选择** — 视觉 / 网关 / 嵌入等子系统可以显式传入 `providerId`。
3. **软默认** — `AppConfig.defaultProviderId`。
4. **首个可用服务商** — 配置中第一个 `hasApiKey` 为 `true`（或 `providerType === 'ollama'`）的条目。
5. **未配置** — `sendProviderInit` 记录 WARN 日志并跳过 init，UI 暴露"未配置默认服务商"提示。

#### 迁移

`multi-provider-v1` 迁移在 `ConfigManager` 加载时执行一次：

- 若 `defaultProviderId` 未设置且**有且仅有一个** `isActive=true` 的服务商，则将该 id 写入 `defaultProviderId`。
- 清除所有 `isActive` 标志（让 `isDefault` 成为唯一权威状态）。
- 标记 `migrations['multi-provider-v1'] = true`，防止重入。

#### 受影响的子模块

| 子模块 | 行为 |
|:---|:---|
| Agent Process Pool | 优先使用 `RunningProcess.providerId`，回退到 `defaultProviderId`；切换 provider 触发 `reinitProcess` |
| 视觉 | `providerId` → `defaultProviderId` → 首个可用 |
| 网关 / Wiki Agent / 标题生成 / 嵌入 | 同上 |
| 定时任务 | 同上 |
| Provider UI 卡片 | 旧 "In use" / "Enable" 改为 "Default" / "Set as default"；不再隐藏非默认卡片的 delete 按钮 |
| 设置面板 | 新增 **Default Provider** 区块，使用 `ProviderPickerView` |
| CLI | 新增 `duya config provider set-default [id] --clear`；`provider activate` 标记为 deprecated |

### 安全扫描系统

DUYA 实现了多层安全扫描机制，防止提示词注入和恶意代码执行：

#### 扫描器架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Security Scanners                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ ContextScanner  │  │  SkillScanner   │  │ BashClassifier  │ │
│  │                 │  │                 │  │                 │ │
│  │ - AGENTS.md     │  │ - SKILL.md      │  │ - Command       │ │
│  │ - ARCHITECTURE  │  │ - External      │  │   classification│ │
│  │   .md           │  │   skills        │  │ - Dangerous     │ │
│  │ - SOUL.md       │  │ - Trust levels  │  │   pattern detect│ │
│  │                 │  │                 │  │                 │ │
│  │ 24+ threat      │  │ 80+ threat      │  │ Stub (ant-only   │
│  │ patterns        │  │ patterns        │  │ classifier perm) │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### ContextScanner（上下文文件扫描）

扫描上下文文件（AGENTS.md、ARCHITECTURE.md、SOUL.md 等）中的提示词注入攻击：

**文件位置**：`packages/agent/src/security/contextScanner.ts`

**检测的威胁类型**：

| 威胁ID | 描述 | 严重程度 |
|--------|------|----------|
| `prompt_injection` | "ignore previous instructions" 等指令覆盖 | Critical |
| `deception_hide` | "do not tell the user" 隐藏信息指令 | Critical |
| `sys_prompt_override` | 系统提示词覆盖尝试 | Critical |
| `bypass_restrictions` | 绕过限制指令 | Critical |
| `html_comment_injection` | HTML注释隐藏指令 | High |
| `hidden_div` | display:none 隐藏内容 | High |
| `env_exfil_curl` | curl泄露环境变量 | Critical |
| `read_secrets` | 读取.secret文件 | Critical |
| `invisible_unicode` | 零宽字符等不可见字符 | High |
| `jailbreak_dan` | DAN越狱模式 | Critical |

**使用示例**：

```typescript
import { scanContextContent } from './security/contextScanner.js';

const result = scanContextContent(content, filename);
if (!result.safe) {
  console.warn('Blocked:', result.blockedContent);
  console.log('Findings:', result.findings);
}
```

#### SkillScanner（技能安全扫描）

扫描技能文件的安全威胁，支持信任等级系统：

**文件位置**：`packages/agent/src/security/skillScanner.ts`

**威胁分类**：

| 分类 | 说明 | 示例 |
|------|------|------|
| `injection` | 提示词注入 | 角色劫持、指令覆盖 |
| `exfiltration` | 数据外泄 | 环境变量读取、密钥泄露 |
| `destructive` | 破坏性操作 | rm -rf /、mkfs |
| `persistence` | 持久化攻击 | crontab、SSH后门 |
| `network` | 网络攻击 | 反弹shell、隧道 |
| `obfuscation` | 混淆攻击 | base64解码、eval |
| `privilege_escalation` | 权限提升 | sudo滥用、SUID |
| `credential_exposure` | 凭证泄露 | 硬编码API密钥 |

**信任等级**：

```typescript
type TrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';

// 安装策略
const INSTALL_POLICY = {
  builtin: ['allow', 'allow', 'allow'],
  trusted: ['allow', 'allow', 'block'],
  community: ['allow', 'block', 'block'],
  'agent-created': ['allow', 'allow', 'ask'],
};
```

#### BashClassifier（命令分类器）

**文件位置**：`packages/agent/src/security/bashClassifier.ts`

**当前状态**：Stub 实现（`isClassifierPermissionsEnabled()` 返回 `false`），分类器权限仅在 Claude Code（ant）中使用。

BashClassifier 在 DUYA 中未启用，命令分类由 SkillScanner 的 `execution` 类别处理。

### 提示词系统

DUYA 采用模块化的提示词工程架构，支持动态组装和缓存优化。

#### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Prompt System Architecture                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  PromptManager  │  │  Section Cache  │  │   Sections      │ │
│  │                 │  │                 │  │                 │ │
│  │ - Orchestration │  │ - Static cache  │  │ - intro.ts      │ │
│  │ - Mode control  │  │ - Volatile sect │  │ - system.ts     │ │
│  │ - Context build │  │ - Boundary      │  │ - taskHandling  │ │
│  │                 │  │   marker        │  │ - actions.ts    │ │
│  └────────┬────────┘  └─────────────────┘  │ - toolUsage.ts  │ │
│           │                                │ - toneAndStyle  │ │
│           ▼                                │ - outputEff...  │ │
│  ┌─────────────────┐                       │ - dynamic/*     │ │
│  │  SystemPrompt   │                       └─────────────────┘ │
│  │  (string[])     │                                          │
│  └─────────────────┘                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **PromptManager** | `packages/agent/src/prompts/PromptManager.ts` | 提示词组装、缓存管理、模式控制 |
| **Section Types** | `packages/agent/src/prompts/types.ts` | 类型定义、常量、PromptMode |
| **Section Helpers** | `packages/agent/src/prompts/constants/promptSections.ts` | cached/volatile section 工厂函数 |
| **Intro Section** | `packages/agent/src/prompts/sections/intro.ts` | Agent身份介绍 |
| **System Section** | `packages/agent/src/prompts/sections/system.ts` | 核心系统指令 |
| **TaskHandling** | `packages/agent/src/prompts/sections/taskHandling.ts` | 任务处理指导 |
| **Actions Section** | `packages/agent/src/prompts/sections/actions.ts` | 谨慎行动准则 |
| **ToolUsage Section** | `packages/agent/src/prompts/sections/toolUsage.ts` | 工具使用指导 |
| **Dynamic Sections** | `packages/agent/src/prompts/sections/dynamic/*.ts` | 动态内容（环境、平台、语言等）|

#### Section 类型

**Static Sections（可缓存）**：
- 内容在会话期间不变
- 使用 `cachedPromptSection()` 创建
- 例如：intro, system, taskHandling, actions

**Volatile Sections（动态）**：
- 每轮重新计算
- 使用 `volatilePromptSection()` 创建
- 例如：environment, platform, language, mcpInstructions

**缓存边界标记**：

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

// 提示词结构：
// [Static Sections] + BOUNDARY + [Dynamic Sections]
```

#### Project-grounded harness invariants (Plan 226)

Workspace-capable prompt profiles share two governance layers before their
role-specific instructions:

- `projectGrounding` requires scoped `AGENTS.md` discovery, bounded plan/spec
  recovery, runtime-path confirmation, dirty-worktree protection, and a clear
  sufficiency gate before mutation.
- `projectContinuity` is enabled for coordinating/full agents and defines the
  canonical plan, checkpoint, handoff, and reconciliation contract for work
  spanning sessions or agents.

`AgentsMdManager.refreshForTask()` reloads resolved project instructions at a
prompt-build boundary and invalidates the cached section only when the snapshot
changes. Full, minimal, and bare workspace profiles retain `agentsMd`; profiles
without a project workspace explicitly disable the project sections.

Subagent role prompts are composed with the shared minimal harness rather than
replacing it. This preserves project rules, environment constraints, language,
tool guidance, and grounding while leaving long-horizon integration ownership
with the coordinating agent. `SessionSearch` is tool-aware evidence recovery;
repository plans and specifications remain the durable source of truth.

#### Recent session directory (Plan 229)

Full, tool-capable prompt profiles can include a volatile directory of recent
root sessions: up to five from the current project and three from other
projects. `recent-session-directory.ts` normalizes project paths, folds child
and subagent sessions into their root, excludes the current root lineage, and
sanitizes title/project metadata. It never injects message bodies or absolute
working-directory paths.

The directory is an untrusted discovery index. Agents use scoped
`SessionSearch` (`same_project`, `other_projects`, or `all`) to recover evidence
before acting. `MessageSession` remains an explicit follow-up for one clearly
relevant session, with a focused minimal-mode request; recency alone never
triggers cross-session contact. Minimal and bare prompt profiles do not receive
the directory. The same query model backs the dynamic prompt and no-query
`SessionSearch`, including Electron agent subprocesses through async DB IPC.

#### PromptManager 使用

```typescript
import { PromptManager } from './prompts/PromptManager.js';

// 创建管理器（默认 full 模式）
const promptManager = new PromptManager({
  workingDirectory: process.cwd(),
  language: 'zh-CN',
});

// 构建系统提示词
const systemPrompt = await promptManager.buildSystemPrompt(enabledTools, mcpServers);

// 切换模式（清除缓存）
promptManager.setPromptMode('minimal');
```

#### 与 AgentTool 集成

子Agent使用精简提示词模式：

```typescript
// packages/agent/src/tool/AgentTool/AgentTool.ts

const promptManager = new PromptManager({
  promptMode: 'minimal',  // 子Agent使用精简模式
  workingDirectory: options.workspaceDir,
});

const systemPrompt = await promptManager.buildSystemPrompt(enabledTools);
```

#### 未来扩展：PromptMode

计划支持多种提示词模式以适应不同场景：

```typescript
type PromptMode = 'full' | 'minimal' | 'none' | 'coding' | 'chat';

// full: 完整提示词（主Agent，默认）
// minimal: 精简提示词（子Agent，节省~50% token）
// none: 仅基础身份（特殊场景，节省~95% token）
// coding: 编程专用（保留代码风格指导）
// chat: 对话专用（简化工具说明）
```

**详细设计**：参见 [docs/exec-plans/active/26-prompt-mode-architecture.md](./docs/exec-plans/active/26-prompt-mode-architecture.md)

### 数据库设计

#### 设计原则

1. **唯一写入点**：SQLite 实例只在 Main 进程，避免多进程写入冲突
2. **WAL 模式**：启用 `journal_mode = WAL`，支持读写并发；`busy_timeout = 5000` 防止写锁冲突
3. **每条消息先落库再转发**：Agent 发出的每条消息先通过 `db:request` 落库（SQLite-backed 队列），再转发给 Renderer，断线重连后可回放
4. **两条访问通道**：
   - **Agent Process → Main**：通过 child_process IPC `db:request`/`db:response`（每条消息落库）
   - **Renderer → Main**：通过 IPC invoke（主动查询，如切换 session 时加载历史）
5. **API Key 脱敏**：返回给 Renderer 的 Provider 数据自动遮蔽 API Key
6. **Provider 存储**：Provider 配置由 ConfigManager 管理（加密存储在 `config/settings.json`），不存储在数据库
7. **Generation 冲突解决**：使用 generation 编号避免并发写入冲突（用于最终快照替换）
8. **数据库路径由 boot.json 管理**：数据库文件路径由 `/config/boot.json` 中的 `databasePath` 字段决定，支持迁移到自定义位置
9. **原子写入**：boot.json 和 settings.json 均使用 `write-file-atomic` 写入，防止断电损坏

#### 数据库表结构

| 表名 | 用途 | 访问方 |
|------|------|--------|
| `chat_sessions` | Session 元信息 | Renderer (列表) / Agent Process (状态查询) |
| `messages` | 聊天消息历史 | Renderer (加载历史) / Agent Process (写入新消息) / Main (落库后转发) |
| `permission_requests` | 权限请求记录 | Agent Process (写入) / Renderer (查询) |
| `settings` | 应用设置 | Renderer / Agent Process |
| `tasks` | 任务管理 | Agent Process (写入) / Renderer (查询) |
| `session_runtime_locks` | Session 运行时锁 | Agent Process (写入) / Renderer (查询) |
| `channel_bindings` | Bridge 通道绑定 | Bridge |
| `channel_offsets` | Bridge 通道偏移 | Bridge |
| `channel_permission_links` | Bridge 权限链接 | Bridge |
| `weixin_accounts` | 微信账户 | Bridge |
| `weixin_context_tokens` | 微信上下文 Token | Bridge |
| `automation_crons` | 定时任务配置 | Automation Scheduler |
| `automation_cron_runs` | 定时任务执行历史 | Automation Scheduler |
| `conductor_canvases` | Conductor 画布 | Renderer / Agent Process (via Main) |
| `conductor_widgets` | Conductor Widget 实例 | Renderer / Agent Process (via Main) |
| `conductor_actions` | Conductor 操作日志（可审计、可回放） | Main Process (唯一写入) / Renderer (只读) |
| `_schema_migrations` | Schema 迁移记录 | Main Process |

> **Provider 配置说明**：API Provider 配置不再存储在数据库，统一由 **ConfigManager** 管理（加密存储在 `config/settings.json`）。

#### 自动化定时任务表

**`automation_crons`** - 定时任务配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `name` | TEXT | 任务名称 |
| `description` | TEXT | 任务描述 |
| `prompt` | TEXT | 执行提示词 |
| `schedule_kind` | TEXT | 调度类型：`at`/`every`/`cron` |
| `schedule_expr` | TEXT | 调度表达式 |
| `timezone` | TEXT | 时区（IANA格式）|
| `session_target` | TEXT | 会话目标：`isolated`（固定）|
| `delivery_mode` | TEXT | 投递模式：`none`（固定）|
| `concurrency_policy` | TEXT | 并发策略：`skip`/`parallel`/`queue`/`replace` |
| `max_retries` | INTEGER | 最大重试次数 |
| `retry_backoff` | TEXT | 重试退避策略（JSON数组，秒）|
| `enabled` | INTEGER | 是否启用 |
| `created_at` | INTEGER | 创建时间戳 |
| `updated_at` | INTEGER | 更新时间戳 |

**`automation_cron_runs`** - 定时任务执行历史：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `cron_id` | TEXT | 关联的 cron 任务 ID |
| `scheduled_at` | INTEGER | 计划执行时间 |
| `started_at` | INTEGER | 实际开始时间 |
| `completed_at` | INTEGER | 完成时间 |
| `status` | TEXT | 状态：`pending`/`running`/`completed`/`failed` |
| `output` | TEXT | 执行输出 |
| `error` | TEXT | 错误信息 |
| `retry_count` | INTEGER | 重试次数 |

#### Conductor 表

**`conductor_canvases`** - 画布：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `name` | TEXT | 画布名称 |
| `description` | TEXT | 画布描述 |
| `layout_config` | TEXT | 布局配置（JSON） |
| `sort_order` | INTEGER | 排序顺序 |
| `created_at` | INTEGER | 创建时间戳 |
| `updated_at` | INTEGER | 更新时间戳 |

**`conductor_widgets`** - Widget 实例：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `canvas_id` | TEXT | 所属画布 ID（FK → conductor_canvases） |
| `kind` | TEXT | Widget 类型：`builtin` / `template` / `dynamic` |
| `type` | TEXT | Widget 具体类型（如 `TaskList`, `NotePad`） |
| `position` | TEXT | 位置和大小（JSON: `{x, y, w, h}`） |
| `config` | TEXT | Widget 配置（JSON） |
| `data` | TEXT | Widget 数据（JSON） |
| `data_version` | INTEGER | 乐观锁版本号（每次更新 +1） |
| `source_code` | TEXT | 动态 Widget 源码 |
| `state` | TEXT | 状态：`idle` / `loading` / `error` |
| `permissions` | TEXT | 权限配置（JSON: `{agentCanRead, agentCanWrite, agentCanDelete}`） |
| `created_at` | INTEGER | 创建时间戳 |
| `updated_at` | INTEGER | 更新时间戳 |

**`conductor_actions`** - 操作日志（只追加，可回放）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 主键，自增 |
| `canvas_id` | TEXT | 所属画布 ID（FK → conductor_canvases） |
| `widget_id` | TEXT | 相关 Widget ID |
| `actor` | TEXT | 操作者：`user` / `agent` / `system` |
| `action_type` | TEXT | 操作类型 |
| `payload` | TEXT | 操作参数（JSON） |
| `result_patch` | TEXT | 操作结果 diff（JSON，用于 Undo/Redo） |
| `merged_from` | TEXT | 冲突合并来源 |
| `reversible` | INTEGER | 是否可逆 |
| `ts` | INTEGER | 操作时间戳 |
| `undone_at` | INTEGER | 撤销时间（NULL 表示未撤销） |

> **Conductor 架构约束**：
> - Main Process 是 Conductor 数据的**唯一写入方**，Renderer 和 Agent Process 只能通过 `conductor:*` IPC 提交意图。
> - 所有写入都在事务内完成：更新业务表 → 写入 `conductor_actions` → 广播 `conductor:state:patch`。
> - Widget Data 使用 `data_version` 乐观锁：用户写入优先，Agent 冲突时保留 `merged_from`。
> - Undo/Redo 基于 `result_patch` 逆操作，不使用原始 `payload`。
> - Canvas 直接拖拽只更新当前选中元素；元素重叠是合法状态，不做被动碰撞推挤。跨元素重排只能由显式 auto-layout 操作触发。
> - 自动 zoom-to-fit 的可读性下限为 `0.65`；用户仍可手动缩放到全局下限 `0.2`。短标签按紧凑节点渲染，避免为了全局概览把文字缩成不可读尺寸。

#### 数据库文件位置

数据库文件路径由 `/config/boot.json` 中的 `databasePath` 字段决定：

- **默认路径**：`{userData}/databases/duya-main.db`
- **自定义路径**：用户可通过迁移功能将数据库移至任意位置
- **向后兼容**：自动检测并重命名旧版 `duya.db` 为 `duya-main.db`
- **引导文件**：`boot.json` 仅包含 `{ "_version": 1, "databasePath": "..." }`，明文存储

### 优雅关闭

应用退出时按以下顺序清理资源：

1. 停止所有 Agent Process（AgentProcessPool.shutdown）
2. 关闭所有 MessagePort 通道（ChannelManager.shutdown）
3. 停止性能监控（PerformanceMonitor.shutdown）
4. 停止 Bridge 进程（stopBridgeProcess）
5. 清理会话管理器（SessionManager.shutdown）— 不涉及写库
6. 刷新配置到磁盘（ConfigManager.shutdown）
7. 关闭数据库连接（Database.close）— **最后一步**，确保前面所有写操作完成后再关闭

## 目录结构

```
duya/
├── electron/                    # Electron 主进程
│   ├── main.ts                 # 入口、窗口管理、IPC、生命周期 (lock → boot → db → config → UI)
│   ├── preload.ts              # contextBridge API (含 SafeMode/Migration API)
│   ├── boot-config.ts          # 引导配置管理 (指南针) - boot.json 读写、路径解析、原子写入
│   ├── agent-process-pool.ts   # AgentProcessPool（并发上限 + 心跳 + 排队 + 消息落库）
│   ├── session-manager.ts      # Session 状态跟踪与生命周期管理
│   ├── db-handlers.ts          # 数据库 IPC 处理器 (账本) - boot.json 路径解析、Safe Mode
│   ├── config-manager.ts       # 配置管理 (保险箱) - safeStorage 加密、原子写入、实时广播
│   ├── message-port-manager.ts # MessagePort 通道管理（自动重连）
│   ├── performance-monitor.ts  # 性能监控（延迟、吞吐、内存）
│   ├── net-handlers.ts         # 网络相关 IPC 处理器
│   ├── port-types.ts           # Port 类型定义
│   └── ipc/
│       ├── agent-communicator.ts  # Agent IPC 处理器 + DB 请求分发
│       └── gateway-communicator.ts # Gateway IPC 处理器
│
├── packages/agent/src/
│   ├── index.ts                  # Pure barrel: re-exports public API + `duyaAgent` from `./agent/DuyaAgent.js`
│   ├── agent/                    # duyaAgent class implementation home
│   │   ├── DuyaAgent.ts          # `duyaAgent` class (~1900 LoC) + module-level helpers used only by it
│   │   └── helpers.ts            # `extractTextFromContent`, `collectRecentImageAttachments`
│   ├── process/
│   │   └── agent-process-entry.ts  # Agent Process 入口（ChildProcess 模式）
│   ├── ipc/
│   │   ├── PortClient.ts       # MessagePort 客户端（重连 + 消息队列）
│   │   └── db-client.ts        # IPC 数据库客户端
│   ├── prompts/                # 提示词系统工程
│   │   ├── PromptManager.ts    # 提示词管理器（组装、缓存、模式控制）
│   │   ├── types.ts            # 类型定义、PromptMode、常量
│   │   ├── cache.ts            # 提示词缓存系统
│   │   ├── constants/          # 提示词常量
│   │   │   └── promptSections.ts  # cached/volatile section 工厂函数
│   │   └── sections/           # 提示词 Sections
│   │       ├── intro.ts        # 身份介绍
│   │       ├── system.ts       # 系统指令
│   │       ├── taskHandling.ts # 任务处理指导
│   │       ├── actions.ts      # 谨慎行动准则
│   │       ├── toolUsage.ts    # 工具使用指导
│   │       ├── toneAndStyle.ts # 语气风格
│   │       ├── outputEfficiency.ts  # 输出效率
│   │       └── dynamic/        # 动态 Sections
│   │           ├── environment.ts   # 环境信息
│   │           ├── platform.ts      # 平台适配
│   │           ├── language.ts      # 语言偏好
│   │           ├── mcpInstructions.ts  # MCP指令
│   │           ├── skillsMetadata.ts   # 技能元数据
│   │           ├── sessionGuidance.ts  # 会话指导
│   │           ├── memorySection.ts    # 记忆片段
│   │           ├── memoryContextSection.ts  # 记忆上下文
│   │           ├── outputStyle.ts      # 输出样式
│   │           ├── scratchpad.ts       # 临时空间
│   │           ├── sessionSearchSection.ts  # 会话搜索
│   │           ├── agentsMdSection.ts  # AGENTS.md 内容
│   │           ├── widgetGuidelines.ts # Widget 指南
│   │           └── conductorCanvas.ts  # Conductor 画布
│   ├── llm/                    # LLM Provider 适配层
│   ├── tool/                   # 工具实现
│   ├── permissions/            # 权限系统
│   ├── compact/                # 上下文压缩
│   ├── skills/                 # Skill 系统
│   ├── sandbox/                # 沙箱安全
│   ├── security/               # 安全扫描
│   │   ├── contextScanner.ts   # 上下文文件扫描（AGENTS.md等）
│   │   ├── skillScanner.ts     # 技能安全扫描
│   │   └── bashClassifier.ts   # Bash命令分类
│   └── ...
│
└── src/                         # Vite + React（条件渲染，无 Router）
    ├── components/              # UI 组件
    │   ├── chat/               # 聊天相关组件
    │   ├── layout/             # 布局组件（sidebar、app shell）
    │   ├── settings/           # 设置面板组件
    │   ├── bridge/             # Gateway/Bridge 组件
    │   ├── automation/         # 自动化/定时任务组件
    │   ├── skills/             # Skill 管理组件
    │   ├── browser/            # 浏览器扩展相关组件
    │   ├── onboarding/         # 新用户引导组件
    │   └── ui/                 # 通用 UI 组件
    ├── contexts/                # React Context
    ├── hooks/                   # 自定义 Hooks
    ├── stores/                  # Zustand Store
    ├── lib/                     # 工具库
    └── types/                   # 类型定义
```

### userData 目录结构

```
{AppData/Roaming/DUYA}/
├── config/
│   ├── boot.json              # 引导基建 (指南针) - databasePath，明文，原子写入
│   └── settings.json          # 机密配置 (保险箱) - API Keys + 设置，safeStorage 加密，原子写入
├── databases/
│   ├── duya-main.db           # 业务流水 (账本) - 会话/消息/权限，SQLite WAL 模式
│   ├── duya-main.db-wal       # WAL 日志
│   └── duya-main.db-shm       # 共享内存
├── logs/                      # 应用日志目录
│   ├── app.log                # 主应用日志
│   ├── app.log.1              # 轮转日志
│   └── ...
├── recent-folders.json        # 最近打开的文件夹
├── settings.json              # (旧版，自动迁移到 config/settings.json)
└── crash-reports/             # 崩溃报告（如启用）
```

## 技术决策

| 决策 | 原因 | 当前状态 |
|------|------|----------|
| **ChildProcess 而非 Worker Thread** | 进程隔离更彻底，崩溃互不影响；LLM 调用和工具执行完全独立；沙箱通过进程边界实现 | ✅ 已实现（`agent-process-pool.ts` + `agent-process-entry.ts`） |
| **Multi-Agent Process** | 每个 Session 独立进程，AgentProcessPool 控制并发上限，防止系统过载 | ✅ 已实现 |
| **每条消息先落库再转发** | SQLite-backed 队列，断线重连后可回放，切换 session 历史不丢 | ✅ 已实现（`persistMessage()` in `agent-process-pool.ts`） |
| **AgentProcessPool** | 并发上限（CPU/2）+ 心跳监控（杀僵尸）+ 排队队列，在 Main 内统一管理 | ✅ 已实现 |
| **TokenBucket（进程内）** | 每个 Agent Process 内部独立限速，5容量/秒2补充，不跨进程协调 | ✅ 已实现（`agent-process-entry.ts`） |
| **SQLite 单例写入 + WAL 模式** | Main 进程唯一写入方，WAL 支持读写并发，`busy_timeout = 5000` | ✅ 已实现 |
| **Main 中转消息** | Renderer ↔ Agent 通信经 Main 转发，延迟在可接受范围 | ✅ 已实现 |
| **Generation 冲突解决** | 使用 generation 编号避免并发写入冲突 | ✅ 已实现 |
| **Provider 加密存储** | API Key 由 ConfigManager 管理，safeStorage 加密，不存数据库 | ✅ 已实现 |
| **Golden Trident 数据架构** | boot.json (引导) + settings.json (机密) + duya-main.db (业务)，物理分离 | ✅ 已实现 |
| **原子写入 (write-file-atomic)** | boot.json 和 settings.json 使用原子写入，防止断电损坏 | ✅ 已实现 |
| **Safe Mode 回退 UI** | 数据库寻址失败时渲染安全恢复模式，提供重新定位/重置按钮 | ✅ 已实现 |
| **数据库路径可迁移** | boot.json 管理 databasePath，支持迁移到自定义位置 + app.relaunch() | ✅ 已实现 |
| **安全扫描系统** | ContextScanner + SkillScanner + BashClassifier，多层防护 | ✅ 已实现 |
| **提示词系统工程** | 模块化 Section 架构 + PromptManager + 缓存优化 | ✅ 已实现 |
| **静态/动态 Section 分离** | cachedPromptSection + volatilePromptSection + BOUNDARY 标记 | ✅ 已实现 |
| **Next.js → Vite 迁移** | 前端构建从 Next.js 14 迁移到 Vite 6 + Zero Router | ✅ 已完成 |
| **API Routes → IPC 迁移** | 从 HTTP API 迁移到 Electron IPC + MessagePort | ✅ 已完成 |
| **Gateway/Bridge 系统** | 外部平台接入（Telegram、微信等）| ✅ 已实现 |
| **自动化定时任务** | CronJob 调度器 + 执行历史 + 重试机制 | ✅ 已实现 |
| **日志系统** | 结构化日志 + 文件轮转 + 级别控制 | ✅ 已实现 |
| **自动更新** | electron-updater 集成，支持检查/下载/安装 | ✅ 已实现 |
| **浏览器扩展** | 浏览器守护进程 + 扩展通信 | ✅ 已实现 |

## 运行中用户消息：排队与引导

运行中再次发送用户消息有两条互斥的消费路径：

- **排队**：renderer 先写 `agent_mailbox`，同时把带 `queuedMailboxId` 的
  `StartStreamParams` 放入 `stream-session-manager.pendingMessages`。当前 run 的
  `done/error` 到达后，manager 按 FIFO 调用 `mailbox:promoteQueued`，再以新的
  `role=user` turn 启动下一条。已取消或已被 agent 吸收的行会被跳过，避免重复。
- **引导**：`mailbox:guide` 只给仍为 `pending` 的行标记
  `apply_mode=runtime_instruction`，不提前标记为 `applied`。Agent 在
  `before_model_turn` 和 `before_final_answer` 两个安全 checkpoint 执行
  `claimBatch`，把内容作为临时 runtime user guidance 注入当前 run；该临时包装
  不会持久化到普通消息历史。

关键文件：`src/components/chat/ChatView.tsx`、
`src/lib/stream-session-manager.ts`、`electron/db/mailbox-transitions.ts`、
`packages/agent/src/agent/DuyaAgent.ts`。

## Profile / Mode / Permission 三层正交（Plan 224）

DUYA 的"agent 配置"由三个正交层组合而成。每一层独立选择、互不干扰，最终在 `streamChat` 入口合成为一个完整的运行时配置。

### 三层职责

| 层 | 标识 | 来源 | 控制内容 |
|----|------|------|----------|
| **Profile** | `AgentProfile.id`（main / code / plan / …） | Agent Profile 选择器（侧栏顶部） | 基础工具集 + 基础 system prompt + 默认权限模式 |
| **Mode** | `ModeModifier.id`（plan-task / research / conductor） | 输入框 popover "Mode" 项 | 在 profile 之上叠加：注入/屏蔽工具、追加 prompt 前缀/后缀、注入 ToolUseContext 字段 |
| **Permission** | `PermissionMode`（ask / auto / bypass） | 权限选择器（输入框右侧） | 工具执行前的授权检查策略 |

三层的运行时合成由 `DuyaAgent.streamChat` 在 `_resolveAgentProfile` → `_buildSystemPrompt` → `applyModes` → `_buildPermissionContext` 顺序完成。Profile 与 Mode 通过 `applyModes` 合并工具集和 prompt；Permission 独立作用于 `canUseTool` 检查函数。

### ModeModifier 双范式架构

`ModeModifier` 接口（`packages/agent/src/modes/types.ts`）支持两种范式，一个 mode 选其一：

- **Modifier 范式**（声明式叠加）：声明 `tools` / `prompt` / `hooks`，由 `applyModes` 在 agent loop 之上组合。适合"修饰型" mode。示例：`conductor`（注入 11 个 canvas 工具 + 前置 prompt + 注入 canvasId）、`plan-task`（block 写工具 + 前置只读规划 prompt）、`research`（block 写工具 + canvas 工具 + 前置研究方法论 prompt）。
- **Orchestrator 范式**（接管整个 stream）：声明 `orchestrator.execute`，自己管 LLM 调用、工具执行、SSE 流、多阶段逻辑。适合"流程型" mode。（当前无 mode 使用此范式；`research` 已迁移为 Modifier 范式）

两种范式共享 `modeModifierRegistry` 的注册、互斥（`exclusiveWith`）、UI 元数据（`display`）机制。

### 互斥规则

`exclusiveWith` 字段定义两两互斥关系，对称声明：

- `plan-task` ↔ `research`、`conductor`（只读规划与所有写/接管 mode 冲突）
- `research` ↔ `plan-task`（不与 conductor 冲突 —— Research + Conductor 可叠加）
- `conductor` ↔ `plan-task`（不与 research 冲突）

前端 `src/types/mode-id.ts` 的 `MODE_EXCLUSIVE_WITH` 镜像此规则，供 popover 渲染"互斥"/"可叠加"提示与禁用态。

### 新增 Mode 标准流程（3 步）

1. 在 `packages/agent/src/modes/` 新建 `<mode>-mode.ts`，声明 `ModeModifier` 对象（modifier 或 orchestrator 范式）。
2. 在 `packages/agent/src/modes/index.ts` 调用 `modeModifierRegistry.register(<mode>);`。
3. 如需 UI 入口，在 `src/hooks/useSlashCommands.ts` 的 `modeItems` 数组追加一项（`kind: 'mode'`, `modeValue: '<id>'`），并在 `src/types/mode-id.ts` 的 `ModeModifierId` / `MODE_KIND` / `MODE_EXCLUSIVE_WITH` 补充对应条目。

无需改动 `DuyaAgent.streamChat` / `builtin.ts` —— `applyModes` 自动消费新注册的 modifier，`collectActiveModes` 自动转发 `options.mode` 字段。

### 关键文件

| 文件 | 作用 |
|------|------|
| `packages/agent/src/modes/types.ts` | `ModeModifier` / `ModeModifierContext` / `ResolvedMode` / `ToolRegistration` 类型定义 |
| `packages/agent/src/modes/registry.ts` | `ModeModifierRegistry`：注册 + `resolve(ids)` 合并互斥规则 |
| `packages/agent/src/modes/apply-modes.ts` | `applyModes`：单入口执行 onEnter hooks → prompt prefix/suffix → tools 合并 → toolUseContextPatch → beforeStream hooks；`collectActiveModes` 从 ChatOptions 提取激活 mode ids |
| `packages/agent/src/modes/conductor-mode.ts` | Conductor modifier（session 级，注入 canvas 工具） |
| `packages/agent/src/modes/plan-task-mode.ts` | Plan-task modifier（message 级，只读规划） |
| `packages/agent/src/modes/research-mode.ts` | Research modifier（message 级，prompt + tool block） |
| `src/types/mode-id.ts` | 前端镜像：`ModeModifierId` / `MODE_KIND` / `MODE_EXCLUSIVE_WITH` / `toggleModeInSet` / `isModeExcludedByActive` |
| `src/components/chat/SlashCommandPopover.tsx` | popover UI：activeModes 状态 + 互斥可视化 + conductor toggle 视觉 |
| `src/components/chat/MessageInput.tsx` | `activeModes: Set<ModeModifierId>` 统一状态 + conductor slot 与 DB 双向同步 |

## 按需工具发现（Plan 241）

`tool_search` 是一个让 LLM 在运行中查询可用工具的元入口。它和 Profile/Mode/Permission 三层**正交** —— 不参与权限/工具过滤决策,只负责"按需暴露工具元信息"。详见 [docs/exec-plans/active/241-on-demand-tool-discovery.md](./docs/exec-plans/active/241-on-demand-tool-discovery.md)。

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| Phase 1 | `tool_search` 接入 registry + 返回 schema 摘要(`inputSchemaSummary`/`exposeMode`) | ✅ 实施完成 (2026-07-24) |
| Phase 2 | `ToolRegistry.register` 持久化元信息,按 `exposeMode` 裁剪 LLM 请求的 tools 数组;~40 个 builtin 工具打档 | ✅ 实施完成 (2026-07-24) |
| Phase 3 | tool dispatch 循环按需把目标工具 schema 注入后续 turn | ✅ 实施完成 (2026-07-24) |

Phase 1 改动要点:`ToolMeta` 扩两个 optional 字段(`inputSchemaSummary`、`exposeMode`,均独立导出 `ExposeMode` 类型),`ToolSearchTool.execute` 的 result JSON 携带新字段,`DuyaAgent.streamChat` 在 normal / orchestrator 两个分支都通过 `toolSearchTool.setSearchFn(searchToolsFromRegistry)` 注入关键词搜索实现。

Phase 2 改动要点:`ToolRegistry.register` 重载接受第三参数 `ToolMetaInput`(`{ inputSchemaSummary?, exposeMode? }`),新增 `getMeta(name)` / `getExposeMode(name)` accessor(后者在未持久化时默认 `'always'`,向后兼容 MCP / plugin / 旧 builtin 路径);`searchToolsFromRegistry` 从 registry meta 字段填充 result 的 `exposeMode` / `inputSchemaSummary`;`createBuiltinRegistry` 给 ~40 个 builtin 工具打档(`always` 档:bash/read/write/edit/grep/glob/Agent/task/5 个 mode 控制/browser/Memory/SessionSearch/ToolSearch/AskUserQuestion;`discoverable` 档:canvas_\*/research_memory:\*/TeamCreate/Delete/MCP resource tools/messageSession/vision_analyze/show_widget/moduleTool/anchor_memory/skillManage/wiki_\*/duya_cli/skillTool/Brief);`DuyaAgent._resolveTools` 在 Layer 0/1/2 过滤之前按 `exposeMode !== 'internal'` 裁剪 baseTools。

Phase 3 改动要点:`DuyaAgent.streamChat` 维护 streamChat-local `discoveredTools: Set<string>`,每轮 while 开头把 `registry.getTool(name)` 合并到局部 `tools` 数组,实现"LLM 调 `tool_search` 后下一轮 LLM 请求的工具列表自动包含搜到的工具";扫描由 [packages/agent/src/agent/tool-search-discovery.ts](./packages/agent/src/agent/tool-search-discovery.ts) 提供 (`extractToolNamesFromSearchResult` + `harvestDiscoveredTools`),在每次 `executor.getRemainingResults()` 完成后从 messages 末尾 batch 抽取 `tool_search` 返回的 `results[].name`。边界:`Set` 自动去重;`registry.getTool(name)` 返回 undefined 时静默 skip(MCP server 断开 / plugin 卸载后);orchestrator (`research`) 路径的 `deps.toolRegistry` 也走 builtin registry,自动继承 Phase 2 裁剪。

27 个单测覆盖 Phase 1/2/3 全链路([packages/agent/tests/unit/ToolSearchTool.test.ts](./packages/agent/tests/unit/ToolSearchTool.test.ts) 17 条 + [packages/agent/tests/unit/tool-search-discovery.test.ts](./packages/agent/tests/unit/tool-search-discovery.test.ts) 10 条),全绿。

## 相关文档

- [AGENTS.md](./AGENTS.md) - 开发规则和流程
- [docs/SECURITY.md](./docs/SECURITY.md) - 安全架构与防护机制详解
- [docs/exec-plans/active/26-prompt-mode-architecture.md](./docs/exec-plans/active/26-prompt-mode-architecture.md) - PromptMode 架构设计
- [exec-plans/README](./docs/exec-plans/README.md) - 执行计划索引
- [electron_multi_agent_architecture.svg](./docs/design-docs/electron_multi_agent_architecture.svg) - 架构图（目标架构）
- [bridge-design](./docs/design-docs/bridge-design.md) - Bridge 组件详细设计

## Office Workspace

The chat side panel includes an `office` page for local DOCX, PPTX, and XLSX
files. It reuses the session-scoped `PanelProvider` tab model and opens files
from either the project file tree or a filtered Electron dialog.

- Renderer: `src/components/layout/panels/OfficePanel.tsx`
- IPC: `dialog:open-office-files` and the existing `parser:*` handlers
- Parser: `packages/agent/src/file-parser/`, including the XLSX OOXML parser
- Chat bridge: selected content dispatches existing file and text reference
  events, so MessageInput attaches the source path and structural locator
- Write path: the Agent edits the local file through existing tools and
  permission review; structured OOXML patch/backup APIs are deferred to Phase 2

## File Preview Workspace

The session panel is a generic expandable surface: any active sidebar page can
cover the chat canvas while the normal `MessageInput` remains above it as a
floating layer. File and Office previews are master/detail surfaces with the
read-only preview and collapsible project tree kept in one panel. `PanelProvider`
persists expanded state, tree visibility, preview tabs, and the active tab per
session.

- Shell: `src/components/layout/PanelZone.tsx`
- File split: `src/components/layout/panels/PanelFileTreeSplit.tsx`
- Preview page: `src/components/layout/panels/FilePreviewPanel.tsx`
- Project tree: `FileTreePanel` resolves relative tree entries against the
  session working directory and opens either `preview` or `office` tabs
- Preview IPC: `files:preview(targetPath, rootPath)` resolves real paths and
  rejects targets outside the project root, truncates text at 1 MB, and caps
  image/PDF payloads at 12 MB
- Supported inline previews: Markdown, text/code, images, and PDF; DOCX, PPTX,
  and XLSX continue through the Office workspace
- Chat bridge: files and selected preview text reuse the existing
  `file-tree-add-to-input` and `browser-add-to-input` events

## Automation (CronJob) Phase 1

DUYA now includes a Phase 1 CronJob foundation in Electron Main Process:

- **Scheduler location**: `electron/automation/Scheduler.ts`
- **Storage tables**: `automation_crons`, `automation_cron_runs` (SQLite, main-process single writer)
- **Execution target**: fixed to **isolated** session (`session_target = 'isolated'`)
- **Delivery mode**: fixed to **none** (`delivery_mode = 'none'`, run history only)
- **IPC APIs**:
  - `automation:cron:list`
  - `automation:cron:create`
  - `automation:cron:update`
  - `automation:cron:delete`
  - `automation:cron:run`
  - `automation:cron:runs`

### Scheduler behavior

- Supports schedule kinds: `at`, `every`, `cron` (with optional IANA timezone).
- Renderer presets (hourly, daily, weekdays, weekly, monthly, custom, once) compile into the same `at` / `cron` contract; existing non-preset expressions remain editable as Custom.
- Repeating schedules can persist `schedule_end_at`; next-run calculation refuses candidates after that boundary and disables exhausted jobs.
- Supports concurrency policies: `skip`, `parallel`, `queue`, `replace`.
- Uses in-memory running state + DB run state tracking.
- Uses retry with default backoff `[30s, 60s, 300s]` and default `max_retries = 3`.
- Startup isolates invalid stored schedules instead of aborting the scheduler, and long waits are re-armed in safe `setTimeout` segments.
- Cron sessions default to `~/.duya/workspace`, create that directory before Agent init, and never fall back to the Electron process cwd.
- Agent readiness is subscribed before `init`; failed `init` and `chat:start` sends fail the run instead of waiting for a timeout.

### Frontend entry

- Sidebar adds **Automation** navigation.
- View: `src/components/automation/AutomationView.tsx`
- Shared frequency UI: `src/components/automation/CronScheduleCard.tsx`
- Preset adapter and next-run preview: `src/components/automation/cron-schedule.ts`
- Renderer IPC wrapper: `src/lib/automation-ipc.ts`

## Conductor connector geometry

Connector records persist semantic geometry rather than SVG paths. A current endpoint is either bound (`{ kind: 'bound', nodeId, bindingPoint: { u, v } }`) or free (`{ kind: 'free', point: { x, y } }`). Bound `u/v` coordinates identify a quantized reference inside the element. Elbow routing projects that reference perpendicularly onto its nearest rectangular edge; curve routing instead defines the complete path between the two references and clips only the portions inside the bound endpoint rectangles. The curve arrow tangent therefore continues toward its reference rather than following an elbow edge normal. References are independent of the opposite endpoint and peer connectors. Legacy `nodeId + anchorId + edgePosition` records remain readable. Elbow routes persist editable waypoints. Curve routes start with a straight three-control topology and persist a midpoint-relative offset plus two endpoint-relative controls after the midpoint is moved. The renderer recomputes paths from current node bounds. Connector stroke width is fixed at 3.5 px; users can change routing, stroke pattern, color, markers, and label text.

Agent-created editable diagrams default to elbow routing. Architecture fan-out/fan-in guidance aligns sibling nodes and uses direct semantic connectors whose overlapping orthogonal segments form a shared trunk/bus with short terminal branches; curve routing is an explicit organic-style exception.

Dragging any elbow segment uses zoom-aware screen-space snapping against nearby parallel segments from other elbow connectors. Internal segments translate normally; terminal segments insert an orthogonal dogleg so neither endpoint reference changes. Mixed horizontal/vertical endpoint routes connect the two exterior stubs before entering either bound edge. Endpoints facing the same direction use their shared outermost lane, and obstacle routing may only push that lane farther outward. These constraints prevent the middle route from crossing an endpoint element. Only spatially related segment ranges participate, so shared trunks can become exactly collinear without pulling toward unrelated routes. Default arrow markers use compact convex geometry aligned with the terminal route; the visible stroke is trimmed to the filled head's base so the terminal reads as one continuous shape.

## Conductor knowledge workspace

The Conductor canvas is a project knowledge workspace, not a sticky-note board.
Each canvas is bound to one project folder (`conductor_canvases.project_path`); a
canvas created from a session inherits that session's working directory, while a
standalone canvas prompts for a project folder.

- `native/document` is a Markdown source element. New documents are written to
  `<project>/.duya/canvas/<element-id>.md`; imported documents must be an `.md`
  file inside the same project. The canvas keeps a project-relative path plus a
  render snapshot, and both user edits and Agent `element.update_content`
  changes synchronously write the Markdown file.
- `native/shape` is the diagram primitive for frameworks, timelines, map
annotations, and flowcharts. `native/sticky` remains renderable only for
existing boards and must not be used for new diagrams.
- `native/table` is a canvas-native, individually editable grid. Its compact
  `{ title, headers, rows }` config is persisted through `element.update_content`.
- Files, PDFs, and images remain source-material elements. Text documents
  supply nearby notes/drafts, shapes and connectors express interpretation,
  and `native/link` connects canvases and sessions into a homepage canvas.
- Canvas document/import menus reuse the chat input command-popover surface
  (`--command-menu-*` variables and `conductor-popover-item`) so settings and
  canvas controls have one visual language.
- Canvas element selection toolbars share the connector-style capsule surface.
  Their More menu persists `metadata.locked` through `element.update`; locked
  elements remain selectable and editable, but direct drag, resize, connector
  geometry handles, and group movement cannot change their position.

### Project-local databases

Conductor database elements use a project-owned SQLite database at
`<project>/.duya/database.sqlite`. This is separate from DUYA's application
database: project data travels with the project folder, while application
sessions and canvas metadata remain in `duya-main.db`.

`electron/project-database/worker.ts` is the sole SQLite connection owner.
Renderer requests arrive through the typed preload API; Agent requests arrive
as `database.execute` commands through the Conductor executor proxy. Both paths
are validated by the shared command schemas before reaching the engine.

The normalized model separates sources, stable property and option IDs,
records, typed values, saved views, and per-view record positions. Records use
optimistic revisions and mutations append events for renderer invalidation and
audit. Archive flags preserve stable references instead of hard-deleting rows.

A `native/database` canvas element stores only `sourceId`, `viewId`, and display
preferences. It never embeds record data or a filesystem path. `native/table`
remains the lightweight self-contained grid for small static datasets. New view
renderers such as board and calendar must reuse the same source/record model
rather than create parallel storage.

### Canvas presentation modes

One Conductor canvas can be rendered through two view-local presentation modes.
The standalone Conductor view defaults to the existing infinite **Canvas** mode;
the sidebar defaults to finite **Document** mode. Switching modes does not create
or copy elements.

Document mode uses an explicit content allowlist on a finite twelve-column
surface. `native/document`, `native/table`, and `native/link` participate in a
vertically compacted drag/resize grid. Their widget geometry is persisted under
`conductor_canvases.layout_config.finiteWidgetLayout`, so it never overwrites
the canonical `CanvasElement.position` used by Canvas mode. `native/text`,
`native/image`, and `native/file` use a separate non-compacting layer and remain
independently draggable. Every other element family, including shapes,
stickies, mind maps, databases, generic widgets, connectors, and groups, is
Canvas-only until it is intentionally added to the document-mode contract.

Both modes reuse `ElementRenderer`, native editing sessions, selection state,
and content persistence. Presentation code owns only placement and viewport
behavior; it must not fork element content or editing contracts.

### Native element capability contract

Native renderer behavior is declared by
`packages/conductor/src/renderer/components/native/native-element-capabilities.ts`.
Each element kind declares its edit mode, selection-toolbar family, resize
handles, chrome ownership, and whether creation should enter editing. Renderer,
chrome, and canvas creation code consume this registry; they must not maintain
parallel element-kind lists. Non-editable elements such as images, files, and
links never enter `editingElementId` on double-click.

Text-like editors share `useElementEditSession` for focus, IME composition,
blur-save, Escape-cancel, Ctrl/Cmd+Enter-save, and external editing-state exits.
Config writes use `useElementPersistence`, which applies optimistic renderer
state and performs a stale-safe rollback if persistence fails. Element-specific
components only translate their local draft into config/position patches.

### Agent scene grammar

Complex canvas results are editable native-element scenes. The on-demand
`scene-blueprints` knowledge section defines spatial grammars for architecture
diagrams, timelines/roadmaps, project outlines, and knowledge homepages. The
Agent chooses one primary blueprint, creates the scene skeleton before details,
adds connectors last, then captures and refines the result. `widget/dynamic`
remains a compact auxiliary component and cannot replace a multi-element scene.

## Conductor multi-canvas target contract (Plan 233)

Conductor mode binds a chat session to one current canvas through
`chat_sessions.conductor_canvas_id`, but the workspace may contain many
canvases. The `canvas_manage` tool is the canvas-level control surface:
`get_current`, `list`, `create`, `switch`, and `rename`. Element tools never
accept a model-provided canvas ID; they resolve the current target from the
shared `ToolUseContext.canvasTarget` object.

A successful switch has three synchronized effects:

1. mutate `canvasTarget` so later tool calls in the same Agent turn use the
   new canvas and clear cross-canvas freshness state;
2. persist the new ID to `chat_sessions.conductor_canvas_id` through
   `ConductorExecutorProxy`;
3. publish `conductor:canvas:changed` so the conversation store and frozen
   sidebar Conductor tab follow the new target immediately.

Canvas identity is therefore durable session state, while element state
remains scoped to the selected canvas. Renderer state is never the sole source
of truth for Agent target selection.

## Background SubAgent lifecycle

- `SubagentTool` returns a launch receipt immediately with `background: true`
  and `status: running`. A successful tool invocation means the sub-agent was
  dispatched; it does not mean the delegated task completed.
- `BackgroundAgentLifecycle` owns the terminal `completed` / `failed` /
  `killed` transition and enqueues exactly one `<task-notification>` for the
  parent session.
- `DuyaAgent` only performs non-blocking notification drains. When a terminal
  notification arrives after the parent turn has ended, the worker emits
  `chat:background_task_ready`; Electron relays it to the renderer, which
  starts an empty `backgroundTaskResume` SSE turn. That turn drains the queued
  notification without persisting a synthetic empty user message. Wakeups that
  race the prior SSE terminal event are deferred until that stream is terminal.
- Renderer status is driven by the sub-agent's own `agent_progress` terminal
  event, not by the parent stream phase or the Agent tool launch receipt.
- Live sub-agent rows are consolidated in the TaskDrawer; the chat composer
  does not render a separate expanding sub-agent panel.

## Tool-history integrity

`messages.seq_index` is the durable ordering key for a session; message reads
use it before timestamps, and every rewritten history receives a contiguous
sequence. A completed tool round contains one logical assistant turn, with one
or more `tool_use` blocks, followed immediately by its `tool_result` blocks in
the same call order. The Agent normalizes complete legacy rounds before a
provider request or persistence, so a corrected canvas tool call cannot leave
strict Anthropic-compatible providers with an invalid history.
