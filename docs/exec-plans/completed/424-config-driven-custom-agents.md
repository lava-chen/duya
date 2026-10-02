# 424 配置化自定义 Agent（config.toml 驱动，对齐 openclaw）

> **For agentic workers:** 用 `executing-plans` 逐 task 实现。步骤使用 checkbox（`- [ ]`）追踪。
> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-08-13
> **Depends on**: 334（config.toml 统一）、408（AGENTS.md 注入）、`420-agent-profile-completion`（**作废**，被本 plan 取代）

---

## 背景与诊断（已核实）

用户自定义 agent profile 的**最终形态**：不落 DB，全部从 `~/.duya/config.toml` 读取；每个自定义 agent 有独立的全局指令（AGENTS.md / 系统提示词配置路径）与独立 workspace；config 里只需写 `model`、`workspace`、系统提示词配置路径、工具配置 + 插件配置数组。参考实现：`E:\cloned-projects\openclaw`（`agents.list[]` 每个 entry 含 `workspace/agentDir/model/tools`，workspace 内 bootstrap 文件注入 system prompt）。

**现状（已核实）：**
- config.toml 单一权威源：[electron/config/schema.ts](electron/config/schema.ts) `DuyaConfig` + [electron/config/store.ts](electron/config/store.ts)（dotted-path 读写 + disk hot-reload + FLAT_TO_PATH 平面映射）。**尚无 `agents` section**。
- agent 进程可直接读 config.toml（已存在先例）：[packages/agent/src/mcp/config.ts:85](packages/agent/src/mcp/config.ts) `readUserMcpToml()` 直接读 `~/.duya/config.toml`。
- AGENTS.md 按 系统→用户→项目→本地 注入，项目级绑定会话 workspace：[packages/agent/src/agentsmd/loader.ts](packages/agent/src/agentsmd/loader.ts) + [manager.ts](packages/agent/src/agentsmd/manager.ts)（`refreshForTask(projectPath)`），最终在 [packages/agent/src/agent/session/agent-shell.ts:143-214](packages/agent/src/agent/session/agent-shell.ts) `buildSystemPrompt` 注入。
- 会话创建时 model / working_directory / agent_profile_id 由前端传入：[src/components/chat/NewChatView.tsx:291-297](src/components/chat/NewChatView.tsx) `createThread({ workingDirectory, model, agentProfileId, ... })`。
- agent 运行时 `_resolveAgentProfile`（[packages/agent/src/agent/DuyaAgent.ts:1989](packages/agent/src/agent/DuyaAgent.ts)）只查 in-memory presets（general/code/research），自定义 id 查不到 → 静默忽略。

**两个弃用方向（工作区已有未提交代码，Task 1 回退）：**
- 上一轮为"DB 存储自定义 profile"加的：db-bridge `agentProfile:list`、db-client `agentProfileDb`、`ensureCustomAgentProfilesLoaded`、DuyaAgent async 化、迁移 51 之后新增的迁移 52 `identity_prompt` 列、types/AgentProfileService/db-handlers/前端 `identity_prompt` 序列化。这些在 config 方案下是死代码，全部回退。
- 旧 plan 420 `agent-profile-completion.md`（DB CRUD UI + prompt_profile 持久化）整篇作废。

**保留**：`kind` 分组拆分（main/subagent/special）+ 迁移 51（用户已批准的结构化改造）。

---

## 设计目标

让"用户自定义 agent"完全由 `config.toml` 驱动：主进程/前端/agent 运行时三侧都从 config 读取，每个自定义 agent 有独立 workspace + 全局指令文件，`model` 覆盖会话模型，`tools`/`plugins` 决定工具面。不破坏现有 3 个预设、不引入 DB 写入。

**Architecture:** 四层。
- **配置层**：`DuyaConfig.agents: Record<string, CustomAgentConfig>`（map，与 `mcp_servers`/`plugins` 风格一致），默认 `{}`。
- **读侧（主进程/前端）**：新增 renderer IPC `config:agents:list`（读 ConfigStore），前端 picker 把自定义 agent 与 3 个预设合并展示；选自定义 agent 建会话时用其 `model`/`workspace` 覆盖。
- **读侧（agent 运行时）**：`_resolveAgentProfile` 对非预设 id 直接读 `~/.duya/config.toml` 的 `agents.<id>`，构建等价 `AgentProfile`（tools→allow/deny，identity/global 来自 `agents_md` 文件），并在 system prompt 注入该 agent 的全局指令块。
- **回退**：Task 1 清理 DB 方向死代码。

**Tech Stack:** TypeScript + @iarna/toml + React 19 + better-sqlite3 + Vitest + Playwright MCP。

**约定（沿用 AGENTS.md / 用户偏好）：**
- 跑 Vitest 前先 `npm run rebuild:node`。
- 提交 Conventional Commits（英文）；代码注释英文。
- UI 改动必须 Playwright MCP 验证。
- `npm run typecheck:all` 通过后才能 commit。

---

## 文件结构

| 路径 | 职责 | 动作 |
|------|------|------|
| `electron/agents/db-bridge.ts` | 移除 `agentProfile:list` action | 修改（回退） |
| `packages/agent/src/ipc/db-client.ts` | 移除 `agentProfileDb` | 修改（回退） |
| `packages/agent/src/agent-profile/AgentProfileService.ts` | 移除 `ensureCustomAgentProfilesLoaded`/`customProfilesSync`/logger 导入/`identity_prompt` 序列化 | 修改（回退） |
| `packages/agent/src/agent-profile/types.ts` | 移除 `AgentProfileDbRow.identity_prompt`；`identityPrompt` 注释还原 | 修改（回退） |
| `packages/agent/src/agent/DuyaAgent.ts` | `_resolveAgentProfile` 还原为 sync（Task 5 再改回 async） | 修改（回退） |
| `electron/db/schema.ts` | 移除迁移 52 `identity_prompt` 列；保留迁移 51 | 修改（回退） |
| `electron/ipc/db-handlers.ts` | 移除 create/update 的 `identity_prompt` | 修改（回退） |
| `src/lib/agent-profile-ipc.ts` | 移除 `identityPrompt`/`profile_kind` 之外新增的 `identityPrompt` 解析（还原为仅 kind） | 修改（回退） |
| `electron/config/schema.ts` | `CustomAgentConfig` 接口 + `DuyaConfig.agents` + DEFAULT_CONFIG | 修改 |
| `electron/config/store.ts` | `FLAT_TO_PATH` 增 `customAgents: 'agents'`（renderer 平面读） | 修改 |
| `electron/ipc/db-handlers.ts` | 新增 renderer IPC `config:agents:list` | 修改 |
| `electron/preload.ts` | `configAgents.list()` 暴露 | 修改 |
| `src/lib/agent-profile-ipc.ts` | `listCustomAgents()`（调新 IPC，转成 `AgentProfile` 兼容形） | 修改 |
| `src/components/chat/AgentProfileSelector.tsx` | picker 合并自定义 agent | 修改 |
| `src/components/chat/AgentModeSelector.tsx` | 快捷选择合并自定义 agent（保留 3 预设位） | 修改 |
| `src/components/settings/AgentsSection.tsx` | 只读展示自定义 agent + "去 config.toml 编辑"提示 | 修改 |
| `src/components/chat/NewChatView.tsx` | 选自定义 agent 时用其 model/workspace 覆盖建会话参数 | 修改 |
| `packages/agent/src/agent-profile/config-agents.ts` | `readConfigAgents()` / `toAgentProfile()`：读 config.toml `agents` + 展开路径 + 读 `agents_md` 文件 | 新建 |
| `packages/agent/src/agent-profile/types.ts` | `AgentProfile` 增可选 `globalInstructions` | 修改 |
| `packages/agent/src/agent/DuyaAgent.ts` | `_resolveAgentProfile` 改为 async，非预设走 `readConfigAgents` | 修改 |
| `packages/agent/src/agent/session/agent-shell.ts` | `buildSystemPrompt` 注入 `globalInstructions`（`<system-reminder>` 块） | 修改 |
| `docs/exec-plans/README.md` | 注册 424；420 标记 superseded | 修改 |

**测试文件：**
- `packages/agent/tests/unit/agent-profile/config-agents.test.ts`（新建）
- `src/lib/__tests__/agent-profile-ipc.test.ts`（新建，覆盖 listCustomAgents 解析）
- `electron/ipc/__tests__/config-agents.test.ts`（新建，`config:agents:list` handler）

---

## config.toml 示例（最终形态）

```toml
# 自定义 agent profile：key 即 agent id（会话 agent_profile_id 用它）
[agents."frontend-expert"]
name = "Frontend Expert"
description = "前端专家，专注 React/TS"
model = "anthropic/claude-sonnet-4-20250514"   # 覆盖会话模型（可省略 → 回退默认）
workspace = "~/duya-workspaces/frontend"        # 该 agent 自己的工作目录
agents_md = "~/.duya/agents/frontend-expert/AGENTS.md"  # 系统提示词配置路径（可省略 → 默认 <workspace>/AGENTS.md）
tools = { profile = "coding", allow = ["file:*", "search:*"], deny = ["browser"] }
plugins = ["mcp:github", "frontend-toolkit"]    # 插件配置数组（本 plan 只暴露，生效为 follow-up）
```

字段 → 落地映射：

| config 字段 | openclaw 对应 | 消费点 |
|---|---|---|
| `id`（map key） | `AgentConfig.id` | 会话 `agent_profile_id` |
| `name`/`description` | 同名 | picker / badge / identity 块 |
| `model` | `AgentConfig.model` | 新建会话 `session.model` 覆盖 |
| `workspace` | `AgentConfig.workspace` | 新建会话 `working_directory` → 项目级 AGENTS.md 自动绑定 |
| `agents_md` | `agentDir`+bootstrap | agent 运行时读文件 → `globalInstructions` 注入 system prompt |
| `tools` | `AgentToolsConfig.profile/allow/deny` | → `allowedTools`/`disallowedTools`（走 ToolFilter） |
| `plugins` | 插件启用数组 | 本 plan 仅存储+暴露；per-agent MCP 门控为 follow-up（现有 `McpServerEntry.allowedAgentIds` 可承载） |

---

## Task 1：回退 DB 方向死代码

**Files:**
- Modify: `electron/agents/db-bridge.ts`、`packages/agent/src/ipc/db-client.ts`、`packages/agent/src/agent-profile/AgentProfileService.ts`、`packages/agent/src/agent-profile/types.ts`、`packages/agent/src/agent/DuyaAgent.ts`、`electron/db/schema.ts`、`electron/ipc/db-handlers.ts`、`src/lib/agent-profile-ipc.ts`

- [ ] **Step 1.1: db-bridge 移除 `agentProfile:list`**

删除 `electron/agents/db-bridge.ts` 中新增的 `case 'agentProfile:list': { ... }` 块（含注释）。用 `git diff electron/agents/db-bridge.ts` 确认只剩原有代码。

- [ ] **Step 1.2: db-client 移除 `agentProfileDb`**

删除 `packages/agent/src/ipc/db-client.ts` 中新增的 `export const agentProfileDb = {...}` 及其注释块。

- [ ] **Step 1.3: AgentProfileService 移除同步入口与 identity_prompt 序列化**

在 `packages/agent/src/agent-profile/AgentProfileService.ts`：
1. 删除文件顶部 `import { logger } from '../utils/logger.js';`
2. 删除 `rowToAgentProfile` 里的 `identityPrompt: row.identity_prompt ?? undefined,` 行
3. 删除 `profileToRow` 里的 `identity_prompt: profile.identityPrompt ?? null,` 行
4. 删除 `ensureCustomAgentProfilesLoaded` 函数 + `customProfilesSync` 变量 + 整段 "Custom profile sync" 注释块

- [ ] **Step 1.4: types.ts 还原 identity_prompt**

`packages/agent/src/agent-profile/types.ts`：
1. `AgentProfileDbRow` 删除 `identity_prompt: string | null;`
2. `identityPrompt` 的 JSDoc 注释还原为"Preset-only field (not persisted to the DB)"原文

- [ ] **Step 1.5: DuyaAgent 还原 sync**

`packages/agent/src/agent/DuyaAgent.ts`：
1. 导入改回 `import { getAgentProfileService } from '../agent-profile/AgentProfileService.js';`
2. `_resolveAgentProfile` 还原为 `private _resolveAgentProfile(options?: ChatOptions): AgentProfile | undefined`（同步、删除 ensure 调用）；两处调用点还原为不带 `await`

- [ ] **Step 1.6: schema.ts 移除迁移 52**

`electron/db/schema.ts`：删除迁移 id 52 `add_identity_prompt_to_agent_profiles`；基础 CREATE TABLE 里 `identity_prompt TEXT,` 行一并删除。保留迁移 51 与 `profile_kind`。

- [ ] **Step 1.7: db-handlers 移除 identity_prompt**

`electron/ipc/db-handlers.ts`：create 的 INSERT 列/值、update 的 `fieldMap` 中 `identity_prompt`/`profile_kind` 里属于上一轮新增的部分——`identity_prompt` 移除；`profile_kind` 是 Task 1 之前用户批准的，**保留**。

- [ ] **Step 1.8: 前端 agent-profile-ipc 还原**

`src/lib/agent-profile-ipc.ts`：删除 `identityPrompt` 字段/解析；保留 `kind`。

- [ ] **Step 1.9: 校验回退干净**

```bash
git diff --stat electron/agents/db-bridge.ts packages/agent/src/ipc/db-client.ts packages/agent/src/agent-profile/AgentProfileService.ts packages/agent/src/agent-profile/types.ts packages/agent/src/agent/DuyaAgent.ts electron/db/schema.ts electron/ipc/db-handlers.ts src/lib/agent-profile-ipc.ts
```
Expected：diff 只剩 `kind`/`profile_kind` 相关（用户已批准的）与无关既有改动。

- [ ] **Step 1.10: 回归 agent 单测**

```bash
npm run rebuild:node && npx vitest run packages/agent/tests/unit/agent-profile packages/agent/src/agent-profile/__tests__
```
Expected：直接覆盖的测试全 PASS（`subagentProfilePrompt` 既有失败与本 plan 无关，见任务末尾说明）。

---

## Task 2：config schema 增加 `agents` 段

**Files:**
- Modify: `electron/config/schema.ts`

- [ ] **Step 2.1: 新增 `CustomAgentConfig` 接口**

在 `electron/config/schema.ts` 的 `AgentConfig` 之后新增：

```ts
/** [agents.<id>] — user-defined agent profile driven entirely by config.toml.
 *  id (map key) is the agent_profile_id used by sessions. Mirrors the
 *  openclaw AgentConfig surface (workspace / model / tools), kept minimal:
 *  model / workspace / system-prompt path / tools / plugins. */
export interface CustomAgentToolsConfig {
  /** Base tool profile: 'full' | 'coding' | 'minimal' | 'research' (maps to allow/deny presets). */
  profile?: string;
  /** Additional allowed tool patterns (wildcards supported, e.g. 'file:*'). */
  allow?: string[];
  /** Denied tool patterns; deny wins. */
  deny?: string[];
}

export interface CustomAgentConfig {
  /** Display name (falls back to the map key). */
  name?: string;
  /** One-line role description. */
  description?: string;
  /** Provider/model ref, e.g. 'anthropic/claude-sonnet-4-20250514'. Empty → fallback to config.model.default. */
  model?: string;
  /** This agent's own working directory. Empty → default workspace (~/.duya/workspace). */
  workspace?: string;
  /** Path to this agent's global instruction file (系统提示词配置路径). Empty → <workspace>/AGENTS.md. */
  agents_md?: string;
  /** Tool allow/deny/profile. */
  tools?: CustomAgentToolsConfig;
  /** Plugin / mcp references enabled for this agent (e.g. 'mcp:github'). */
  plugins?: string[];
}
```

- [ ] **Step 2.2: `DuyaConfig` 加 `agents` 字段**

`DuyaConfig` 接口 `personalities: Record<string, unknown>;` 之后加：

```ts
  /** [agents.<id>] — config-driven custom agent profiles (Plan 424). */
  agents: Record<string, CustomAgentConfig>;
```

- [ ] **Step 2.3: DEFAULT_CONFIG 加默认值**

`DEFAULT_CONFIG` 里 `personalities: {},` 之后加 `agents: {},`。

- [ ] **Step 2.4: 类型检查**

Run: `npx tsc --noEmit -p electron/tsconfig.json 2>&1 | Select-String -Pattern "config/schema"`（只看本文件相关错误）
Expected：无本文件新增错误（仓库既有 db-bridge 等错误与本任务无关）。

---

## Task 3：主进程 IPC 暴露 config agents

**Files:**
- Modify: `electron/ipc/db-handlers.ts`、`electron/preload.ts`、`electron/config/store.ts`

- [ ] **Step 3.1: FLAT_TO_PATH 加 `customAgents`**

`electron/config/store.ts` 的 `FLAT_TO_PATH` 加一行：

```ts
  customAgents: 'agents',
```

（renderer 通过 config port 的 `config:get 'customAgents'` 也能拿到；下面仍加专用 IPC 供直接调用。）

- [ ] **Step 3.2: 新增 renderer IPC `config:agents:list`**

在 `electron/ipc/db-handlers.ts` 的 Agent Profile handlers 段之后新增：

```ts
  // Plan 424: expose config-driven custom agent profiles to the renderer.
  ipcMain.handle('config:agents:list', () => {
    const { getConfigStore } = require('../config/store-instance') as typeof import('../config/store-instance');
    const store = getConfigStore();
    return store.getByPath('agents') ?? {};
  });
```

> 注：先确认 `electron/config/store-instance.ts` 导出 `getConfigStore()`（db-bridge 已用 `getConfigStore`，路径 `../config/store-instance`）。若 handler 所在文件已能 import，改用静态 import。

- [ ] **Step 3.3: preload 暴露 `configAgents`**

`electron/preload.ts` 的 `agentProfile` 对象旁新增：

```ts
  configAgents: {
    list: () => ipcRenderer.invoke('config:agents:list'),
  },
```

并在 `AgentProfileAPI` 同级的 exposed API 类型里声明 `configAgents: { list(): Promise<Record<string, unknown>> }`。

- [ ] **Step 3.4: 类型检查**

Run: `npx tsc --noEmit -p electron/tsconfig.json 2>&1 | Select-String -Pattern "db-handlers|preload"`
Expected：本任务文件无新增错误。

---

## Task 4：agent 包 config-agents 读取器

**Files:**
- Create: `packages/agent/src/agent-profile/config-agents.ts`
- Test: `packages/agent/tests/unit/agent-profile/config-agents.test.ts`

- [ ] **Step 4.1: 写失败测试**

新建 `packages/agent/tests/unit/agent-profile/config-agents.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { readConfigAgents, resolveAgentConfig, toAgentProfile } from '../../../src/agent-profile/config-agents.js';

// 用临时 HOME/.duya 目录，注入 DUYA_TEST_NAMESPACE 或用环境变量覆盖 config 根。
// 具体按 readConfigAgents 的设计（见 Step 4.2）写：支持 DUYA_CONFIG_AGENTS 或测试根覆盖。
```

测试用例：
1. `readConfigAgents()` 无 config 时返回 `{}`。
2. 有 `[agents."foo"]` 时返回 map，含 name/model/workspace/tools/plugins。
3. `toAgentProfile('foo', entry)`：`kind==='main'`、`userVisible===true`、`isPreset===false`、`allowedTools` 由 `tools.allow` + `profile` 映射得到、`disallowedTools` 由 `tools.deny` 得到。
4. `globalInstructions`：`agents_md` 指向的临时文件内容被读入（不存在则 undefined）。

Run: `npm run rebuild:node && npx vitest run packages/agent/tests/unit/agent-profile/config-agents.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4.2: 实现 `config-agents.ts`**

新建 `packages/agent/src/agent-profile/config-agents.ts`：

```ts
/**
 * Config-driven custom agent profiles (Plan 424).
 * Reads `~/.duya/config.toml` -> `[agents.<id>]` and builds an `AgentProfile`
 * descriptor for the runtime. Mirrors `readUserMcpToml` (mcp/config.ts): the
 * worker reads config.toml directly, no main-process round trip.
 */
import * as os from 'os';
import * as path from 'path';
import { readFile } from 'fs/promises';
import { parse as parseToml } from '@iarna/toml';
import type { AgentProfile } from './types.js';

export interface CustomAgentToolsConfig {
  profile?: string;
  allow?: string[];
  deny?: string[];
}

export interface CustomAgentConfig {
  name?: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: CustomAgentToolsConfig;
  plugins?: string[];
}

/** Base tool profiles -> allow/deny pattern lists (subset of legacy tool_profiles). */
const TOOL_PROFILE_MAP: Record<string, { allow: string[]; deny: string[] }> = {
  full: { allow: ['*'], deny: [] },
  coding: { allow: ['file:*', 'search:*', 'exec:*', 'process:*', 'git:*'], deny: ['browser:*', 'gateway:*'] },
  minimal: { allow: ['read', 'glob', 'grep', 'search:*'], deny: ['write', 'edit', 'exec:*', 'browser:*', 'gateway:*'] },
  research: { allow: ['file:read*', 'search:*', 'browser:*'], deny: ['file:write*', 'file:edit*', 'exec:*'] },
};

/** Config root: ~/.duya (or test-namespaced dir under DUYA_TEST). */
function resolveConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

function expandPath(p: string | undefined, baseDir?: string): string | undefined {
  if (!p) return undefined;
  let out = p;
  if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] || '');
  if (baseDir && !path.isAbsolute(out)) out = path.resolve(baseDir, out);
  return out;
}

/** Read all config-driven custom agents from config.toml. */
export async function readConfigAgents(): Promise<Record<string, CustomAgentConfig>> {
  try {
    const filePath = path.join(resolveConfigRoot(), 'config.toml');
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseToml(raw) as { agents?: Record<string, unknown> };
    return (parsed.agents ?? {}) as Record<string, CustomAgentConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Resolve one config agent entry (expand paths). */
export function resolveAgentConfig(id: string, entry: CustomAgentConfig): CustomAgentConfig {
  return {
    ...entry,
    workspace: expandPath(entry.workspace) ?? expandPath(process.env.DUYA_DEFAULT_WORKSPACE) ?? path.join(os.homedir(), '.duya', 'workspace'),
    agents_md: expandPath(entry.agents_md) ?? (entry.workspace ? path.join(expandPath(entry.workspace)!, 'AGENTS.md') : undefined),
  };
}

/** Build an `AgentProfile` descriptor from a config entry. */
export async function toAgentProfile(id: string, entry: CustomAgentConfig): Promise<AgentProfile> {
  const resolved = resolveAgentConfig(id, entry);
  const tools = entry.tools ?? {};
  const base = TOOL_PROFILE_MAP[tools.profile ?? 'full'] ?? TOOL_PROFILE_MAP.full;
  const allow = tools.allow && tools.allow.length ? tools.allow : base.allow;
  const deny = [...base.deny, ...(tools.deny ?? [])];

  let globalInstructions: string | undefined;
  if (resolved.agents_md) {
    try {
      globalInstructions = await readFile(resolved.agents_md, 'utf8');
    } catch {
      // missing file is fine — no agent global instructions
    }
  }

  return {
    id,
    name: entry.name || id,
    description: entry.description,
    allowedTools: allow,
    disallowedTools: deny,
    defaultModel: entry.model,
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    globalInstructions,
    createdAt: 0,
    updatedAt: 0,
  };
}
```

> **设计取舍**：`toAgentProfile` 是 async（要读 `agents_md` 文件）。`tools.profile` 用 `TOOL_PROFILE_MAP` 映射为 allow/deny（对齐旧 tool_profiles 语义），`allow` 显式配置覆盖 profile 的 allow。

- [ ] **Step 4.3: types.ts 增 `globalInstructions`**

`packages/agent/src/agent-profile/types.ts` 的 `AgentProfile` 接口，`identityPrompt` 之后加：

```ts
  /** Optional full agent global instructions (loaded from config `agents_md`),
   *  injected as an extra <system-reminder> block. Config-driven custom
   *  agents only; not persisted to the DB. */
  globalInstructions?: string;
```

- [ ] **Step 4.4: 重跑测试，确认通过**

Run: 同 4.1
Expected: PASS

---

## Task 5：agent 运行时解析 config agent + 注入全局指令

**Files:**
- Modify: `packages/agent/src/agent/DuyaAgent.ts`、`packages/agent/src/agent/session/agent-shell.ts`

- [ ] **Step 5.1: `_resolveAgentProfile` 改为 async 走 config**

`packages/agent/src/agent/DuyaAgent.ts`：

```ts
import { getAgentProfileService } from '../agent-profile/AgentProfileService.js';
import { readConfigAgents, toAgentProfile } from '../agent-profile/config-agents.js';
```

把 `_resolveAgentProfile` 改为：

```ts
  private async _resolveAgentProfile(options?: ChatOptions): Promise<AgentProfile | undefined> {
    if (!options?.agentProfileId) return undefined;
    const preset = getAgentProfileService().get(options.agentProfileId);
    if (preset) {
      logger.info(`[Agent] Applying agent profile: ${preset.name} (${preset.id}), promptSystem=${preset.promptSystem || 'general'}`);
      return preset;
    }
    // Config-driven custom agents (Plan 424): read [agents.<id>] from config.toml.
    try {
      const agents = await readConfigAgents();
      const entry = agents[options.agentProfileId];
      if (!entry) {
        logger.warn(`[Agent] Agent profile not found: ${options.agentProfileId}`);
        return undefined;
      }
      const profile = await toAgentProfile(options.agentProfileId, entry);
      logger.info(`[Agent] Applying config agent profile: ${profile.name} (${profile.id})`);
      return profile;
    } catch (err) {
      logger.warn(`[Agent] Failed to resolve config agent profile ${options.agentProfileId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
```

两处调用点（`streamChat` 内 line ~518、`sideQuestion` 内 line ~2542）加 `await`（二者均在 async 方法内）。

- [ ] **Step 5.2: system prompt 注入 `globalInstructions`**

`packages/agent/src/agent/session/agent-shell.ts` 的 `buildSystemPrompt`（line 143-214）里，AGENTS.md section 注入之后追加：

```ts
      // Plan 424: config-driven custom agent global instructions
      // (loaded from `agents_md`). Injected as its own <system-reminder> block
      // so the agent's own rules stay separated from project AGENTS.md.
      if (profile?.globalInstructions) {
        sections.push(
          `<system-reminder>\n<agent_global_instructions>\n${profile.globalInstructions}\n</agent_global_instructions>\n</system-reminder>`,
        );
      }
```

> **注**：`buildSystemPrompt` 当前签名需传入 `profile`（`AgentProfile | undefined`）。确认调用链已把 `appliedProfile` 传进来；若未传，把 `_buildSystemPrompt` / `buildSystemPrompt` 的 profile 参数从调用点补上（`streamChat` 已 resolve 出 `appliedProfile`，见 DuyaAgent.ts:518）。

- [ ] **Step 5.3: 类型检查 + agent 单测回归**

```bash
npm run build:agent
npx vitest run packages/agent/tests/unit/agent-profile
```
Expected：编译通过；agent-profile 测试全 PASS（`subagentProfilePrompt` 既有失败除外）。

---

## Task 6：前端读 config agents 并合并到 picker / 建会话

**Files:**
- Modify: `src/lib/agent-profile-ipc.ts`、`src/components/chat/AgentProfileSelector.tsx`、`src/components/chat/AgentModeSelector.tsx`、`src/components/settings/AgentsSection.tsx`、`src/components/chat/NewChatView.tsx`
- Test: `src/lib/__tests__/agent-profile-ipc.test.ts`（新建）

- [ ] **Step 6.1: `listCustomAgents()`**

`src/lib/agent-profile-ipc.ts` 新增：

```ts
export interface CustomAgentConfig {
  name?: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
}

/** Config-driven custom agents ([agents.<id>] in config.toml). */
export async function listCustomAgents(): Promise<Record<string, CustomAgentConfig>> {
  return window.electronAPI.configAgents.list() as Promise<Record<string, CustomAgentConfig>>;
}

/** Merge config custom agents into an AgentProfile-shaped list (kind='main'). */
export async function listMainAgentProfiles(): Promise<AgentProfile[]> {
  const [dbProfiles, customAgents] = await Promise.all([listAgentProfiles(), listCustomAgents()]);
  const main = dbProfiles.filter((p) => p.kind === 'main');
  const custom: AgentProfile[] = Object.entries(customAgents).map(([id, c]) => ({
    id,
    name: c.name || id,
    description: c.description,
    allowedTools: c.tools?.allow,
    disallowedTools: [...(c.tools?.deny ?? [])],
    defaultModel: c.model,
    kind: 'main',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  }));
  return [...main, ...custom];
}
```

- [ ] **Step 6.2: 单测**

新建 `src/lib/__tests__/agent-profile-ipc.test.ts`，mock `window.electronAPI.agentProfile.list` 与 `window.electronAPI.configAgents.list`，断言 `listMainAgentProfiles()` 返回预设 main + 自定义合并结果。

Run: `npm run rebuild:node && npx vitest run src/lib/__tests__/agent-profile-ipc.test.ts`
Expected: PASS

- [ ] **Step 6.3: AgentProfileSelector 用 `listMainAgentProfiles`**

`src/components/chat/AgentProfileSelector.tsx`：把 `listAgentProfiles()` 换成 `listMainAgentProfiles()`，`enabledProfiles` 过滤逻辑保持不变（`kind === 'main'` 已由合并层保证）。

- [ ] **Step 6.4: AgentModeSelector 保留 3 快捷位 + 自定义 agent 并入可用列表**

`src/components/chat/AgentModeSelector.tsx`：`loadFavoriteModes` 里 profile 源从 `listAgentProfiles()` 换成 `listMainAgentProfiles()`（快捷位仍取 `favoriteIds.slice(0,3)`；自定义 agent 若无 `PROFILE_TO_MODE_MAP` 映射则落到 `slot-N`）。

- [ ] **Step 6.5: NewChatView 建会话用自定义 agent 的 model/workspace**

`src/components/chat/NewChatView.tsx` `handleSend`（line ~249-297）：当 `agentProfileId` 命中自定义 agent（查 `listCustomAgents()` 一次缓存）时：

```ts
      const customAgents = await listCustomAgents();
      const custom = agentProfileId ? customAgents[agentProfileId] : undefined;
      let workingDirectory = selectedProject?.workingDirectory;
      let effectiveModel = actualModel;
      if (custom) {
        workingDirectory = custom.workspace || workingDirectory;
        if (custom.model) effectiveModel = custom.model;
      }
```

并把 `createThread({ ..., workingDirectory, model: effectiveModel, agentProfileId })` 用上述值。注意 `effectiveModel` 需与现有 `resolveDefaultModelSync` 结果兼容（保持 `[provider] model` 格式；若 custom.model 是裸 `provider/model`，此处先用 `parseModelName` 处理或直接传入原始串——以现有会话创建契约为准，见 Step 6.6）。

- [ ] **Step 6.6: 前端类型检查 + 单测回归**

```bash
npx tsc --noEmit
npx vitest run src/lib/__tests__/agent-profile-ipc.test.ts
```
Expected：通过（仓库既有 MessageItem 等错误若仍存在，需确认非本任务引入；若已被并行修复则全绿）。

---

## Task 7：AgentsSection 只读展示自定义 agent

**Files:**
- Modify: `src/components/settings/AgentsSection.tsx`

- [ ] **Step 7.1: 新增 "Config Agents" 只读子区**

在 Output Styles section 之后加一个 `SettingsSection`：标题 "Config Agents (config.toml)"，列出 `listCustomAgents()` 的每个 agent（name + id + description），并提示"在 `~/.duya/config.toml` 的 `[agents.<id>]` 中编辑，保存后自动热加载"。无自定义 agent 时显示空态文案。i18n key：`settings.agents.configAgentsTitle` / `configAgentsDesc` / `configAgentsEmpty`（en/zh 各 3 个）。

- [ ] **Step 7.2: Playwright MCP 验证**

```bash
npm run dev
```
浏览器打开设置页 → Agents，确认四个 section 正常，Config Agents 区展示测试用的自定义 agent。

---

## Task 8：全量验证 + 收尾

**Files:**
- Modify: `docs/exec-plans/README.md`、`ARCHITECTURE.md`

- [ ] **Step 8.1: 全量 typecheck + 相关测试**

```bash
npm run typecheck:all
npm run rebuild:node && npx vitest run packages/agent/tests/unit/agent-profile src/lib/__tests__/agent-profile-ipc.test.ts
```
Expected：通过（仓库既有 `subagentProfilePrompt` 失败与本 plan 无关——它测 `resolveEnabledSections`，改的是 prompts/modes 未提交工作；如已修复则忽略此注）。

- [ ] **Step 8.2: README 注册 424 + 标记 420**

`docs/exec-plans/README.md`：
1. Active Plans → "Agent Core & Message" 加一行：`| [424-config-driven-custom-agents](./active/424-config-driven-custom-agents.md) | 配置化自定义 Agent：config.toml 驱动 + 每 agent 独立 workspace/AGENTS.md + model/tools/plugins | P1 | Planning |`
2. `420-agent-profile-completion` 状态改为 `OBSOLETE → 424`。

- [ ] **Step 8.3: ARCHITECTURE.md**

在 config 章节补 `[agents.<id>]` 说明（字段 + 消费链路：前端 picker / 会话 model+workspace / agent 运行时 `readConfigAgents` / `globalInstructions` 注入）。

- [ ] **Step 8.4: 提交（多个原子 commit）**

每个 Task 完成后单独 commit，Conventional Commits（英文），例如：
- `refactor(agent): drop DB-driven custom profile sync (superseded by config agents)`
- `feat(config): add agents.<id> custom agent schema`
- `feat(electron): expose config:agents:list IPC`
- `feat(agent): resolve config-driven custom agents + inject global instructions`
- `feat(ui): surface config agents in picker and session creation`
- `docs: register plan 424, mark 420 obsolete`

---

## 决策日志

### 设计决策

- **Decision A（本 plan 核心）**：自定义 agent 不落 DB，全部从 `~/.duya/config.toml` 读。理由：用户明确要求最终形态；config 可手动编辑 + ConfigStore disk hot-reload（[store.ts:132](electron/config/store.ts) reloadFromDisk）天然支持改完即生效；与 openclaw 参考一致。
- **Decision B**：agent 进程直接读 config.toml（[config-agents.ts](packages/agent/src/agent-profile/config-agents.ts)），不走 db-bridge。理由：已有先例 `readUserMcpToml`（[packages/agent/src/mcp/config.ts:85](packages/agent/src/mcp/config.ts)），少一跳、语义"config 单一权威源"更纯粹。
- **Decision C**：`[agents.<id>]` map 而非 `[[agents]]` 数组。理由：duya config 惯用 map（`mcp_servers`/`plugins`），id 稳定易查；用户已确认。
- **Decision D**：`tools.profile` 用 `TOOL_PROFILE_MAP` 映射 allow/deny 预设。理由：避免用户手写通配串踩 explore 那个"模式匹配零工具"的坑；显式 `allow` 覆盖 profile 的 allow。
- **Decision E**：`agents_md` 内容作为 `globalInstructions` 独立 `<system-reminder>` 块注入，不复用 `identityPrompt`。理由：identityPrompt 定位单行身份句；自定义 agent 的全局指令可能是多行 AGENTS.md，语义不同，分开注入更清晰。
- **Decision F**：`plugins` 本 plan 只存储+暴露，不做 per-agent MCP 门控。理由：现有 `McpServerEntry.allowedAgentIds` 已能承载该能力，但全量接通（MCPManager 按 agent 过滤加载）是独立子系统；列为 follow-up，避免本 plan 爆炸。
- **Decision G**：回退上一轮 DB 方向代码。理由：AGENTS.md 明确"避免死代码"；config 方案下 DB 同步 + identity_prompt 序列化是死代码。

### 已知 follow-up（不在本 plan 范围）

- `plugins` 数组真正生效（per-agent MCP/插件工具门控，基于 `allowedAgentIds`）。
- 自定义 agent 的 `agents_md` 模板初始化（建 agent 时自动生成默认 AGENTS.md，类似 openclaw bootstrap）。
- 前端"新建自定义 agent"的配置编辑向导（本 plan 只做只读展示 + 提示手改 config.toml）。

### 风险与回滚

- **风险 1**：`config.toml` 手改后 agent 进程需在会话内感知变化。缓解：`readConfigAgents()` 每次 `_resolveAgentProfile` 都读盘（有 fs cache 可后续加），首次解析即最新；会话级缓存由调用频率天然限制。
- **风险 2**：`toAgentProfile` async（读文件）插入热路径。缓解：仅在非预设 id（自定义 agent）时触发，预设路径保持同步零开销。
- **回滚**：删除 `agents` schema/读取器/前端合并即可；config.toml 里多余 `[agents.*]` 段无害。

---

## 测试矩阵

| Layer | 路径 | 覆盖 |
|-------|------|------|
| Unit | `packages/agent/tests/unit/agent-profile/config-agents.test.ts` | readConfigAgents / resolveAgentConfig / toAgentProfile / globalInstructions |
| Unit | `src/lib/__tests__/agent-profile-ipc.test.ts` | listMainAgentProfiles 合并逻辑 |
| Unit（IPC） | `electron/ipc/__tests__/config-agents.test.ts` | `config:agents:list` handler 返回 ConfigStore.agents |
| 回归 | `packages/agent/tests/unit/agent-profile` | 现有 agent-profile 测试不破 |
| E2E 视觉 | Playwright MCP | Settings → Agents 展示 Config Agents 区 |

---

## 改动文件清单（执行完成后核对）

- `electron/config/schema.ts`（agents schema + default）
- `electron/config/store.ts`（FLAT_TO_PATH customAgents）
- `electron/ipc/db-handlers.ts`（config:agents:list；回退 identity_prompt）
- `electron/preload.ts`（configAgents.list）
- `electron/agents/db-bridge.ts`（回退 agentProfile:list）
- `electron/db/schema.ts`（回退迁移 52；保留 51）
- `packages/agent/src/agent-profile/types.ts`（globalInstructions；回退 identity_prompt）
- `packages/agent/src/agent-profile/AgentProfileService.ts`（回退 DB 同步 + identity_prompt）
- `packages/agent/src/agent-profile/config-agents.ts`（新建）
- `packages/agent/src/ipc/db-client.ts`（回退 agentProfileDb）
- `packages/agent/src/agent/DuyaAgent.ts`（_resolveAgentProfile async + config 解析）
- `packages/agent/src/agent/session/agent-shell.ts`（globalInstructions 注入）
- `src/lib/agent-profile-ipc.ts`（listCustomAgents / listMainAgentProfiles）
- `src/components/chat/AgentProfileSelector.tsx`、`AgentModeSelector.tsx`、`NewChatView.tsx`
- `src/components/settings/AgentsSection.tsx`
- `ARCHITECTURE.md`、`docs/exec-plans/README.md`
- 新增测试：`packages/agent/tests/unit/agent-profile/config-agents.test.ts`、`src/lib/__tests__/agent-profile-ipc.test.ts`、`electron/ipc/__tests__/config-agents.test.ts`
