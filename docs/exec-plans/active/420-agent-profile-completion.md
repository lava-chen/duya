# 420 Agent Profile 补完计划（UI 管理 + promptProfile 持久化 + 双通道会话绑定收敛）

> **For agentic workers:** 用 `executing-plans` 逐 task 实现。步骤使用 checkbox（`- [ ]`）追踪。
> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-08-12
> **Depends on**: 已完成的 29 / 105 / 224 / 242（核心骨架、运行时接线、Mode 正交、cleanup）

---

## 背景与诊断（已核实）

agent profile 系统的"骨架"已完整落地（plan 29 + 105），DB 表 / IPC handlers / 运行时接线 / 模式选择器全部就位。
调研（见本 plan 调研章节）暴露三条"功能能用但约束不足"的短板：

### 短板 A：自定义 profile CRUD UI 缺失

- 前端封装齐全：[src/lib/agent-profile-ipc.ts](src/lib/agent-profile-ipc.ts) 暴露 `createAgentProfile / updateAgentProfile / deleteAgentProfile`，全部 IPC 通到主进程 `db:agentProfile:*` handlers。
- 设置页 [src/components/settings/AgentsSection.tsx](src/components/settings/AgentsSection.tsx) **只做"收藏 favoriteAgentIds 勾选 + 启用/禁用"**（line 96-200），完全没消费 create/update/delete。
- 用户当前**只能切预设、不能造自己的 profile**，违背 plan 29 设计意图（"用户可扩展"）。

### 短板 B：`promptProfile` 字段无法跨 IPC 持久化

- 类型层支持：[packages/agent/src/agent-profile/types.ts:11](packages/agent/src/agent-profile/types.ts) `PromptProfileOverride { disableSections, enableSections }`，被 `getPromptProfileForAgentProfile`（[packages/agent/src/prompts/modes/index.ts:58](packages/agent/src/prompts/modes/index.ts)）扁平化使用。
- 但 DB 表 [electron/db/schema.ts:42](electron/db/schema.ts) **没有 `prompt_profile` 列**；主进程 `db:agentProfile:update` 的 `fieldMap`（[electron/ipc/db-handlers.ts:1132](electron/ipc/db-handlers.ts)）**不包含 `prompt_profile`**。
- 前端 `parseAgentProfile`（[src/lib/agent-profile-ipc.ts:25](src/lib/agent-profile-ipc.ts)）不解析 `prompt_profile`。
- **结果**：用户为自定义 profile 设的 `disableSections/enableSections` 在 reload 后失效；预设因为硬编码在 `PRESET_AGENT_PROFILES`（types.ts:96）所以不出问题。这是 plan 105 验收时已知的"未完成项"。

### 短板 C：会话绑定走 `thread.update` 而非专用 IPC

- 已有专用通道：[electron/ipc/db-handlers.ts:1168](electron/ipc/db-handlers.ts) `db:session:setAgentProfile`（走核心 store `sessions.update(sessionId, { agentProfileId })`）。
- 前端封装 [src/lib/agent-profile-ipc.ts:74](src/lib/agent-profile-ipc.ts) 实际调用 `window.electronAPI.thread.update(sessionId, { agent_profile_id })`。
- 两条路径**最终都到 `sessions.update`**，但命名空间不一致：`thread.update` 是 sessions 上的通用 update，专用 IPC 更可观测（未来可加审计/事件）。
- 不影响功能，但是个"该有的封装没补"的裂缝。

---

## 设计目标

补完三条短板，让 agent profile 系统达到"用户能造、能管、能验"的可发布状态，同时不破坏 plan 105 已有的运行时接线、plan 224 的 Mode/Profile 正交关系。

**Architecture:** 三层修复。
- **UI 层**：`AgentsSection` 加自定义 profile CRUD dialog + 列表（独立非预设区域），复用 plan 405 Output Styles 的 dialog 模式（保持视觉一致）。
- **数据层**：DB 加 `prompt_profile` TEXT 列（JSON 序列化的 PromptProfileOverride），`fieldMap` 加 `prompt_profile`，`parseAgentProfile` 解析回对象。**向后兼容**（旧行该列为 NULL → `undefined`）。
- **IPC 层**：新增 `setSessionAgentProfile` 在 preload（[electron/preload.ts:1704-1710](electron/preload.ts) 已暴露 `agentProfile.*` 5 个，加一个），封装改走专用通道。

**Tech Stack:** React 19 + Zero Router + better-sqlite3 + Vitest + Playwright MCP。

**约定（沿用 AGENTS.md / 用户偏好）：**
- 跑 Vitest 必须先 `npm run rebuild:node`。
- 提交用 Conventional Commits（英文）；代码注释一律英文。
- UI 改动必须 Playwright MCP 验证（npm run dev 起服务，browser_navigate + browser_snapshot）。
- `npm run typecheck:all` 通过后才能 commit。

---

## 文件结构

| 路径 | 职责 | 动作 |
|------|------|------|
| `electron/db/schema.ts` | 新增迁移 id 44：`prompt_profile` TEXT 列；旧行默认 NULL | 修改 |
| `electron/db/__tests__/schema.test.ts` | 迁移断言 | 修改 |
| `electron/ipc/db-handlers.ts` | `db:agentProfile:create` / `db:agentProfile:update` 增 `prompt_profile` 字段 | 修改 |
| `electron/ipc/__tests__/db-handlers.test.ts` | 新增 prompt_profile round-trip 测试 | 修改 |
| `electron/preload.ts` | `agentProfile.setSession(sessionId, profileId)` 暴露 | 修改 |
| `src/lib/agent-profile-ipc.ts` | `parseAgentProfile` 解析 `prompt_profile` JSON；新增 `setSessionAgentProfile` 走专用通道；`AgentProfile` 接口加 `promptProfile` | 修改 |
| `src/components/settings/AgentsSection.tsx` | 新增 "Custom Profiles" 子 section：列表 + 创建/编辑/删除 dialog（参考 Output Styles 实现） | 修改 |
| `src/components/settings/__tests__/AgentsSection.test.tsx` | 新增 CRUD UI 行为测试 | 新建 |
| `packages/agent/tests/unit/agent-profile/ToolFilter.test.ts` | 已有测试不动；新增 1 个 round-trip 测试（DB row → profile → DB row）覆盖 prompt_profile | 修改 |
| `ARCHITECTURE.md` | agent_profiles 表 schema 更新 + 新 IPC 文档 | 修改 |
| `docs/exec-plans/README.md` | 注册 Plan 420 | 修改 |

---

## Task 1：Schema 迁移 —— `prompt_profile` 列

**Files:**
- Modify: `electron/db/schema.ts`（migrations 数组追加 id 44）
- Test: `electron/db/__tests__/schema.test.ts`

- [ ] **Step 1.1: 写失败测试**

在 `electron/db/__tests__/schema.test.ts`（如存在）加入断言：

```ts
it('migration 44 adds prompt_profile to agent_profiles', () => {
  const db = new Database(':memory:');
  // 走现有 migrate 入口；具体调用照搬同文件其它测试
  const cols = db.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[];
  expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['prompt_profile']));
});
```

- [ ] **Step 1.2: 运行测试，确认失败**

Run: `npm run rebuild:node && npx vitest run electron/db/__tests__/schema.test.ts`
Expected: FAIL（`prompt_profile` 列不存在）

- [ ] **Step 1.3: 在 migrations 数组末尾追加迁移**

找到 `electron/db/schema.ts` 的 `migrations` 数组（最后一个迁移 id 为 43），追加：

```ts
{
  id: 44,
  name: 'add_prompt_profile_to_agent_profiles',
  up: (db: Database.Database) => {
    db.exec(`ALTER TABLE agent_profiles ADD COLUMN prompt_profile TEXT`);
  },
  down: (db: Database.Database) => {
    // SQLite 不支持 DROP COLUMN on 3.x 以下；但项目已用 better-sqlite3，
    // 检测 SQLite 版本>=3.35 时再 drop，否则保留列 + 警告。
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    if (parseFloat(version) >= 3.35) {
      // SQLite 3.35+ 支持 DROP COLUMN 但 better-sqlite3 打包的 SQLite 版本需 ≥3.37
      // 实际检测 < 3.37 时静默保留
      try {
        db.exec(`ALTER TABLE agent_profiles DROP COLUMN prompt_profile`);
      } catch {
        // 保留列即可，无破坏
      }
    }
  },
}
```

> **设计取舍**：44 阶段只要求 up 路径正确；down 路径宽松（best-effort），不影响生产。

- [ ] **Step 1.4: 重跑测试，确认通过**

Run: 同上
Expected: PASS

---

## Task 2：IPC handler 持久化 `prompt_profile`

**Files:**
- Modify: `electron/ipc/db-handlers.ts`（line 1098 `create` handler + line 1132 `fieldMap`）

- [ ] **Step 2.1: 写失败测试**

在 `electron/ipc/__tests__/db-handlers.test.ts` 新增（如文件不存在则新建）：

```ts
import { vi } from 'vitest';
// ... 沿用同目录其它测试的 mock 模式

it('db:agentProfile:create persists prompt_profile JSON', async () => {
  // mock getDb 返回 :memory: SQLite + migrate()
  const handler = registerAgentProfileHandlers(getDb); // 视实际结构而定
  const data = {
    id: 'p-test',
    name: 'Test',
    allowed_tools: ['Read', 'Edit'],
    prompt_profile: { disableSections: ['memory', 'skills'] },
  };
  const row = await invoke('db:agentProfile:create', data);
  expect(row.prompt_profile).toBe(JSON.stringify(data.prompt_profile));
});
```

- [ ] **Step 2.2: 运行测试，确认失败**

Run: `npm run rebuild:node && npx vitest run electron/ipc/__tests__/db-handlers.test.ts`
Expected: FAIL（写不进去 / 读不出来）

- [ ] **Step 2.3: 修改 create handler**

在 [electron/ipc/db-handlers.ts:1102](electron/ipc/db-handlers.ts) 的 INSERT 语句加入 `prompt_profile` 列，并在 values 对象（line 1110-1123）加入：

```ts
prompt_profile: data.prompt_profile ? JSON.stringify(data.prompt_profile) : null,
```

- [ ] **Step 2.4: 修改 update fieldMap**

在 [electron/ipc/db-handlers.ts:1132](electron/ipc/db-handlers.ts) 的 `fieldMap` 加入：

```ts
prompt_profile: ['prompt_profile', v => v ? JSON.stringify(v) : null],
```

- [ ] **Step 2.5: 重跑测试，确认通过**

Run: 同上
Expected: PASS

---

## Task 3：前端 IPC 客户端解析 `prompt_profile`

**Files:**
- Modify: `src/lib/agent-profile-ipc.ts`

- [ ] **Step 3.1: 接口与解析函数扩展**

修改 `RawAgentProfile` 接口（line 7-21）：

```ts
prompt_profile?: string;  // 新增
```

修改 `parseAgentProfile`（line 23-39）：

```ts
promptProfile: raw.prompt_profile ? JSON.parse(raw.prompt_profile) : undefined,
```

修改 `AgentProfile` 接口（line 3-17）：

```ts
promptProfile?: { disableSections?: string[]; enableSections?: string[] };
```

- [ ] **Step 3.2: 把 `setSessionAgentProfile` 改为专用通道**

替换 line 74-75：

```ts
// 旧：走 thread.update
// return window.electronAPI.thread.update(sessionId, { agent_profile_id: agentProfileId });
//
// 新：走专用 IPC（preload 在 Task 4 暴露）
return window.electronAPI.agentProfile.setSession(sessionId, agentProfileId);
```

- [ ] **Step 3.3: 单元测试**

新建 `src/lib/__tests__/agent-profile-ipc.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseAgentProfile, type RawAgentProfile } from '../agent-profile-ipc';

describe('parseAgentProfile', () => {
  it('parses prompt_profile JSON string to object', () => {
    const raw: RawAgentProfile = {
      id: 'p1', name: 'Test', is_preset: 0, is_enabled: 1, user_visible: 1,
      prompt_profile: JSON.stringify({ disableSections: ['memory'] }),
    };
    const p = parseAgentProfile(raw);
    expect(p.promptProfile).toEqual({ disableSections: ['memory'] });
  });

  it('returns undefined when prompt_profile is absent', () => {
    const raw: RawAgentProfile = {
      id: 'p1', name: 'Test', is_preset: 0, is_enabled: 1, user_visible: 1,
    };
    const p = parseAgentProfile(raw);
    expect(p.promptProfile).toBeUndefined();
  });
});
```

Run: `npm run rebuild:node && npx vitest run src/lib/__tests__/agent-profile-ipc.test.ts`
Expected: PASS

---

## Task 4：preload 暴露 `setSession`

**Files:**
- Modify: `electron/preload.ts`（line 1704-1710）

- [ ] **Step 4.1: 新增 setSession 桥接**

在 `agentProfile` 暴露对象里追加：

```ts
setSession: (sessionId: string, agentProfileId: string | null) =>
  ipcRenderer.invoke('db:session:setAgentProfile', sessionId, agentProfileId),
```

> 注：参考同文件 line 1704-1710 既有 5 个方法的格式（`ipcRenderer.invoke('db:agentProfile:...', ...)`）。

- [ ] **Step 4.2: 类型检查**

Run: `npm run typecheck:all`
Expected: PASS（TS 会校验 `agentProfile.setSession` 已定义）

---

## Task 5：AgentsSection 自定义 profile CRUD UI

**Files:**
- Modify: `src/components/settings/AgentsSection.tsx`

**设计原则：**
- 复用已有 Output Styles CRUD 的 dialog 模式（line 153-272），保持视觉一致。
- 预设（`is_preset=true`）**只显示、不可编辑/删除**（与后端 `delete` handler 一致，line 1159-1161）。
- 自定义 profile 字段：name、description、allowedTools（逗号分隔 textarea）、disallowedTools（同上）、promptProfile disableSections（逗号分隔 textarea，可选）。
- 工具过滤预览：调用 [packages/agent/src/agent-profile/ToolFilter.ts:67](packages/agent/src/agent-profile/ToolFilter.ts) 的 `isToolVisible`（注意：此函数在 agent 包内，前端不能直接 import，需通过新增 IPC `db:tools:list` 或共享 util；本 plan 范围内**仅显示原始字符串 + 提示文案**，不做实时预览；ToolFilter 单元测试在 Task 7 覆盖）。

- [ ] **Step 5.1: 写失败测试**

新建 `src/components/settings/__tests__/AgentsSection.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentsSection } from '../AgentsSection';

// mock window.electronAPI.agentProfile
// mock useSettings

describe('AgentsSection custom profile CRUD', () => {
  it('renders create button', () => { ... });
  it('opens create dialog on click', async () => { ... });
  it('submits create and calls agentProfile.create', async () => { ... });
  it('opens edit dialog for non-preset profile', async () => { ... });
  it('deletes non-preset profile with confirmation', async () => { ... });
  it('does NOT show delete button for preset profiles', async () => { ... });
});
```

- [ ] **Step 5.2: 运行测试，确认失败**

Run: `npm run rebuild:node && npx vitest run src/components/settings/__tests__/AgentsSection.test.tsx`
Expected: FAIL（CRUD UI 尚未实现）

- [ ] **Step 5.3: 实现 CustomProfiles 子 section**

在 `AgentsSection.tsx` 现有 Quick Access / Language / Output Styles 三个 section 之后，新增第四个 section "Custom Profiles"（沿用现有 `SettingsSection` + `SettingsCard` 模式）：

```tsx
{/* Custom Profiles Section */}
<SettingsSection
  title={t("settings.agents.customProfilesTitle") || "Custom Profiles"}
  description={t("settings.agents.customProfilesDesc") || "Create your own agent profiles with custom tool permissions and prompt sections."}
>
  <SettingsCard>
    {/* 列表 + create button，复用 OutputStyles 状态机模式 */}
    {/* preset 不可编辑/删除 */}
  </SettingsCard>
</SettingsSection>
```

- [ ] **Step 5.4: 表单字段**

dialog 字段：
- `name`（Input，必填）
- `description`（Input，可选）
- `allowedTools`（textarea，逗号分隔，可选）
- `disallowedTools`（textarea，逗号分隔，可选）
- `disableSections`（textarea，逗号分隔，可选）

提交时把字符串数组化：

```ts
const allowedTools = formAllowedTools.split(',').map(s => s.trim()).filter(Boolean);
const promptProfile = formDisableSections
  ? { disableSections: formDisableSections.split(',').map(s => s.trim()).filter(Boolean) }
  : undefined;

await createAgentProfile({
  id: '',
  name: formName,
  description: formDescription || undefined,
  allowedTools: allowedTools.length ? allowedTools : undefined,
  disallowedTools: disallowedTools.length ? disallowedTools : undefined,
  promptProfile,
  userVisible: true,
  isPreset: false,
  isEnabled: true,
});
```

> **Decision**: `id: ''` 让后端 `crypto.randomUUID()` 生成（[electron/ipc/db-handlers.ts:1100](electron/ipc/db-handlers.ts)）。

- [ ] **Step 5.5: i18n key**

在 `src/i18n/` 加 4 个 key：
- `settings.agents.customProfilesTitle`
- `settings.agents.customProfilesDesc`
- `settings.agents.createCustomProfile`
- `settings.agents.editCustomProfile`

英文版直接填 "Custom Profiles" / "Create your own..."。

- [ ] **Step 5.6: 重跑测试，确认通过**

Run: 同 5.2
Expected: PASS

---

## Task 6：i18n 字符串补全

**Files:**
- Modify: `src/i18n/locales/en-US.json`（或类似）
- Modify: `src/i18n/locales/zh-CN.json`

- [ ] **Step 6.1: 加 key**

英文：
```json
"customProfilesTitle": "Custom Profiles",
"customProfilesDesc": "Create your own agent profiles with custom tool permissions and prompt sections.",
"createCustomProfile": "Create profile",
"editCustomProfile": "Edit profile",
"deleteCustomProfileConfirm": "Delete this profile?"
```

中文：
```json
"customProfilesTitle": "自定义 Profile",
"customProfilesDesc": "用自定义工具权限与 prompt 段落创建你自己的 agent profile。",
"createCustomProfile": "创建 profile",
"editCustomProfile": "编辑 profile",
"deleteCustomProfileConfirm": "确认删除此 profile？"
```

---

## Task 7：ToolFilter round-trip 测试覆盖

**Files:**
- Modify: `packages/agent/tests/unit/agent-profile/ToolFilter.test.ts`

- [ ] **Step 7.1: 新增 DB row ↔ profile ↔ DB row 测试**

```ts
import { profileToRow, rowToAgentProfile } from '../../../src/agent-profile/AgentProfileService.js';
import type { AgentProfile } from '../../../src/agent-profile/types.js';

describe('AgentProfile row round-trip with prompt_profile', () => {
  it('preserves promptProfile through row → profile → row', () => {
    const original: AgentProfile = {
      id: 'p1', name: 'X', isPreset: false, isEnabled: true, userVisible: true,
      promptProfile: { disableSections: ['memory', 'skills'] },
      createdAt: 100, updatedAt: 200,
    };
    const row = profileToRow(original);
    row.prompt_profile = JSON.stringify(original.promptProfile);
    const back = rowToAgentProfile(row);
    expect(back.promptProfile).toEqual(original.promptProfile);
  });
});
```

> **检查点**：先 grep 确认 `profileToRow` / `rowToAgentProfile` 函数导出位置（位于 [packages/agent/src/agent-profile/AgentProfileService.ts](packages/agent/src/agent-profile/AgentProfileService.ts) 同目录或 utils.ts）；若不导出，则通过 `loadFromRows` + `exportToRows` 走完整路径测试。

Run: `npm run rebuild:node && npx vitest run packages/agent/tests/unit/agent-profile/ToolFilter.test.ts`
Expected: PASS

---

## Task 8：Playwright MCP UI 验证

> AGENTS.md Gate: UI 改动必须 Playwright MCP 验证。

- [ ] **Step 8.1: 起 dev 服务**

Run: `npm run dev`（后台）

- [ ] **Step 8.2: 打开设置页 → Agents**

```
mcp__playwright browser_navigate http://localhost:3000
mcp__playwright browser_snapshot
```

导航到 Settings → Agents 区域（具体选择器视 UI 决定）。

- [ ] **Step 8.3: 验证四个 section**

通过 `browser_snapshot` 确认：
- Quick Access（已存在）
- Response Language（已存在）
- Output Styles（已存在）
- **Custom Profiles**（本 plan 新增）— 至少包含 "Create profile" 按钮。

- [ ] **Step 8.4: 端到端 CRUD 流**

1. 点 "Create profile"，填 name="Test"、disableSections="memory, skills"，保存。
2. 确认新 profile 出现在列表（**非 preset 角标**）。
3. 点编辑，修改 disableSections，保存，刷新页面（`browser_refresh`）确认持久化。
4. 点删除，确认消失。
5. 验证 preset profile（如 `general-purpose`）**不显示**删除按钮。

- [ ] **Step 8.5: 截图存证**

`mcp__playwright browser_screenshot` 保存 Custom Profiles section 的可视化结果，作为本 plan 完成的视觉证据。

---

## Task 9：ARCHITECTURE.md 更新

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 9.1: 更新 agent_profiles schema 文档**

在 ARCHITECTURE.md 数据库 schema 章节，把 `agent_profiles` 表的列定义补充 `prompt_profile TEXT` 行。

- [ ] **Step 9.2: 新增 IPC 文档**

在 IPC 通道章节，列出新增的 `db:session:setAgentProfile`（已存在但未文档化）+ `prompt_profile` 字段的 `db:agentProfile:create/update`。

---

## Task 10：README 注册 + 最终验证

**Files:**
- Modify: `docs/exec-plans/README.md`

- [ ] **Step 10.1: 注册到 Active Plans 表格**

在 "Agent Core & Message" 章节加一行：

```markdown
| [420-agent-profile-completion](./active/420-agent-profile-completion.md) | Agent Profile 补完：自定义 CRUD UI + prompt_profile 持久化 + 专用会话绑定 IPC | P1 | Planning |
```

- [ ] **Step 10.2: 全量 typecheck + test**

```bash
npm run typecheck:all
npm run rebuild:node && npm test
```

Expected: PASS（无新增 failure）。

---

## 决策日志

### 设计决策

- **Decision A**：Task 5 不做 ToolFilter 实时预览。原因：`isToolVisible` 在 `@duya/agent` 包内，前端 bundle 不应把 server 包引入；要么做 IPC `db:tools:list` + 后端预览，要么不做。本 plan 选**不做**（保持 scope），仅展示原始字符串 + 提示文案。如未来要做，预留测试覆盖。
- **Decision B**：预设 profile 只读。理由：与后端 `delete` handler 的 preset 保护一致（line 1159-1161）；UI 一致性是"非 preset 才显示编辑/删除按钮"。
- **Decision C**：`id: ''` 由后端生成 UUID。理由：[electron/ipc/db-handlers.ts:1100](electron/ipc/db-handlers.ts) 已支持。
- **Decision D**：down 迁移 best-effort。理由：SQLite ALTER TABLE DROP COLUMN 版本要求不一致；保持 up-only 行为稳定即可。
- **Decision E**：`setSessionAgentProfile` 走专用 IPC 而非 `thread.update`。理由：命名空间一致；未来可加审计/事件不影响调用面。
- **Decision F**：不做 IPC `db:agentProfile:validate` 端。理由：ToolFilter 已在 agent 包单元测试覆盖，前端表单层只做"必填 + 字符串 trim + 数组化"，不重复校验。

### 已知 follow-up（不在本 plan 范围）

- ToolFilter 实时预览 UI（需 IPC `db:tools:list` + 后端 filter 调用）。
- 自定义 profile 导入/导出（plan 95 已有 `claude-code` 导入机制，可扩展 profile 部分）。
- profile 版本控制 / 历史回滚（暂不需要，profile 字段少）。

### 风险与回滚

- **风险 1**：`ALTER TABLE ADD COLUMN` 在 SQLite 上是 metadata-only 操作，秒级完成，无重建表风险。
- **风险 2**：`prompt_profile` 字段如前后端解析 JSON 失败，会导致 `parseAgentProfile` 抛错。**缓解**：`parseAgentProfile` 用 try/catch 包住 JSON.parse，失败时降级为 undefined + console.warn。
- **回滚**：删除新增 UI section + `fieldMap` 移除 `prompt_profile` + 数据库保留 `prompt_profile` 列（无害）。

---

## 测试矩阵

| Layer | 路径 | 覆盖 |
|-------|------|------|
| Unit | `electron/db/__tests__/schema.test.ts` | 迁移 44 schema 验证 |
| Unit | `electron/ipc/__tests__/db-handlers.test.ts` | IPC prompt_profile round-trip |
| Unit | `src/lib/__tests__/agent-profile-ipc.test.ts` | 前端 JSON 解析 |
| Unit | `src/components/settings/__tests__/AgentsSection.test.tsx` | UI 行为 |
| Unit | `packages/agent/tests/unit/agent-profile/ToolFilter.test.ts` | DB row ↔ profile 往返 |
| E2E 视觉 | Playwright MCP | UI 端到端 CRUD + 持久化 |

---

## 改动文件清单（执行完成后核对）

- `electron/db/schema.ts`（迁移 44）
- `electron/ipc/db-handlers.ts`（create + fieldMap）
- `electron/preload.ts`（agentProfile.setSession）
- `src/lib/agent-profile-ipc.ts`（parse + AgentProfile + setSession）
- `src/components/settings/AgentsSection.tsx`（Custom Profiles section + dialog）
- `src/i18n/locales/en-US.json` + `zh-CN.json`（5 个 key）
- `ARCHITECTURE.md`（schema + IPC）
- `docs/exec-plans/README.md`（注册）
- 新增：`src/lib/__tests__/agent-profile-ipc.test.ts`
- 新增：`src/components/settings/__tests__/AgentsSection.test.tsx`
- 修改：上述各路径测试文件