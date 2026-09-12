# Plan 522 — Plans Plugin: MCP 化的执行计划管理

> 状态字段以本文件 frontmatter 为准（本 plan 是新存储格式的第一个使用者）。

## 背景与动机

当前 plan 体系 = `docs/exec-plans/README.md`（手维护的大表格索引）+ `active/`/`completed/` 下的 markdown 文件。
每次开工 agent 要整读几百行 README 才能知道当前状态；更新状态要 Read 整文件 + Edit；
新 plan 文件被 gitignore 规则 `docs/*/` 吞掉需要 `git add -f`；完成迁移（active → completed）
要手工移动文件并同步两处索引。

目标：把 plan 管理做成一个 **duya 插件**，插件自带一个 **stdio MCP server**，
用结构化工具（`plan_status` / `plan_get` / `plan_create` …）替代 README 整读和手工文件操作。
存储放在**项目目录**下的 `.duya/plans/`，随仓库走。

**用户已拍板的决策**：

- 存储位置：`<workspace>/.duya/plans/`（项目级，非全局 `~/.duya/`）。
- 形态：duya 插件（manifest + MCP server + skill），不是 agent 内置工具——顺带 dogfood 插件/MCP 管线（plan 455/498 已落地的栈）。

## 存储设计

```
<workspace>/.duya/plans/
├── index.json        # 派生索引（可随时从 frontmatter 全量重建）
├── active/
│   └── 522-plans-plugin-mcp.md
├── completed/
└── obsolete/         # 替代现在的 "OBSOLETE → NNN" 行内标记
```

- 存储天然按仓库隔离，**不需要** repo-id 命名空间。worktree 是独立检出，
  各自拥有自己的 `.duya/plans/`——并行会话天然互不踩；主检出与 worktree 的 plan
  差异随分支合并自然收敛。
- **frontmatter 是唯一结构化事实源**（YAML）：

```yaml
---
id: 522
title: Plans Plugin: MCP 化的执行计划管理
priority: P0            # P0 | P1 | P2
status: active          # active | completed | obsolete
superseded_by: null     # obsolete 时指向接替 plan id
tags: [plugin, mcp]
created: 2026-09-12
updated: 2026-09-12
---
```

- `index.json` 只缓存 `{id, slug, title, priority, status, tags, updated, path}`；
  任何写操作后原地更新，读操作优先走索引、损坏/缺失时全量扫描重建（自愈）。
- 正文（阶段/checkbox/进度记录）保持 markdown，工具做**定点改写**（frontmatter 字段替换、
  checkbox 行替换），不整文件重写，保留人工直接编辑文件的兼容性。
- **Git 跟踪**：`.duya/plans/` 默认纳入版本控制（这是相对旧 `docs/exec-plans/` 的改进——
  旧位置被 `docs/*/` gitignore 规则吞掉，新文件要 `git add -f`）。若 `.duya/` 下将来有
  其他非 git 数据，只对 `plans/` 子树做 gitignore 例外，其余默认忽略。

## 插件设计

```
packages/plugin-core/src/plugins/builtin/plans/
├── .duya-plugin/plugin.json     # manifest，声明 capabilities.mcpServers
├── skills/
│   └── plan-management/SKILL.md # 何时用哪组工具；禁用插件时的文件 fallback 说明
├── server/
│   └── plans-server.cjs         # esbuild 产物（构建期 bundle，零运行时依赖树）
└── README.md
```

- manifest `capabilities.mcpServers`: `[{ name: "plans", transport: "stdio",
  command: "node", args: ["./server/plans-server.cjs"] }]`。
  ⚠️ 检查点：确认 `plugin-core/src/mcp/resolve.ts` 对 `command`/`args` 的相对路径
  按 plugin `installPath` 解析；若不支持相对 cwd 需在 resolve 侧补齐。
- **工作目录来源**：MCP server 以会话的 workspace 为根定位 `<workspace>/.duya/plans/`
  （启动参数或环境变量注入，实施时对齐 agent worker 现有 workspace 传递链路；无
  workspace 的会话该 server 不注入工具）。
- **工具门控**：通过 `packages/agent/src/config/tool-exposure.ts` 限制暴露——默认仅对
  开发者/内部 profile 暴露，避免占用普通会话的 schema 预算（对齐 plan 480 的约束）。

## MCP 工具契约（6 个，单 server 收口）

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `plan_status` | `{}` | 活跃 plan 紧凑列表（id/title/priority/status/最近 updated），替代整读 README |
| `plan_get` | `{id}` | frontmatter + 正文（可 `include_body: false` 只取元数据） |
| `plan_search` | `{query}` | title/tags/正文匹配，返回 id + 片段 |
| `plan_create` | `{title, priority?, tags?, body?}` | 分配下一个全局递增 id，slug 化文件名，写入 `active/` |
| `plan_update` | `{id, status?, priority?, note?}` | frontmatter 定点更新；`note` 追加到正文 `## Progress` 段（自动带日期） |
| `plan_complete` | `{id}` | status=completed → 移入 `completed/`，索引同步（obsolete 用 `plan_update(status)` + `superseded_by`） |

- id 分配：仓库内独立计数（`index.json` 里存 `nextId`，重建时取 max+1 兜底）。
- 错误面：id 不存在 / frontmatter 损坏 / 并发写冲突（写前 mtime 校验）返回结构化错误，
  不静默。

## Git 取舍（相比旧体系是净收益）

plan 文件继续在版本控制内：git 历史覆盖 plan 演进、PR review 能看到 plan diff、
worktree 经合并自然同步——旧体系的三个痛点（gitignore 吞新文件、手工 add -f、
README 与文件双处手工同步）全部消失。唯一变化是路径从 `docs/exec-plans/` 挪到
`.duya/plans/` 且索引由工具维护。

## 迁移（一次性）

- 脚本 `scripts/migrate-exec-plans.mjs`：解析 `docs/exec-plans/{active,completed}/*.md`
  + README 表格 → 为每个文件合成 frontmatter（id 从文件名提取，status 按目录 +
  README 的 OBSOLETE 标记归位）→ 写入 `.duya/plans/`。
- README 中 Planning 状态、OBSOLETE → NNN 指向等信息能提取则提取，不能的置空并打
  `migrated: approximate` 标记，不臆造。
- 迁移以一次 commit 落地（`git add -f .duya/plans/**` 不再需要——路径已不被 ignore），
  `docs/exec-plans/` 保留只读快照一版（或直接删除，实施时按当时 git 状态定）。
- AGENTS.md 的 "Before ANY work" 改为 `plan_status` 工具调用 + 插件禁用时 fallback 读文件。

## Phases

### Phase 1 — 存储核心（纯函数库 + 单测）

- [ ] 1.1 `.duya/plans/` 目录布局 + 从会话 workspace 解析根路径（`plansStore/paths.ts`）
- [ ] 1.2 frontmatter 解析/定点写回（容错：无 frontmatter 的旧文件可读不可写升级）
- [ ] 1.3 index.json 读写、损坏自愈重建、nextId 分配
- [ ] 1.4 六个操作的 store 层实现（create/get/search/update/complete/status），mtime 写冲突校验
- [ ] 1.5 单测：CRUD、重建、损坏 frontmatter、并发写、checkbox 定点改写

### Phase 2 — MCP server

- [ ] 2.1 esbuild 配置：`plans-server.ts` → `plans-server.cjs`（bundle MCP SDK，cjs，外部化 node builtin）
- [ ] 2.2 stdio server：6 工具 schema + handler 接 store；workspace 根注入 + 无 workspace 不注入
- [ ] 2.3 server 级单测（in-process 驱动 handler）

### Phase 3 — 插件封装与接线

- [ ] 3.1 manifest（.duya-plugin/plugin.json）+ skill（plan-management）
- [ ] 3.2 验证/补齐 `resolve.ts` 对插件 MCP stdio 相对 command/args 的解析
- [ ] 3.3 tool-exposure 门控 + 会话内工具注入验证（agent worker 收集链路）
- [ ] 3.4 electron 内置插件同步链路（builtin cache）包含 plans 且可启用/禁用

### Phase 4 — 迁移与文档收口

- [ ] 4.1 `scripts/migrate-exec-plans.mjs` + 干跑模式（输出统计不落盘）
- [ ] 4.2 执行迁移，抽查 10 个新旧 plan 的字段保真
- [ ] 4.3 AGENTS.md 更新（Start 一节 + Workflow）
- [ ] 4.4 `docs/exec-plans/` 收口（快照或删除）+ ARCHITECTURE.md 补插件一节

### Phase 5 — Dogfood 验证

- [ ] 5.1 本 plan 自身迁入新存储，用 `plan_update`/`plan_complete` 走完剩余生命周期
- [ ] 5.2 并行会话实测：主检出与 worktree 各自的 store 互不干扰
- [ ] 5.3 插件禁用路径：fallback 读文件说明有效

## 验证方式

- Phase 1/2/3：`npx vitest run`（从仓库根跑，包内跑有 setupFiles 相对路径问题）。
- 每次提交前 `npm run typecheck:all`（electron/ 改动需手动 `npx tsc -p electron/tsconfig.json`）。
- Phase 3 的注入链路：需要重启 `electron:dev` 实测（Playwright 在本机不可用，遵循既有约束）。
- Phase 4 迁移：干跑统计 + 抽查对照。

## 风险与开放问题

- MCP SDK bundle 体积与启动延迟：stdio 每会话 spawn 一次，目标 < 300ms 冷启动；
  超标则考虑 server 常驻（duya 侧已有 MCP server 生命周期管理，按现状接入即可）。
- `.duya/` 目录名与将来其他工具的项目级数据可能撞名：只承诺 `plans/` 子树的布局稳定，
  其余子目录不由本 plan 定义。
- 并行会话写同一 plan：mtime 校验 + 单条 note 追加已覆盖主要冲突面；文件级锁不做。
- worktree 场景下 plan store 随分支分叉：跨 worktree 的计划协调仍靠合并，与现状
  （docs/exec-plans 在 worktree 里同样分叉）一致，无回归。
