# Plan 522 — Plans Plugin: MCP 化的执行计划管理

> 状态字段以本文件 frontmatter 为准（本 plan 是新存储格式的第一个使用者）。

## 背景与动机

当前 plan 体系 = `docs/exec-plans/README.md`（手维护的大表格索引）+ `active/`/`completed/` 下的 markdown 文件。
每次开工 agent 要整读几百行 README 才能知道当前状态；更新状态要 Read 整文件 + Edit；
新 plan 文件被 gitignore 规则 `docs/*/` 吞掉需要 `git add -f`；完成迁移（active → completed）
要手工移动文件并同步两处索引。

目标：把 plan 管理做成一个 **duya 插件**，插件自带一个 **stdio MCP server**，
提供**最小查询/归档工具集**（`plan_status` / `plan_search` / `plan_complete`）替代
README 整读和手工归档；plan 的创建与内容更新继续用原生文件工具（Write/Edit）直接操作
markdown。存储放在**项目目录**下的 `.duya/plans/`，随仓库走。

**用户已拍板的决策**：

- 存储位置：`<workspace>/.duya/plans/`（项目级，非全局 `~/.duya/`）。
- 形态：duya 插件（manifest + MCP server + skill），不是 agent 内置工具——顺带 dogfood 插件/MCP 管线（plan 455/498 已落地的栈）。
- 工具面刻意最小化（2026-09-12）：只保留查询类（`plan_search` / `plan_status`）+
  归档类（`plan_complete`）。创建/更新/内容读取一律用原生文件工具直改 markdown——
  模型本来就擅长，不值得占 schema 预算。索引用 **JSON**（决策理由见下节）。

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

- `index.json` 只缓存 `{id, slug, title, priority, status, tags, updated, path}`。
  **索引选 JSON，不选数据库**，理由：
  1. 索引是纯派生缓存，任何时刻可从 frontmatter 全量重建——数据库的 ACID/事务
     在这里没有收益，正确性从不依赖索引；
  2. MCP server 是独立 esbuild bundle 的 stdio 进程：better-sqlite3 是 native 模块，
     无法打进 cjs bundle，还得随插件分发 ABI 匹配的二进制，违背零依赖树目标；
     JSON 只用 `node:fs`；
  3. 创建/更新走文件工具、**不经过 server**，索引必然落后于文件——所以索引按
     plan 445 skills snapshot 的范式做**指纹缓存**（每文件记 mtime+size）：每次查询
     先比对指纹，变更/新增/删除的文件增量重扫合并，索引损坏/缺失触发全量重建。
     文件工具绕过 server 直写因此天然安全；
  4. 规模在百级 plan，全量扫描 <50ms，增量只是顺手。
- 正文（阶段/checkbox/进度记录）保持 markdown；**checkbox 继续检测靠 Read 直读正文**——
  agent 看 `- [ ]`/`- [x]` 自行判断接续点，勾选就是 Edit 那一行，不设专门工具。
- **Git 跟踪**：`.duya/plans/` 默认纳入版本控制（这是相对旧 `docs/exec-plans/` 的改进——
  旧位置被 `docs/*/` gitignore 规则吞掉，新文件要 `git add -f`）。若 `.duya/` 下将来有
  其他非 git 数据，只对 `plans/` 子树做 gitignore 例外，其余默认忽略。
  `index.json` 同样入库（重建成本低，入库只为 diff 可见）。

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

## MCP 工具契约（3 个，查询 + 归档收口）

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `plan_status` | `{}` | 活跃 plan 紧凑列表（id/title/priority/status/最近 updated）+ 各目录计数 + `nextId` 建议（max+1），替代整读 README |
| `plan_search` | `{keyword}` | title/tags/正文全文匹配，返回 id/slug/相对路径/片段——agent 拿路径后直接 Read |
| `plan_complete` | `{id}` | 唯一写操作：frontmatter `status=completed` → 移入 `completed/`，索引同步 |

**不经 MCP 的操作（原生文件工具直做）**：

- **创建**：agent 从 `plan_status` 的 `nextId` 取号，按 skill 里的 frontmatter 模板
  Write 到 `active/NNN-slug.md`；server 下次查询经指纹比对自动发现新文件。
- **更新状态/优先级/进度/勾 checkbox**：Edit 直改 frontmatter 或正文行。
- **内容读取**：`plan_search` 给出路径后 Read。
- **obsolete**：低频操作，不设工具——Edit frontmatter（`status: obsolete` +
  `superseded_by`）后手动移入 `obsolete/` 即可。

- 错误面：id 不存在 / frontmatter 损坏返回结构化错误，不静默。
  `plan_complete` 写前做 mtime 校验，避免与并行的文件工具编辑互踩。

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
- [ ] 1.3 index.json（含 per-file mtime+size 指纹）：查询前增量重扫合并，损坏/缺失全量重建；`nextId` 取 max+1 派生
- [ ] 1.4 三个操作的 store 层实现（status/search/complete），complete 写前 mtime 校验
- [ ] 1.5 单测：指纹增量与全量重建、损坏 frontmatter、complete 移动与并发校验、绕过 server 的直写文件能被查询发现

### Phase 2 — MCP server

- [ ] 2.1 esbuild 配置：`plans-server.ts` → `plans-server.cjs`（bundle MCP SDK，cjs，外部化 node builtin）
- [ ] 2.2 stdio server：3 工具 schema + handler 接 store；workspace 根注入 + 无 workspace 不注入
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

- [ ] 5.1 本 plan 自身迁入新存储，用 `plan_complete` 收尾；状态/checkbox 变更全程走 Edit 直改验证文件工具路径
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
