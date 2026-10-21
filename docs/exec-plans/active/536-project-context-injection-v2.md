---
id: 536
title: Project 上下文注入 v2 — Session/Plan/Memory/Loader 五层整合
priority: P1
status: in-progress
tags: [project, plans, session-bootstrap, memory, agents-md]
created: 2026-09-15
updated: 2026-09-16
supersedes: []
sibling-plans:
  - 525-project-entity-and-plan-management — 项目实体建模（路径反查 API 复用）
  - 534-projects-core-db-and-main-db-migration — projects 表迁 duya-core.db（数据源）
  - 474-bot-system-prompt-sections — bot section 框架（系统提示拼装点）
  - 479-bot-memory-isolation-tiers — 三层 memory section（memory 注入复用）
  - 408b-nested-agents-md-loading — nested AGENTS.md loader（cwd 扫描复用）
  - 408-agents-md-loader-alignment — AGENTS.md 加载对齐（system-reminder 包裹复用）
---

# Plan 536 — Project 上下文注入 v2

> **Status**: In Progress · **Priority**: P1 · **Created**: 2026-09-15
>
> **Layer status**:
> - ✅ L1 — session bootstrap injection (`ToolUseContext.currentProjectId`)
> - ✅ L2 — PlanTool projectId optional + context fallback (`73af9238` via PR #53)
> - ✅ L4 — `projects:resolveProject` cwd→projectId reverse-lookup API
> - ✅ L5 — CLI `projects cleanup` subcommand for empty uuid dirs (`c1d43ae0` via PR #53)
> - ⏳ L3 — memory section displays the current project
>
> **本文档由一个 agent 建议触发**：在某次会话中，agent 走了 5 步才从 cwd
> 匹配到当前 projectId（`95bd37a5-...`），暴露出 duya 当前在
> session/plan/memory/loader 四层之间没有统一的 project 上下文注入通道。
>
> **本 plan 不是从零造一套 5 层注入**，而是把已经在做这件事的活跃 plan
>（525/534/474/479/408b）的能力**收拢成一个最小可用的统一通道**，
> 让"agent 不知道自己在哪个项目"这种症状被根除。

## 0. 触发事件与根因分析

### 0.1 触发事件

2026-09-15 一次会话：agent 处理用户问题需调用 plan 工具查 active 计划，
但是 plan 工具强制要求 `projectId`（`PlanTool.ts:175,183` zod schema），
agent 不知道当前会话对应哪个 projectId，于是：

1. 读 `~/.duya/config.toml` 的 `[projects]` 段 → 空的（误导：以为没项目）
2. ls `~/.duya/projects/` → 39 个 UUID 目录 + 1 个 `duya` 孤儿
3. 对比各目录的 mtime / AGENTS.md / plans → 人工匹配到 cwd
4. 5 步后才找到正确的 `projectId=95bd37a5-...`

整个过程本应零步（agent 启动时就被告知）。

### 0.2 根因（六条）

| # | 根因 | 严重度 | 现有覆盖 |
|---|---|---|---|
| 1 | `PlanTool` zod schema 强制 `projectId` (`PlanTool.ts:175,183`) | **P0** | ❌ 无 |
| 2 | session bootstrap 不向 agent 注入 `currentProjectId` (`agent-shell.ts:187` 只透传 `researchProjectId`) | **P0** | ❌ 无 |
| 3 | cwd → projectId 没有反查接口 | **P1** | ⚠ plan 525 §2.5 已设计 `projects.paths` JSON 数组遍历，但**未实现反查 API 端点** |
| 4 | 38 个空 `~/.duya/projects/<uuid>/` 目录 + 1 个 `duya` 孤儿（`project_name='duya'` 命名遗留） | **P1** | ❌ 无 |
| 5 | memory system prompt 不显示"当前项目 scope" | **P1** | ⚠ plan 479 §3.2 正在做 `memoryProject` section，但**当前项目的 project_id 不在 system prompt 里** |
| 6 | AGENTS.md loader 不知道 session 已绑定的 project entity home | **P2** | ⚠ plan 408b 已有 nested-loader，但**没接 projects.paths 反查** |

### 0.3 agent 原建议的纠偏

agent 原始建议中的"cwd → projectId 反查作为 L1 主入口"是**误诊**。
反查应该是 fallback，不是主路径——主路径是"session bootstrap 注入"。
本 plan 采用：

> **L1（注入）优先 → L4（反查）作为 L1 缺省时的兜底**

---

## 1. 目标与非目标

### 1.1 目标

定义一个**统一的 project context 通道**，让下面五件事都从同一个数据源读：

```
session.workingDirectory
       │
       ▼
[反查: projects.paths 数组遍历]  ← 525 §2.5 + 本 plan L4
       │
       ▼
currentProjectId ──┬── system prompt <env> 注入           ← 本 plan L1
                   ├── PlanTool 缺省 projectId             ← 本 plan L2
                   ├── memory section 显示当前 scope       ← 本 plan L3
                   └── AGENTS.md loader 优先 entity home    ← 本 plan L4
```

落到代码上的最小集合：

1. **session bootstrap** 写 `currentProjectId` 进 system prompt `<env>` 块
2. **PlanTool** 把 `projectId` 改成 optional，缺省从 env 拿
3. **memory section** 在 system prompt 里显示"current project = <id> / <name>"
4. **AGENTS.md loader** 优先用 `projects.paths` 反查的 entity home，不再仅靠 cwd 祖先 walk
5. **CLI 清理**：38 个空 `~/.duya/projects/<uuid>/` + `duya` 孤儿归档

### 1.2 非目标（明确不做）

- ❌ **不做 UI**：plan 525 §1.3 已明确"UI 暂不做"，本 plan 跟随
- ❌ **不做 `manage_project` 工具**：plan 525 §1.3 已明确
- ❌ **不做 cwd → projectId 之外的"智能反查"**（如 git remote、文件内容）—— 反查就这一种
- ❌ **不动 plan 525/534/474/479/408b 已有设计的核心** —— 本 plan 只在他们落地后做"接线"
- ❌ **不修改 memory 三层语义**（plan 479）—— 只在 system prompt 里显示当前 scope
- ❌ **不自动归档 38 个空目录的内容**（没有内容可归档）—— 直接 rm

### 1.3 实施前置（依赖计划）

| 依赖 | 状态 | 等待点 |
|---|---|---|
| plan 525 projects.paths schema | ✅ Phase 2 数据迁移已设计 | 待 plan 落地 |
| plan 534 projects 表迁 duya-core.db | 🔄 Phase 3 done, projects 本身待迁 | **本 plan 必须等 534 落地后再做 L1/L3**，否则读不到 projects 数据 |
| plan 474 bot section 框架 | ✅ Phase 1-3 部分完成 | L1 复用 `packages/agent/src/prompts/bot/framework.ts` 的 `botEpoch/summaryEpoch` 双键纪元 |
| plan 479 memory tiers | 🔄 Phase 1-2 完成，Phase 3 待办 | L3 复用 `packages/agent/src/prompts/bot/memory/`，但当前项目 ID 注入是新的 |
| plan 408b nested-loader | ✅ Phase A-C 完成 | L4 调用其发现机制 |

---

## 2. 设计（5 层整合）

### 2.1 L1 — Session bootstrap 注入 currentProjectId

**触发点**：`packages/agent/src/session/agent-shell.ts:187` 附近，
`buildAgentContext()` 末尾增加一次查询。

**数据流**：

```
session.workingDirectory
    │
    ▼
projectResolver.resolveByPath(workingDirectory)  ← 见 L4
    │
    ▼
{ projectId, projectName, canonicalRoot } | null
    │
    ▼
ctx.env.currentProject = { id, name, canonicalRoot } | null
    │
    ▼
system prompt <env> 块（新增字段）
```

**`<env>` 块渲染**（在 474 框架下作为新增 SectionDef）：

```ts
// packages/agent/src/prompts/bot/projectContext.ts
export const projectContextSection: SectionDef = {
  id: 'projectContext',
  order: 50,  // 在 botIdentity 之前
  type: 'dynamic',
  budget: 600,
  render(ctx) {
    if (!ctx.env?.currentProject) {
      return '## Current project\n\n(no project bound to this session)';
    }
    const p = ctx.env.currentProject;
    return `## Current project\n\n- id: \`${p.id}\`\n- name: ${p.name}\n- root: \`${p.canonicalRoot}\`\n\nUse \`plan\` tool with this projectId, or omit it (auto-fills).`;
  },
};
```

**注意**：不破坏 474 的双键纪元框架；本 section 的 cache key 与 `botIdentity` 同源。

### 2.2 L2 — PlanTool projectId 改 optional

**文件**：`packages/agent/src/tool/PlanTool/PlanTool.ts:135-186`

**变更**：

```diff
   properties: {
     action: { ... },
     projectId: {
       type: 'string',
-      description: 'Project ID (e.g. e4e2b217). Required for status and complete actions.',
+      description: 'Project ID (e.g. e4e2b217). Optional — falls back to current project context if omitted (auto-resolved from session workingDirectory). Required only when operating on a non-current project.',
     },
     ...
   },
   required: ['action'],
   allOf: [
     {
       if: { properties: { action: { const: 'status' } } },
-      then: { required: ['projectId'] },
+      then: {}  // 不再硬要求，execute() 内部从 ctx 拿
     },
     ...
   ]
```

**execute() 内部**：

```ts
async execute(input, _wd, context) {
  const { action, projectId, ... } = input;
  const resolvedProjectId = projectId ?? context?.currentProjectId ?? null;
  if ((action === 'status' || action === 'complete') && !resolvedProjectId) {
    return toResult(this.name,
      '**Error**: projectId required (no current project in session context). ' +
      'Pass projectId explicitly or ensure session has a workingDirectory under a known project.',
      true);
  }
  // ... 用 resolvedProjectId 替换 projectId
}
```

**ToolUseContext 新增字段**：`currentProjectId: string | null`

### 2.3 L3 — Memory section 显示当前 project scope

**文件**：`packages/agent/src/prompts/bot/memory/sections.ts`（plan 479 落地后）

**修改**：在 `memoryProject` section 渲染函数顶部加：

```ts
render(ctx) {
  const current = ctx.env?.currentProject;
  if (current) {
    // 显式标注：以下 memory 来自当前项目 <id> / <name>
    header = `## Memory (project: ${current.name})\n\n`;
  } else {
    header = '## Memory (no current project — listing all accessible projects)\n\n';
  }
  ...
}
```

**注意**：不动 plan 479 的"三层 + via 溯源 + cap 3"逻辑，只在文案上增加当前项目提示。

### 2.4 L4 — Project 反查 API

**新增文件**：`packages/agent/src/project/resolver.ts`

```ts
export interface ProjectResolver {
  /**
   * Resolve a working directory to a project entity.
   * Walks `projects.paths` JSON arrays (plan 525 §2.4) and matches
   * by longest-prefix. Returns null if no project contains the path.
   */
  resolveByPath(workingDirectory: string): Promise<ResolvedProject | null>;
}

export interface ResolvedProject {
  projectId: string;
  name: string;
  canonicalRoot: string;
  matchKind: 'exact' | 'ancestor' | 'descendant';
  matchedPath: string;
}

export function createProjectResolver(opts: {
  db: BetterSqliteDatabase;  // duya-core.db (plan 534 落地后)
}): ProjectResolver;
```

**调用点**：

- session bootstrap (L1) — 主路径
- AGENTS.md loader (嵌套 plan 408b) — fallback

**算法**：

```
projects = SELECT project_id, name, canonical_root, paths FROM projects;
for p in projects:
  paths = JSON.parse(p.paths);  // 兼容损坏 → []
  for pathEntry in paths:
    abs = normalize(pathEntry.path);
    if workingDirectory == abs: return { matchKind: 'exact', ... }
    if isAncestor(abs, workingDirectory): candidates.push({ matchKind: 'descendant', ... })
    if isAncestor(workingDirectory, abs): candidates.push({ matchKind: 'ancestor', ... })
return candidates.length > 0 ? longestPrefix(candidates) : null
```

**性能**：plan 525 §2.5 已接受"全表扫描"取舍（< 100 project × < 10 paths）。

### 2.5 L5 — CLI 清理工具

**新增文件**：`packages/cli/src/commands/projects-cleanup.ts`

**子命令**：

```bash
duya projects cleanup [--dry-run] [--archive-dir <path>]
```

**行为**：

1. 扫描 `~/.duya/projects/` 下所有目录
2. 对每个目录：判断是否"空"（无 plans/*.md + AGENTS.md 是模板默认）
3. 对空目录：默认 `--dry-run` 列出 + 提示，非 dry-run 时 `rm -rf`（需用户二次确认）
4. 对 `projects/duya/` 这种非 UUID 命名：单独列出 + 提示"历史 project_name='duya' 遗留，建议归档到 `<archive-dir>/duya-<timestamp>/`"
5. 写一份 `cleanup-report-<timestamp>.json` 到 stdout，记录处理前后状态

**安全**：

- 默认 `--dry-run`，必须显式 `--apply` 才执行
- 对 `duya` 这种非 UUID 名**永不直接删**，只建议归档
- 对每个被清理的空 UUID 目录，stdout 输出"删除前 contents: <列出>"，避免误删有内容的项目

---

## 3. 分阶段实施

### Phase 0 — 等前置 + 起 worktree

- [ ] **G0.1** 确认 plan 534 Phase 4 (projects 表迁 duya-core.db) 已落地
  - 不落地时，本 plan Phase 1 用 mock data 跑通
- [ ] **G0.2** 起 worktree `.claude/worktrees/536-project-context-injection`，基于 origin/master
- [ ] **G0.3** junction node_modules（per AGENTS.md §Worktree → PR workflow）
- [ ] **G0.4** 跑 `npm run typecheck:all` 绿

### Phase 1 — 反查 API（L4 解锁其他所有层）

- [ ] **P1.1** `packages/agent/src/project/resolver.ts` — `createProjectResolver()` 工厂
- [ ] **P1.2** 单测：`resolver.test.ts` 覆盖 exact / descendant / ancestor / 无匹配 / JSON 损坏 / 空 paths 数组
- [ ] **P1.3** e2e：`packages/agent/tests/e2e/project-resolver.spec.ts`（用 test namespace）

### Phase 2 — L1 注入

- [ ] **P2.1** `packages/agent/src/session/agent-shell.ts:187` 附近接入 resolver
- [ ] **P2.2** `packages/agent/src/prompts/bot/projectContext.ts` — SectionDef
- [ ] **P2.3** PromptSystemConfig 注册 `projectContextSection`（follow 474 模式）
- [ ] **P2.4** ToolUseContext 增加 `currentProjectId: string | null`
- [ ] **P2.5** 单测：`projectContext.test.ts`（无 project / 有 project / 缓存键双键纪元）

### Phase 3 — L2 PlanTool 改造

- [ ] **P3.1** `PlanTool.ts:135-186` schema 改 optional
- [ ] **P3.2** `PlanTool.ts:192-225` execute() 加 fallback
- [ ] **P3.3** 单测：`PlanTool.test.ts` 增加"缺省 projectId 时从 ctx 拿"
- [ ] **P3.4** e2e：test namespace 下启 session 跑 plan tool，确认零 projectId 调用成功

### Phase 4 — L3 memory section 显示

- [ ] **P4.1** `packages/agent/src/prompts/bot/memory/sections.ts` 文案增强
- [ ] **P4.2** 单测覆盖"有/无 currentProject"两种文案

### Phase 5 — L4 AGENTS.md loader 接入

- [ ] **P5.1** `packages/agent/src/agentsmd/loader.ts:477` 附近：在 walk 之前先调 resolver
- [ ] **P5.2** 命中时把 entity home 加进 sources（不替代 cwd walk）
- [ ] **P5.3** 单测：`loader.test.ts` 覆盖"resolver 命中 + cwd walk 命中"两种

### Phase 6 — L5 CLI 清理

- [ ] **P6.1** `packages/cli/src/commands/projects-cleanup.ts`
- [ ] **P6.2** 注册 `duya projects cleanup`
- [ ] **P6.3** 单测：mock `~/.duya/projects/` 下各种结构

### Phase 7 — 验收

- [ ] **G7.1** `npm run typecheck:all` 绿
- [ ] **G7.2** `npm run test` 绿（vitest unit）
- [ ] **G7.3** `npm run test:e2e` 绿（plan tool e2e）
- [ ] **G7.4** 文档：README 增补"session → project 上下文"小节
- [ ] **G7.5** ARCHITECTURE.md 增补"project context 通道"章节
- [ ] **G7.6** release notes：新增 `536-project-context-injection.md`

---

## 4. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 反查全表扫描性能差 | 接受 plan 525 §2.5 取舍（< 100 × < 10 paths）；监控加 log warn | 加 SQLite FTS 物化（独立 plan） |
| `currentProjectId` 污染 system prompt 隐私 | 仅在 session 自己的 workingDirectory 下查；不查 workingDirectory 外的 path | 字段可 disable（474 风格的 section enable/disable） |
| L5 误删非空目录 | `--dry-run` 默认；列出删除前 contents | 已删的目录从 trash 恢复（macOS）/ VSS（Windows，依赖系统） |
| PlanTool projectId optional 导致历史 session 行为变化 | execute() 内部错误信息明确（"no current project"），不静默失败 | schema 改回 required（一行 revert） |
| L1 等 plan 534 落地 | Phase 0 G0.1 检查；不落地时 mock data 跑通 Phase 1 | 暂搁置 L1-L3，先做 L4+L5 |

---

## 5. 验证（落地后）

让一个 agent 重新触发原触发事件（"在 cwd `e:/lavachen/家教` 启会话要查 plan"），
预期：

| 步骤 | 原行为 | 落地后行为 |
|---|---|---|
| 1 | 读 config.toml `[projects]` | 跳过（不需要） |
| 2 | ls `~/.duya/projects/` | 跳过（不需要） |
| 3 | 对比 mtime / AGENTS.md | 跳过（不需要） |
| 4 | 人工匹配 cwd | 跳过（不需要） |
| 5 | 找到 `projectId=95bd37a5-...` | 0 步 — system prompt `<env>` 块直接写 `currentProject: { id: '95bd37a5-...', name: '家教', root: 'e:/lavachen/家教' }` |

且调用 `plan` 工具时不传 projectId 也能成功（auto-fill）。

---

## 6. 决策记录

- 2026-09-15 — 起 plan。原 agent 建议 L1 = cwd 反查被纠偏为 L1 = session bootstrap 注入（cwd 反查降为 L4 fallback）。理由：主路径不该让 agent 重新发现自己的 project。
- 2026-09-15 — 不动 plan 525/534/474/479/408b 核心，仅在他们落地后做"接线"。理由：避免与活跃 plan 撞车，每个 plan 单独 ship 可合并。
- 2026-09-15 — L5 默认 `--dry-run`，永不直接删 `duya` 非 UUID 名。理由：38 个空目录是真实数据但 `duya` 孤儿可能有用户配置引用。

---

## 7. 关联文档

- [ARCHITECTURE.md](../../ARCHITECTURE.md) § Profile/Mode/Permission（474 引用）
- [ARCHITECTURE.md](../../ARCHITECTURE.md) § IPC Architecture（L1 数据流）
- plan 525 §2.4 projects.paths JSON 形状
- plan 534 §3 phases（projects 表迁 duya-core.db）
- plan 474 §2.1 bot section 模块群
- plan 479 §3.2 三层注入
- plan 408b nested-loader 阶段产物