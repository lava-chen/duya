# Plan 525 — Project 实体建模 + Plans 文件目录新设计

> **Status**: Draft (待 Review)
> **Priority**: P1
> **Created**: 2026-09-12
> **Supersedes**: [522-plans-plugin-mcp](./522-plans-plugin-mcp.md)(**删除该 plan 文件,本 plan 完全替代**)
> **Sibling plans**:
> - [301-memory-v2-phase-1a-schema-projects-catalog](../completed/301-memory-v2-phase-1a-schema-projects-catalog.md) — `projects` 表来源(migration 0001)
> - [485-bot-storage-layout](./485-bot-storage-layout.md) — agents 存储布局(`~/.duya/agents/<id>/`)
> - [479-bot-memory-three-tiers](./479-bot-memory-three-tiers.md) — 三层记忆(own/user/project),**与本 plan 解耦**,不动
> - [493-bot-session-physical-isolation-and-generation-rotation](./493-bot-session-physical-isolation-and-generation-rotation.md) — session 隔离

---

## 1. 问题与目标

### 1.1 当前状态(写 plan 时的实测)

| 概念 | 现状 | 来源 |
|---|---|---|
| **`projects` 表** | 4 列:`project_id` / `canonical_root` / `created_at` / `last_seen_at` | `electron/memory-state/migrations/0001_init.sql.ts:33` |
| **`project_path_aliases` 表** | 已有,承担"路径 → project_id"反向查询;`alias_kind` 4 种工作目录类型(`workspace_override` / `working_directory` / `git_root` / `cwd`) | `electron/memory-state/migrations/0001_init.sql.ts:40` |
| **`agents` 表** | 在主 DB(`electron/db/schema.ts`),plan 485 落地 | plan 485 |
| **bot ↔ project 关联** | ❌ 不存在(`project_bots` 表缺失) | grep 验证 |
| **session ↔ project** | ✅ `rollout_catalog(scope_kind, project_id)` 已绑 | migration 0007 |
| **plan 522** | 设计在 `<workspace>/.duya/plans/active/*.md`,active 状态未实施;**本 plan 删除 522 并替代** | 522 文件 |
| **现有 `.duya/` 布局** | `~/.duya/{agents,agents-removed-...,sessions,workspace,MEMORY.md}`;`projects/` 不存在 | 实地验证 |
| **UI / 工具面** | ❌ 不做(用户明确:UI 先不考虑,工具 `manage_project` 不做,用户手动管理) | 用户 2026-09-12 指示 |

### 1.2 目标

1. **`projects` 表扩展为带名字、带描述、带路径列表、带 bot 成员的实体**
2. **路径列表用 JSON 列存放在 `projects` 表上,取代独立的 `project_path_aliases` 表**
3. **新增 `project_bots` 关联表(无 role,所有 bot 平等)**
4. **现有 `project_path_aliases` 数据迁移到 `projects.paths` JSON 列,完成后砍表**
5. **plans 文件目录从 plan 522 的 `<workspace>/.duya/plans/` 改为全局 `~/.duya/projects/<project_id>/plans/`**
6. **实现 plan 522 规划过的 3 个 MCP 工具:`plan_status` / `plan_search` / `plan_complete`,按新目录布局实现**

### 1.3 明确不做(非目标)

- ❌ **`manage_project` 工具** — 不进 BOT_TOOLSET,用户手动管理
- ❌ **ProjectCenter / PlanCenter UI** — 暂不做
- ❌ **项目 widget / plan widget** — 暂不做
- ❌ **`projects` 表加 `phase` / `goal` / `deadline` / `avatar_color` / `updated_at` / `owner_bot_id`** — 全不加
- ❌ **`alias_kind` 区分**(4 种工作目录类型全去掉)— 路径一律平等
- ❌ **路径加 `label` 字段** — 不加
- ❌ **`project_bots.role` 区分**(owner / lead / member / observer)— bot 全部平等
- ❌ **project-database / plan 元数据进数据库** — 不复用 plan 236 后端,plans 纯文件系统
- ❌ **跟三层记忆联动** — plan 479 三层记忆(own/user/project)不变,不动 project 实体
- ❌ **UI 任何形式** — 用户手动管理 = 命令行 / 直接 SQL / 直接编辑 JSON,不写 React 组件

---

## 2. 数据模型(最终)

### 2.1 `projects` 表(migration 0012)

| 列 | 类型 | 用途 | 默认值 / 约束 |
|---|---|---|---|
| `project_id` | TEXT PRIMARY KEY | UUID(沿用 0001) | NOT NULL |
| `canonical_root` | TEXT | 主路径(沿用 0001) | NULL(可空,因为现在有多 path 列表) |
| `name` | TEXT NOT NULL | 项目名,UI 显示 | `''` |
| `description` | TEXT | 一句话描述 | NULL |
| `paths` | TEXT NOT NULL | JSON 数组 `[{path, description}, ...]`,取代 `project_path_aliases` | `'[]'` |
| `created_at` | INTEGER NOT NULL | 沿用 | (不变) |
| `last_seen_at` | INTEGER NOT NULL | 沿用 | (不变) |

### 2.2 `project_bots` 新表(migration 0012)

```sql
CREATE TABLE project_bots (
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,  -- 无 FK:agents 在 duya-main.db,跨库 FK 不可行,完整性由应用层保证
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, bot_id)
);
CREATE INDEX idx_project_bots_bot ON project_bots(bot_id);
```

- 无 role 列,所有 bot 平等
- `joined_at` 留作审计(可选,不做强制约束)

### 2.3 `project_path_aliases` 表 → 删

- 不再单独建表
- 数据迁移到 `projects.paths` JSON 列(Phase 2)

### 2.4 `projects.paths` JSON 形状

```json
[
  { "path": "E:/Projects/duya", "description": "duya 主仓库" },
  { "path": "E:/Projects/duya-website", "description": "用户向官网" },
  { "path": "E:/Projects/duya-marketplace", "description": "插件市场" },
  { "path": "E:/Papers/duya-research", "description": "研究笔记" }
]
```

- **无 `alias_kind` 字段** — 一律平等
- **缺 `description` 时为 `NULL`**,不是空字符串
- JSON 解析失败的容错:程序读 `paths` 时若 JSON 损坏,**降级到空数组**而不是报错

### 2.5 "路径 → project_id" 反向查询的取舍

- 当前实现:`project_path_aliases` 表有索引,路径反查走索引
- 本 plan 后:反查走 `SELECT project_id, paths FROM projects`,程序里遍历 paths 数组匹配
- **用户接受这个取舍**:项目数和路径数小(< 100 个 project,每项目 < 10 个路径),全表扫描不是瓶颈
- 后续如果性能真的出问题,**加 SQLite FTS 或建反查物化表**(独立 plan),本 plan 不预设

---

## 3. Plans 文件目录布局

### 3.1 新布局(覆盖 plan 522)

```
~/.duya/projects/
  <project_id>/
    project.json              # 项目元数据(name / description / paths / bots 的快照,可选冗余)
    plans/
      index.json              # 该 project 下所有 plan 的索引(plan 522 的设计保留)
      active/
        <NNN>-slug.md         # NNN = 3 位序号,slug = kebab-case
        ...
      completed/
        <NNN>-slug.md
        ...
```

### 3.2 与 plan 522 的差异

| 维度 | plan 522 旧设计 | 本 plan 新设计 |
|---|---|---|
| 根位置 | `<workspace>/.duya/plans/` | `~/.duya/projects/<project_id>/plans/` |
| 作用域 | workspace 级 | 全局,跨 workspace |
| 多路径时 plans 归属 | 按 workspace 分散 | 按 project 统一归口 |
| plan ↔ project 关联 | frontmatter `project:` 字段 | 物理目录绑定,无需字段 |

### 3.3 plan 文档 frontmatter(沿用 plan 522,不变)

```yaml
---
id: 525
title: Project 实体建模 + Plans 文件目录新设计
priority: P1
status: active       # active / paused / done / blocked
tags: [project, plans]
created: 2026-09-12
updated: 2026-09-12
---
```

- `id` 全局唯一(用户手动维护,**冲突自负**,MCP 工具可检测并报警)
- `project` 字段**不需要**(目录已绑定)

### 3.4 `index.json` 形状

```json
{
  "projectId": "<project_id>",
  "plans": [
    {
      "id": 525,
      "slug": "project-entity-and-plan-management",
      "title": "Project 实体建模 + Plans 文件目录新设计",
      "status": "active",
      "priority": "P1",
      "tags": ["project", "plans"],
      "file": "active/525-project-entity-and-plan-management.md",
      "created": "2026-09-12",
      "updated": "2026-09-12"
    }
  ]
}
```

- 每次 plan 文件变更时更新 `index.json`
- MCP 工具读 `index.json` 即可,不必每次扫目录

---

## 4. Plan MCP 工具(3 个)

### 4.1 `plan_status`

| 项 | 内容 |
|---|---|
| 描述 | 列出指定 project 的活跃 plan |
| 输入 | `{projectId: string, status?: 'active' \| 'all'}`(默认 `active`) |
| 输出 | `[{id, slug, title, priority, tags, updated}]` |
| 实现 | 读 `~/.duya/projects/<projectId>/plans/index.json` |

### 4.2 `plan_search`

| 项 | 内容 |
|---|---|
| 描述 | 跨 project 搜索 plan |
| 输入 | `{query: string, scope?: 'all' \| 'project', projectId?: string}` |
| 输出 | `[{projectId, id, slug, title, snippet}]` |
| 实现 | 遍历 `~/.duya/projects/*/plans/`,对 `index.json` 的 title / tags 走关键字匹配;`query` 也可对 `*.md` 正文做 grep(可选,默认不扫正文) |

### 4.3 `plan_complete`

| 项 | 内容 |
|---|---|
| 描述 | 归档一个 plan(active → completed),自动更新 frontmatter 和 index.json |
| 输入 | `{projectId: string, planId: number}` |
| 输出 | `{ok: true, newFile: string}` |
| 实现 | 读 `active/<NNN>-slug.md` → 改 frontmatter `status: done` → 移动到 `completed/` → 更新 `index.json` |

---

## 5. Phases

### Phase 1 — DB schema(migration 0012)

> 2026-09-13: 迁移编号从 0013 改为 0012(memory-state 迁移实际只到 0011,0012 空闲)。
> 附带修复:0011 在全新 DB 上必然失败(`ALTER TABLE RENAME` 后旧索引名挂在备份表上,
> `CREATE INDEX idx_rollout_catalog_*` 撞名),已把索引创建挪到 `DROP TABLE backup` 之后。
> 无任何 DB 能成功记录过 0011(应用必抛错),故修改其 SQL 不触发 tamper check。

- [x] 1.1 创建 `electron/memory-state/migrations/0012_project_entity_minimal.sql.ts`:
  - `ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT '';`
  - `ALTER TABLE projects ADD COLUMN description TEXT;`
  - `ALTER TABLE projects ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';`
  - `CREATE TABLE project_bots (project_id, bot_id, joined_at, PRIMARY KEY(project_id, bot_id));`
  - `CREATE INDEX idx_project_bots_bot ON project_bots(bot_id);`
- [x] 1.2 更新 `electron/memory-state/schema.ts` 的 TypeScript 接口
  - 附带:`ProjectPathEntry` + `parseProjectPaths`(损坏 JSON 降级空数组)/ `serializeProjectPaths`
- [x] 1.3 单测:`__tests__/projectEntity.test.ts` 写读 name / description / paths(JSON) / project_bots 增删
  - 另:`migration.test.ts` 过时计数断言(0010 时代)已同步到 11 个迁移

### Phase 2 — 数据迁移

> 2026-09-13: 核心逻辑在 `electron/memory-state/pathsMigration.ts`(自包含无运行时依赖,
> 兼容 better-sqlite3 / node:sqlite),CLI 在 `scripts/migrate-projects-paths.ts`(node 直跑 TS)。
> 真实表 PK 是路径本身,同 path 多 kind 合并只在纯函数层可达(防御性保留)。
> **同 phase 附带**:`registerProject` 已切换为读写 `projects.paths`(砍表后 resolver 不断链),
> 反查按 §2.5 全表扫描取舍实现。`--apply` 前有内建停点(等用户 review 干跑报告)。

- [x] 2.1 `scripts/migrate-projects-paths.ts`(干跑默认,`--apply` 真跑)
- [x] 2.2 干跑脚本:读 `project_path_aliases` 全部行,按 project_id 聚合
  - 同一 `(project_id, absolute_normalized_path)` 多 alias_kind → 合并,`description` 取第一个非空
- [x] 2.3 输出报告 — **dev DB 实测(2026-09-13)**:30 project / 30 alias 行 / 一对一 / 无孤儿
- [ ] 2.4 `--apply` 模式:写入 `projects.paths`,验证 JSON 合法,删 `project_path_aliases` 表(代码已实现,等用户确认后对 dev DB 执行)
- [x] 2.5 单测:`__tests__/pathsMigration.test.ts`(合并 / NULL description / 孤儿拒绝 / 幂等 / 迁移后 resolver 兼容)

### Phase 3 — plans 目录布局实施

> 2026-09-13: 服务在 `electron/memory-state/projectService.ts`(`~/.duya/projects` 根,
> DUYA_TEST 命名空间感知,与 tier-rpc 同语义);index.json 写入走 temp+rename,
> 读取损坏/缺失降级空索引。生产调用方暂无(UI/manage_project 均为非目标),
> createProject 是纯服务层 API,等 Phase 4 工具 / 手动管理使用。

- [x] 3.1 `~/.duya/projects/<project_id>/plans/` 目录创建工具(`ensurePlansDirs`,由 `projectService.ts::createProject` 调用)
- [x] 3.2 `index.json` 生成函数(`writePlansIndex(projectId, plans)`,plan §3.4 形状)+ `readPlansIndex`
- [x] 3.3 `project.json` 可选冗余文件(Phase 3 不强求,留为后续优化)
- [x] 3.4 单测:`__tests__/projectService.test.ts`(8 用例:目录创建 / index.json 序列化 / canonical_root 派生 / UNIQUE 透传 / 损坏降级)
- [x] 3.5 dogfood:dev DB 里 duya project(`e4e2b217`)的 plans 骨架已在 `~/.duya/projects/` 建好

### Phase 4 — plan MCP 工具

> 2026-09-13: 落地为 builtin 插件 `packages/plugin-core/src/plugins/builtin/plans/`。
> 与 522 设计的两处偏差:(1) MCP 声明用仓库现行约定 `mcp/servers.json`(非
> capabilities.mcpServers);(2) **不做 esbuild bundle**——server 是零依赖手写
> stdio JSON-RPC(`plans-server.cjs`)+ 存储层(`plans-core.cjs`),插件目录原样
> 分发、node 直接跑,免去构建链与 ABI 问题。索引按 522 的"派生缓存"哲学:
> 每次读全量重扫对账 index.json,直写文件天然被发现。
> `projectId` 全部过 `^[a-zA-Z0-9_-]{1,64}$` 白名单后才碰文件系统。

- [x] 4.1 3 个工具实现(`server/plans-core.cjs` 存储层 + `server/plans-server.cjs` MCP 线协议层)
- [x] 4.2 插件封装:`.duya-plugin/plugin.json` + `mcp/servers.json`(stdio,`node ./server/plans-server.cjs`,相对路径按 pluginRoot 解析已由 resolve.ts 支持)
- [x] 4.3 单测:`packages/plugin-core/tests/plugins/plans-tools.test.ts`(10 用例:status 过滤 / 跨 project 搜索 / complete 移动+frontmatter 改写 / 幂等与错误面 / 直写文件发现 / wire 协议)
- [x] 4.4 dogfood:duya project(`e4e2b217`)真实根目录跑通 — 直写 `900-plans-plugin-dogfood.md` → 真实 spawn server 走 wire 协议 init/list/status/search → `plan_complete` 归档 → `plan_status` 复查为空

### Phase 5 — 文档 + 删除 plan 522

- [ ] 5.1 `rm docs/exec-plans/active/522-plans-plugin-mcp.md`
- [ ] 5.2 更新 `docs/exec-plans/README.md` 索引(522 → 525)
- [ ] 5.3 `ARCHITECTURE.md` 增加 "Project 实体" + "Plans 文件目录" 两节
- [ ] 5.4 `AGENTS.md` 增加 plans 目录约定(简要,不重复 plan 525 内容)

### Phase 2.5 — renderer IPC 暴露(为下游 UI 铺路,非 UI 本体)

> 2026-09-13: plan 530(多路径侧栏渲染)推进时发现 renderer
> 完全读不到 `projects` 表 — `projectService.listProjects /
> registerProject` 是 main 进程纯函数,没暴露 IPC。本 phase 在
> **不违反 §1.3 "UI 任何形式不做" 边界**的前提下补这一缺口:
> 只写 main 进程 IPC 通道 + preload 暴露,无 React 组件 / 无 CSS
> / 无 hooks(hooks 在 plan 530 Phase 2)。

- [ ] 2.5.1 新建 `electron/ipc/project-entity-handlers.ts`(参考 `project-database-handlers.ts` 模式):
  - `ipcMain.handle('projects:list', ...)` → 调 `projectService.listProjects()`,返回 `ProjectRow[]`
  - `ipcMain.handle('projects:get', (_, { projectId }) => ...)` → 单条查询(后续 plan 530 hook 用)
  - `ipcMain.handle('projects:register', (_, input) => ...)` → 调 `registerProject`(已有纯函数,补 IPC 暴露)
  - JSON 损坏容错: 读 `paths` 字段时 `parseProjectPaths` 失败降级为 `[]` 数组(与 §2.4 一致)
  - 错误返回 `ProjectEntityError` 结构化错误码
- [ ] 2.5.2 `electron/preload.ts` 暴露:
  - `window.electronAPI.projects.list(): Promise<ProjectRow[]>`
  - `window.electronAPI.projects.get(projectId: string): Promise<ProjectRow | null>`
  - `window.electronAPI.projects.register(input: RegisterProjectInput): Promise<{ projectId: string }>`
  - 与现有 `projectDatabase` 命名风格一致(小驼峰 + 嵌套对象)
- [ ] 2.5.3 `electron/ipc/index.ts` 注册 `registerProjectEntityHandlers()`(在 `boot.json` 加载顺序中插在 plans 注册之后)
- [ ] 2.5.4 单测: `electron/ipc/__tests__/project-entity-handlers.test.ts`
  - 调真实 main 进程 `getMemoryDb()` + `registerProject` 写入测试数据,验证 IPC 返回
  - `paths` 字段 JSON 损坏时 list/get 都降级为 `[]`,不抛
  - `registerProject` paths 为空时抛 `ProjectEntityError{ code: 'EMPTY_PATHS' }`
  - 用 `vi.hoisted` + `vi.mock` 模式(参照 `logger-handlers.test.ts`)
- [ ] 2.5.5 Phase 2.5 完成判据: `npx vitest run electron/ipc/__tests__/project-entity-handlers.test.ts` 全绿,`npm run typecheck:all` 过

**边界声明**(避免被误读为 UI):
- 不写 React 组件
- 不写 CSS
- 不写 renderer hooks(`useProject` / `useActiveProjectId` 在 plan 530 Phase 2.1/2.2)
- 不暴露 `paths` 字段的"在 renderer 端编辑"路径 — `registerProject` IPC 暴露只给"创建/更新 project"用,UI 层编辑等专门 plan

---

## 6. 验证

- 每个 phase 提交前:`npm run typecheck:all`
- Phase 1: `npx vitest run` 从仓库根
- Phase 2: 干跑脚本输出报告,用户 review 后 `--apply`
- Phase 3/4: 单测 + 手动 dogfood(创建 test project,创建 plan,跑 plan_complete)
- 端到端:用一个真实 project(如 duya 自身)走通整条链路 — 创建 project → 加多 path → 加 bot 成员 → 创建 plan → plan_status → plan_complete

---

## 7. 风险与开放问题

- **`canonical_root` 是否能变 NULL?** 0001 里是 NOT NULL。本 plan 需要放宽,因为现在 `paths` JSON 才是真理源。如果旧数据全有 `canonical_root`,可以保留 NOT NULL,新 project 不强求必填。**Phase 1 决定保持 NOT NULL,新 project 通过 `paths[0].path` 隐式派生**。
- **`project_id` slug vs UUID**:0001 用 UUID,本 plan 不改。slug 化是后续独立 plan。
- **多 workspace 同 project 的 `project.json` 冗余**: Phase 3 暂不做冗余,如果出现并发写冲突再回头加。
- **plan frontmatter 的 `project` 字段**: plan 522 有,本 plan **移除**——目录已经绑定,字段冗余。但已落地的 plan 文件如有此字段,**不删,只是忽略**。
- **`research_projects` 表去留**: plan 423 独立表,与 `projects` 表不通。本 plan **不强制合并**,留为独立 plan。
- **worktree 下 plan 数据库 / 目录一致性**: worktree 各自管各自的 `~/.duya/projects/<project_id>/plans/`,不冲突(因为 `~/.duya/` 是用户级,不进 worktree)。

---

## 8. 完成判据

- [x] Phase 1 migration 0012 已合并,DB schema 升级
- [ ] Phase 2 数据迁移完成,`project_path_aliases` 表已删,`projects.paths` 有数据
- [ ] Phase 3 创建 project 时自动建 `~/.duya/projects/<id>/plans/` 目录
- [ ] Phase 4 三个 plan MCP 工具可用
- [ ] Phase 5 plan 522 已删,文档已更新
- [ ] 用 duya 自身项目走通整条链路 dogfood
- [ ] 计划文件移入 `completed/`,索引更新

---

## 9. Out of scope(明确延后)

- ❌ bot 互相通信重新定位(plan 477/478) — 独立 plan
- ❌ bot 主动推送到桌面 widget(C4 缺口) — 独立 plan
- ❌ bot 记忆语义检索 — 独立 plan
- ❌ UI(任何形式)— 用户指示暂不做
- ❌ `manage_project` 工具 — 用户指示不做
- ❌ plan-database 后端(plan 236 复用)— plans 纯文件系统,不上数据库
- ❌ plan 进度统计 / 看板 — 独立 plan
- ❌ 多用户协作 — 不做
