# Plan 534: Projects 表迁移到 Core DB + duya-main.db 清理

> **Status**: Phase 3 done (Research + Conductor → core) ✅  
> **Created**: 2026-09-14  
> **Priority**: P0  
> **Updated**: 2026-09-14 — Phase 3 完成（Research 15表 + Conductor 5表 → core）  

## Background

当前架构有三个数据库：
- **duya-core.db**: Plan 326 迁移的 6 个核心聚合 (messages, sessions, mailbox, tasks, permissions, locks) + 部分已迁移表
- **duya-main.db**: LEGACY FROZEN — 所有其他子系统表 (conductor, research, gateway, automation, agents, weixin 等)
- **memory-state.db**: Plan 305 memory/catalog 系统 + **Plan 525 projects 表 (错放这里)**

问题：
1. `projects` 表在 `memory-state.db`，但 `sessions` 表在 `duya-core.db` — 跨数据库关联是碎片化的
2. `duya-main.db` 被标记为 LEGACY FROZEN 但仍在使用，应该逐步迁入 `duya-core.db`
3. `sidebar_section_projects` 表已在 `duya-core.db`，说明迁移机制已就绪

## Goals

1. 将 `projects` 表从 `memory-state.db` 迁移到 `duya-core.db`
2. 在 `duya-core.db` 设计完整的 `projects` 表
3. 将 `projectService` 从 `memory-state` 迁移到 `duya-core`
4. 盘点并迁移 `duya-main.db` 中剩余的子系统表到 `duya-core.db`
5. 删除 `memory-state.db` 中的 projects 相关代码

## Non-Goals

- 不修改 memory-state.db 中的 memory/catalog 系统（Plan 305）
- 不删除 duya-main.db，而是将其内容迁移到 duya-core.db 后清空

---

## Phase 1: 盘点与设计 (Planning)

### Task 1.1: 盘点全部表 ✅ (2026-09-14)

数据来自 `electron/db/schema.ts`（duya-main.db）、`electron/db/core/*`（duya-core.db）、`electron/memory-state/migrations/*`（memory-state.db）。

```
【duya-core.db】核心聚合（Plan 326-329 已迁）
  meta, sessions(mig 2), messages/search(mig 1), mailbox_items(4/15),
  tasks(5), permission_requests(6), session_runtime_locks(7/17),
  session_goals(8), session_spawn_edges(9), attachments(10),
  mode_state_snapshots(11), pending_wakes(12)
  → 核心 6 聚合(messages/sessions/mailbox/tasks/permissions/locks) 均在 core ✓

【duya-main.db】LEGACY FROZEN（schema.ts）—— 按子系统分类
  ├─ 已迁 core 的 legacy 副本（只读，勿扩展）:
  │    chat_sessions, messages, message_attachments, session_runtime_locks,
  │    permission_requests, tasks   ← sessions/messages/attachments/locks/perm/tasks 均在 core 有新表
  ├─ 待迁移 — 子系统表:
  │   Conductor:   conductor_canvases, conductor_canvas_groups, conductor_widgets,
  │                conductor_actions, conductor_elements
  │   Research:    research_projects, research_project_states, research_memory_objects,
  │                research_hypotheses, research_memory_candidates, research_memory_relations,
  │                research_sessions, research_plan_steps, research_activities,
  │                research_events, research_sources, research_reports, research_citations,
  │                import_batches, import_items
  │   Gateway:     gateway_user_map, gateway_message_map
  │               + channel_bindings, channel_directory, threads, channel_offsets,
  │                 channel_permission_links(渠道/绑定，归 Gateway 域)
  │   Automation:  automation_cron_runs, automation_cron_state
  │   Agents:      agent_profiles, tool_profiles   ← ⚠ 当前仅存在于 main，core 无对应 store
  │   WeChat:      weixin_accounts, weixin_context_tokens
  │   Plugin/Model: plugin_setup_values, app_connections, model_capabilities,
  │                 provider_model_capabilities
  │   其他:        settings, chat_turn_reviews,
  │                sidebar_sections, sidebar_section_projects (Plan 471)
  └─ 迁移基础设施: _schema_migrations

【memory-state.db】Plan 305 memory/catalog + projects（错放）
  projects, project_bots(0012), project_path_aliases(0001)
  rollout_catalog(0001/0011), rollout_leases, rollout_retired, stage1_outputs,
  projection_outbox, memory_entries, memory_evidence, memory_usage_events,
  phase2_runs, memory_tier_index, curation_runs/curation_run_inputs/curation_publications
  → 仅 projects / project_bots 属于本计划目标；其余 memory/catalog 属 Plan 305，不迁移
```

**关键事实修正（推翻计划背景的两个假设）**：
- ❌ 计划背景称 `sidebar_section_projects 已在 duya-core.db` — **错误**。它在 duya-main.db（`schema.ts:2528`，Plan 471 创建），且映射的是 `workingDirectory` 项目，不是 `projects.project_id`。
- ✅ `chat_sessions`（Open Question 1）已在 core 作为 `sessions`（`session-store.ts` mig 2）；main 里是 legacy 只读副本。迁移 conventions 见 `electron/db/core/legacy-import.ts`。
- ⚠ `agent_profiles` 无 core 对应 store（需横跨 Agent 集成，见下）。
- ⚠ `settings` 无 core store（core 用 `meta` 键值表）；`tool_profiles` 同。

### Task 1.2: 设计 duya-core.db projects 表 ✅

依据 memory-state 现有 schema 逐步沉淀（迁移 0001 + 0012 + 0013 的叠加结果），**保持逐字对齐**以免破坏现有读取路径：

```sql
-- duya-core.db (migration id=18, 见下)
CREATE TABLE projects (
  project_id      TEXT PRIMARY KEY,          -- UUID，非路径 hash
  canonical_root  TEXT NOT NULL UNIQUE,      -- 主工作目录
  name            TEXT NOT NULL DEFAULT '',  -- 0012
  description     TEXT,                      -- 0012
  paths           TEXT NOT NULL DEFAULT '[]',-- 0012: JSON [{path, description}], parse 用 parseProjectPaths
  icon            TEXT,                      -- 0013
  color           TEXT,                      -- 0013
  created_at      INTEGER NOT NULL,          -- ms
  last_seen_at    INTEGER NOT NULL           -- ms
);

CREATE TABLE project_bots (
  project_id  TEXT NOT NULL,
  bot_id      TEXT NOT NULL,          -- 无 FK: agents 在 main，SQLite 无法跨库约束(0012)
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, bot_id)
);
CREATE INDEX idx_project_bots_bot ON project_bots(bot_id);
CREATE INDEX idx_projects_last_seen ON projects(last_seen_at);
```

**与计划原草案的偏差**：
- `canonical_root` 已是 `UNIQUE`，`idx_projects_canonical_root` 冗余 → 删除该索引（0012 也只在 main 里建了 `idx_project_bots_bot` + `idx_projects_last_seen` 对应物）。
- `project_bots` 现 schema **无 `role`/`added_at` 列**（0012 明确 no role）。计划草案加了 `role`/`FOREIGN KEY` — 迁移首版应**维持现状**（`project_id,bot_id,joined_at`），是否加 role 另立计划，不要混入。
- `paths` 语义是 `[{path, description}]`（`electron/memory-state/schema.ts` 的 `ProjectPathEntry`），不是"多路径字符串数组"。

**core migration id**：core 已占用 `1,2,4,5,6,7,8,9,10,11,12,13,14,15,16,17`（id 3 空闲）。**projects 用 id=18**。

### Task 1.3: 迁移顺序 ✅

projects 相关代码锚点：
- 表: `memory-state.db` → `projects`, `project_bots`, `project_path_aliases`
  - ⚠ `project_path_aliases` 是 projects 解析用的别名表（0001），虽属 projects 域但被记忆/目录解析读取 — 是否随迁需单独确认，默认**暂不迁**（non-goal 保护 Plan 305）。
- 服务: `electron/memory-state/projectService.ts`（导出 CreateProjectInput/createProject/listProjects/getProject/projectPaths/…）
- IPC: `electron/ipc/project-entity-handlers.ts` → `projects:list/get/register`
- preload/前端: `electron/preload.ts` 的 `projects` namespace + `src/stores/projects-store.ts`

顺序：
1. **Phase 2**: projects → core（表 + projectService + IPC + frontend + 一次性数据迁移 + 清理 memory-state）
2. **Phase 3**: 按子系统迁移 main 表。建议分批，先无外部依赖的：Conductor → Automation → WeChat → Gateway/Channel → Plugin/Model → Research → 最后 Agents(agent_profiles, 涉及集成) + settings/chat_turn_reviews + sidebar_sections。每批独立 IPC 重指向 + 前端 store。
3. **Phase 4**: 测试验证。

---

## Phase 2: Projects 表迁移到 duya-core.db

### Task 2.1: 在 duya-core.db 创建 projects 表

在 `electron/db/core/` 下创建新的 schema 文件：

```
electron/db/core/projects-store.ts   -- projects 表的 CRUD 操作
electron/db/core/migrations/ 下的新 migration 文件
```

### Task 2.2: 创建 projectService in core

参考 `electron/memory-state/projectService.ts`，在 `electron/db/core/` 下创建新的 `projectService.ts`：

```typescript
// electron/db/core/projectService.ts
export interface ProjectRow {
  project_id: string;
  name: string;
  description: string | null;
  canonical_root: string;
  paths: string;  // JSON string
  icon: string | null;
  color: string | null;
  created_at: number;
  last_seen_at: number;
}

export function listProjects(opts?: { db?: Database }): ProjectRow[] { ... }
export function getProject(projectId: string, opts?: { db?: Database }): ProjectRow | null { ... }
export function createProject(project: NewProject, opts?: { db?: Database }): ProjectRow { ... }
export function updateProject(projectId: string, updates: Partial<Project>, opts?: { db?: Database }): ProjectRow { ... }
export function deleteProject(projectId: string, opts?: { db?: Database }): void { ... }
```

### Task 2.3: 迁移 memory-state.db projects 数据到 duya-core.db

编写一次性迁移脚本：
1. 读取 `memory-state.db.projects` 所有数据
2. 写入 `duya-core.db.projects`
3. 验证数据一致性

### Task 2.4: 更新 IPC handlers ✅ (2026-09-14)

修改 `electron/ipc/project-entity-handlers.ts`：
- 将 imports 从 `../memory-state` 改为直接 `../db/core/projectService`（`createProject/updateProject/deleteProject/listProjects/getProject/projectPaths/MAX_PROJECT_PATH_LENGTH/CreateProjectInput/UpdateProjectInput`）与 `../db/core/project-store`（`ProjectRow/ProjectPathEntry`）。
- IPC channel 名与 preload `projects` namespace 不变（handler 已是 core 实现）。

### Task 2.5: 更新 frontend store ✅ (2026-09-14)

`src/stores/projects-store.ts` 走 `window.electronAPI.projects.*` IPC channel，channel 未变 → 无需改动。

### Task 2.6: 清理 memory-state 中的 projects 代码 ✅ (2026-09-14)

- 删除 migrations `0012_project_entity_minimal.sql.ts` + `0013_project_icon_color.sql.ts`，从 `MIGRATIONS` 数组移除 → 现为 10 条（1,2,3,5,6,7,8,9,10,11）。
- 删除 `memory-state/projectService.ts`（此前已完成）及其残留测试 `projectService.test.ts`、`projectEntity.test.ts`。
- 新增 `electron/db/core/__tests__/project-store.test.ts`（8 例，覆盖 insert/get/update/paths/touch/bots/list/delete）。
- 适配测试：`migration.test.ts`（12→10 迁移）、`pathsMigration.test.ts`、`projectResolver.test.ts`（补 name/desc/paths 列）。`catalogSync.test.ts` 补 `ProjectStore.migrations`。

**发现/修复（关键）**：catalogSync 把 `coreDb` 传给 `resolveProject` 后，`rollout_catalog`（Plan 305，memory-state.db）的外键仍指向 memory-state 的 `projects` 表 —— SQLite 无法跨库约束，且 `memory-state/db.ts:98` 启用了 `foreign_keys=ON`。新项目实体只写 core 时该 FK 会违约。修复：catalogSync 落 roll 前在 memory-state.projects 维护最小 bookkeeping 行（仅 0001 基础列），满足遗留 FK，实体负载仍只存 core。

**遗留（既存，超范围）**：
- `catalogSync.test.ts` test 14（archived → tombstoned）在 HEAD 已失败（`SessionStore.list({includeDeleted:true})` 按 Plan 506 C2 排除 archived），与 projects 迁移无关。
- `tierWriter.test.ts` 1 例文件名 hash 预期失败，无直接关联。

**Range note**：`projectResolver.ts`（含 `registerProject`）与 `pathsMigration.ts` 仍在使用 —— projectResolver 运行时经 catalogSync 传入 coreDb 实际读写 core 表；pathsMigration 仅被 legacy 脚本 `scripts/migrate-projects-paths.ts` 引用。两者与 Plan 305 纠缠，未删除（non-goal）。memory-state `projects` 表本身由 0001 创建（与 project_path_aliases/rollout_catalog 同库基础），为保护 Plan 305 保留 —— 验证标准"memory-state.projects 已为空/已删除"因 0001 纠缠无法完全满足。

---

## Phase 3: duya-main.db 子系统表迁移到 duya-core.db

> 调研后修订：~40 表并非全部适合进 core。按决策规则分类执行。✅ 完成 ✅

### 执行结果

**迁移完成：Research (15表) + Conductor (5表) → duya-core.db**

**Research 子系统**（15表）：
- `electron/db/core/research-store.ts` — 1945行，migration id 22/23/24
- `electron/db/core-connection.ts` — CoreStores.research
- `electron/agents/db-bridge.ts` — 38个 handlers 路由到 `getCoreStores().research.*`
- 覆盖：sessions, plan_steps, activities, events, sources, citations, reports, projects, project_states, memory_objects, hypotheses, candidates, relations, import

**Conductor 子系统**（5表）：
- `electron/db/core/conductor-store.ts` — migration id 25
- `electron/db/core-connection.ts` — CoreStores.conductor
- `electron/ipc/db-handlers.ts` — canvas CRUD + `conductor:snapshot` → core
- 遗留（complex事务，待后续）：`conductor:action/undo/redo/capture`

**死表清理**（P3C）：`automation_cron_runs/state` 由 legacy migration 50 DROP，无需额外操作；health-check 无引用

**测试**：research-store.test.ts (9例) + conductor-store.test.ts (8例) 全绿

**遗留（Phase 3.x / Phase 4）**：
- conductor:action/undo/redo/capture handlers（复杂事务逻辑）
- agent db-client.ts 返回值类型从 snake_case 迁移到 camelCase（camelCase store 返回值 vs agent 期望的 snake_case rows）
- `packages/agent/src/session/db.ts` 的 `model_capabilities` 副本与 main 的关系需梳理
- `gateway_user_map` / `gateway_message_map`（Gateway 子进程自有的 DB 实例）

**未迁移、留 legacy**：sidebar_sections, threads, chat_turn_reviews, weixin_accounts, model_capabilities, plugin_setup_values, app_connections, channel_bindings, channel_directory, channel_offsets, channel_permission_links

---

### Task 3.1: 迁移 Conductor 系列表 ✅ (2026-09-14)

```
conductor_canvases, conductor_canvas_groups, conductor_widgets,
conductor_actions, conductor_elements
```

- `electron/db/core/conductor-store.ts` — 5表 CRUD + migration id 25
- `electron/db/core-connection.ts` + `index.ts` 已更新
- `electron/ipc/db-handlers.ts` canvas handlers 已迁移

### Task 3.2: 迁移 Research 系列表 ✅ (2026-09-14)

```
research_projects, research_project_states, research_memory_objects,
research_hypotheses, research_memory_candidates, research_memory_relations,
research_sessions, research_plan_steps, research_activities,
research_events, research_sources, research_reports, research_citations,
import_batches, import_items
```

- `electron/db/core/research-store.ts` — 15表 + migrations 22/23/24
- `electron/db/core-connection.ts` + `index.ts` 已更新
- `electron/agents/db-bridge.ts` 38个 research handlers 路由到 core

### Task 3.3: 迁移其他子系统表 — 已修订（见遗留）

`gateway_*`、`channel_bindings`、`channel_directory` 等保持 legacy，待后续专项迁移。`automation_cron_*` 已由 legacy migration 50 DROP。

### Task 3.4: 更新 IPC handlers ✅ (2026-09-14)

Research: `electron/agents/db-bridge.ts`（38 handlers）  
Conductor: `electron/ipc/db-handlers.ts`（canvas CRUD + snapshot）

### Task 3.5: 标记 legacy schema 区域

暂未执行。schema.ts 注释更新留给后续批次。

### Task 3.6: 收敛 conductor_widgets / conductor_elements 双表（应用层实证）

> **触发**：调研 conductor 表迁移完成度时发现，`conductor_widgets` 与 `conductor_elements` 是双活状态而非单源过渡，下层 schema 与上层应用存在三层不一致。
>
> **应用层实证**（2026-09-18）：
>
> | 路径 | 协议 | 写入表 |
> |---|---|---|
> | ChatWidget → 画布（[chat-widget-to-canvas.ts:147](../packages/conductor/src/renderer/ipc/chat-widget-to-canvas.ts)） | `element.create` | 只 `conductor_elements` |
> | Agent 工具 `CanvasCreateElementTool` / `CanvasDeleteElementTool` | `element.create` / `element.delete` | 只 `conductor_elements` |
> | 渲染层 UI（CanvasArea 等 7 处） | `element.delete` | 只 `conductor_elements` |
> | 渲染层 UI（WidgetShell.tsx:72） | `widget.delete` | 双写 widgets + elements |
> | Agent 工具 CanvasConductor | `widget.*` | 双写 |
> | `electron/db/queries/conductors.ts:438` 注释 | — | 写「Widget CRUD — removed (zero external references)」，与 IPC handler 27 处实际双写矛盾 |
>
> **关键证据链**：
> 1. `electron/ipc/db-handlers.ts:2032-2184` 的 7 个 `widget.*` case 仍做双写（先 widgets 再 elements）
> 2. `electron/db/queries/conductors.ts:359-410` 的 `getCanvasSnapshot` 同时返回 elements + widgets
> 3. `conductor-store.ts:579-700` 提供完整 widget CRUD API，但全仓 grep 无外部调用方（plan 534 兼容垫）
> 4. 渲染层 store 同时持有 elements + widgets 两份 state，`getCanvasContents` 优先 elements，orphan widgets 用 `widgetToElementAdapter` 适配（[conductor-store.ts:1121-1130](../packages/conductor/src/renderer/stores/conductor-store.ts)）
>
> **决策**：保留 `conductor_elements` 为唯一真源，拆 `conductor_widgets`（应用层已全部走 `element.*`，widget.* 协议仅剩 WidgetShell.tsx:72 一处触发）。原因：
> - `element.*` 协议覆盖 ChatWidget、Agent、UI 三类调用方，已是 de-facto 主协议
> - `conductor_elements` schema 更通用（`element_kind` 容纳 widget/native/shape 多种 kind，`viz_spec` 字段为原生节点预留）
> - plan 534 已迁 5 表 → core，handler 路由迁移收敛时一并处理，避免半成品双活状态扩散
>
> **子任务**：
> 1. **Phase 3.6.a** 摸清所有 widget.* 调用方（计划 grep + 静态分析，列出所有触发点 + 类型 adapter）
> 2. **Phase 3.6.b** 迁移 widget.* 协议调用方到 element.*（如 WidgetShell.tsx:72 → element.delete）
> 3. **Phase 3.6.c** IPC handler 移除 widget.* case（27 处双写 SQL 一次清空）
> 4. **Phase 3.6.d** 删除 schema.ts 中 `CREATE TABLE conductor_widgets` + 相关索引（迁移 #17/#34/#35 保留以兼容老 DB，仅在 canonical 段移除）
> 5. **Phase 3.6.e** 加 migration #39（main + core 同步）：`DROP TABLE conductor_widgets; DROP INDEX IF EXISTS idx_conductor_widgets_canvas; DROP INDEX IF EXISTS idx_widgets_type;`
> 6. **Phase 3.6.f** `electron/db/core/conductor-store.ts` 同步：删除 `ConductorWidgetRow`、`getWidgets/createWidget/updateWidget/deleteWidget/getWidget`，清理 widget-element-adapter.ts 双向适配
> 7. **Phase 3.6.g** 测试更新：删除 `conductor-store.test.ts` 内 widgets 表断言，调整 `__tests__/conductor-store.test.ts` 第 42、74 行的预期
>
> **风险**：widget.* 协议对外暴露面未完全摸清（plan 534 兼容垫的设计正是为了在不确定时保留双活）。建议 Phase 3.6.a 先做静态扫描 + 灰度：在 dual-write 路径上加 `[CONDUCTOR_DUAL_WRITE]` 日志统计实际 widget.* 调用次数，连续一周 < 10 次/天后才进入 3.6.b。
>
> **回滚**：每子任务独立 commit，3.6.e 加 DROP 迁移可回滚（重新跑 schema migration 重建表）。
>
> **状态**：未开始（plan 534 Phase 3 主线完成后的下一个工作流）。

---

## Phase 4: 测试与验证（部分完成）

### Task 4.1: 单元测试 ✅

`electron/db/core/__tests__/research-store.test.ts` (9例) + `conductor-store.test.ts` (8例) 全绿。ProjectStore 测试 (8例) + projects-import 测试 (5例) 持续通过。

### Task 4.2: E2E 测试

待执行。

### Task 4.3: 手动验证

待执行。

---

## Phase 4: 测试与验证

### Task 4.1: 单元测试

为新创建的 `electron/db/core/projectService.ts` 编写单元测试。

### Task 4.2: E2E 测试

运行 `npm run test:e2e` 确保迁移后功能正常。

### Task 4.3: 手动验证

1. 打开 ProjectsView，确认项目列表正常显示
2. 创建新项目，验证写入 duya-core.db
3. 检查 memory-state.db 中 projects 表已为空/已删除

### Task 4.4: Typecheck

运行 `npm run typecheck:all` 确保无类型错误。

---

## Verification

1. `projects` 表存在于 `duya-core.db`，不在 `memory-state.db`
2. ProjectsView 正常显示项目列表
3. 创建/编辑/删除项目功能正常
4. 所有 duya-main.db 子系统表已迁移（或已标记为待迁移）
5. `npm run typecheck:all` 通过
6. `npm run test:e2e` 通过

---

## Dependencies

- Plan 326 (core-db foundation) - 已完成
- Plan 328 (core-db electron wiring) - 已完成
- Plan 329 (core-db legacy import) - 部分完成

---

## Open Questions

1. `chat_sessions` 表是否已迁移到 duya-core.db？需要确认
2. `settings` 表是否需要迁移？
3. `sidebar_section_projects` 表已在 duya-core.db，是否有重复的 migration？
