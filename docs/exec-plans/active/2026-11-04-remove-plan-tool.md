# 移除 plan 工具（保留 Plan Mode 与磁盘数据）

状态：active · 负责人：当前会话 · 更新：2026-11-04
分支：`chore/remove-plan-tool` · worktree：`C:\Users\lavachen\.duya\worktrees\duya-158718b0aef8\rm-plan-tool-ca0bfe` · base：`7ef8cbd0` · owner：当前会话

## 目标与边界

移除暴露给模型的 `plan` 工具（`PlanTool`）及其整条实现链：capability 层、Host 存储层、Host 绑定、两个注册点、遗留 agent 转发壳、package 导出、对应测试。工具下线后模型不再能调用 `plan`。

**不动的部分（用户 2026-11-04 明确裁定）：**

- **Plan Mode**（`packages/host/src/worker-modes/plan/`、`modifiers/plan/`、`plan-task` 模式）：只读分析模式，与本工具无依赖关系。
- **`/plan` 命令**：UI 侧 `packages/ui/src/lib/commands/executors/view.ts:99` 是 `app.toggleMode('plan-task')`，CLI 侧 `packages/agent/src/cli/slash-commands.ts:775` 只列模式并把请求转交 agent —— 两者都不调用本工具。
- **`docs/exec-plans/`**：仓库自身的执行计划文档，与 `~/.duya/projects/<id>/plans/` 的运行时工件无关联。
- **磁盘数据**：`~/.duya/projects/*/plans/` 全部保留（含 `economist` 的 1 个真实计划）。代码删除后数据成为孤儿，但不删除用户数据。

关联：推翻 [工具面能力台账](../../references/tool-surface-ledger.md) 中 `plan` 的 2026-10-31 裁定「维持现状」（原裁定理由为与 `todo` 非同源、收敛无收益）；该裁定由用户直接推翻，非本次重新评估的结果。

## 验收

| # | 命令 / 操作 | 预期 |
| --- | --- | --- |
| 1 | `npx vitest run scripts/architecture/slice-classification.test.ts` | 退出码 0；`capability-adapter` 桶无「no longer capability-adapter」失败 |
| 2 | `npm run typecheck:all` | 退出码 0 |
| 3 | `npm run architecture:check` | 退出码 0；无新增边界违规 |
| 4 | `npx vitest run packages/capabilities/tests` | 退出码 0（plan-tool.test.ts 已删） |
| 5 | `npm run bundle:worker` 后 `git diff --stat packages/host/bundle/` | bundle 重建且 diff 只反映 plan 工具移除 |
| 6 | `npm run check:packaged-artifacts` | 退出码 0 |

基线：改动前在同检出记录上述命令的退出码与失败签名，按文件 / 用例 / 错误签名比较，不只比数量。

## 进度

- [x] 读必读指南（worktree / engineering-loop / testing / build）与目标子树 AGENTS.md
- [x] 摸清影响面：注册点、协议层、架构策略、UI、CLI、文档、测试
- [x] 与用户确认删除边界（只删工具 / 保留磁盘数据）
- [x] 分配独立 worktree（base `7ef8cbd0`）+ 配置依赖 junction
- [x] 删除实现链文件与导出
- [x] 摘除两个注册点
- [x] 补 `RECORDED_LOSSES` 退休条目
- [x] 重建 worker bundle
- [x] 更新工具面台账
- [x] 跑门禁并记录证据
- [ ] commit + PR

## 发现与决策

1. **`plan` 工具没有 create 路径。** 全仓搜 `packages/{host,cli,capabilities}/src` 后，能写 `plans/` 下 `.md` 的生产代码不存在 —— 只有 `planComplete` 的文件移动与 `buildIndex` 写 `index.json`。计划文件此前只能靠 agent 直接写文件产生，工具本身只管查与归档。删除不产生功能回退。
2. **描述与实现不符。** 工具 description 写 "All checkboxes must be checked first"，但 `planComplete` 只校验 frontmatter 存在 `status:` 字段，无 checkbox 校验。删除即消除该失配。
3. **census 门禁需要补条目。** `scripts/architecture/slice-census.txt` 在 `capability-adapter` 桶记录了 `packages/agent/src/tool/PlanTool/{PlanTool,index,storage}.ts` 三个路径。该门禁是 per-path 子集断言（recorded 路径离开桶即红），故删除后必须在这三个路径上补 `RECORDED_LOSSES` 条目并给出理由；`capabilities/src/PlanTool/*` 与 host 侧两个文件不在 census（冻结后新增，ADD 免费），无需条目。
4. **`packages/agent` 已退出构建图**（build.md），但仍在 census 扫描根 `ROOTS = ["apps","packages","evals"]` 内，故遗留壳删除仍需退休条目。
5. **UI / CLI 的 `plan` 字样与本工具无关。** `packages/agent-protocol/src/primitives.ts:62` 与 `worker-protocol.ts:501` 的 `'plan'` 是 assistant mode 名；`packages/ui/src/types/stream.ts:54` 同理。这些不是工具名，不改。
6. **本次改动消除了 5 条被 baseline 容忍的架构边界违规。** 同一命令在基线 master（`7ef8cbd0`，主检出）与本分支对跑：违规 total 由 **3192 降到 3187**，同时「已失效基线指纹」由 49 升到 54 —— 即被删工具的 5 条跨包 import（capabilities ↔ host）本就是 baseline 记着的边界违规，删掉后自然失效。**无新增违规**，未改动 `.architecture-baseline.json`（那 49 条失效指纹在基线上已存在，是既有债）。
7. **构建重写了 3 个跟踪文件但内容无差异。** `packages/capabilities/src/ModuleTool/inline-content.ts`（由 `scripts/inline-modules.mjs` 生成）、`packages/host/bundle/BashTool/BashWorker.js`、`packages/host/bundle/package.json`：过滤后 blob 哈希与 HEAD 相同，仅行尾差异，已 `git checkout` 归位，不进入本次提交。`worker-entry.js` 与 `worker-metafile.json` 是真实内容变更（工具移除），保留。
8. **typecheck 门禁的 baseline 数字是既有债。** `typecheck-electron-gate` 报 `21 baselined key(s) shrank or disappeared` 与 `164 known across 90 key(s)` —— 在基线 master 与本分支上跑出**完全相同**的数字，故与本次改动无关。两处 baseline 均未改动（`.architecture-baseline.json` 按符号指纹记录，路径 grep 命中 0）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `7ef8cbd0` clean | Windows 11 / Node（worktree junction 62 链接） | `node scripts/junction-worktree.mjs .` | 0 | 62 link(s) created |
| `7ef8cbd0` clean | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts`（**基线**） | 0 | 1 file / 30 tests passed |
| `7ef8cbd0` + 本次改动 | 同上 | `npm run bundle:worker` | 0 | worker-entry.js 5.48 MB；plan 工具专属符号全为 0 |
| `7ef8cbd0` + 本次改动 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts`（改动后） | 0 | 1 file / 30 tests passed（与基线一致） |
| `7ef8cbd0` + 本次改动 | 同上 | `npm run architecture:check` | 0 | total 3187 / tolerated 3187，`OK — no new boundary violations` |
| `7ef8cbd0` clean（主检出对比） | 同上 | `npm run architecture:check`（基线 master） | 0 | total 3192 / tolerated 3192；49 失效指纹（对比见发现 6） |
| `7ef8cbd0` + 本次改动 | 同上 | `npx vitest run packages/capabilities/tests` | 0 | 42 files / 325 tests passed |
| `7ef8cbd0` + 本次改动 | 同上 | `npx vitest run packages/host/tests/worker-tools packages/host/tests/worker-modes` | 0 | 8 files / 128 tests passed（含 plan-tracker 12 例，Plan Mode 未受影响） |
| `7ef8cbd0` + 本次改动 | 同上 | `npm run typecheck:all` | 0 | `typecheck-electron-gate: OK — no new type errors (164 known across 90 key(s))`；`eval:agent:core:check` 4/4 通过 |

## 接续 / 结果

**已实现**：`plan` 工具整条实现链已删除 —— capability 层（`PlanTool.ts` / `ports.ts` / `index.ts`）、Host 存储层（`worker-tool-services/plan.ts`）、Host 绑定（`worker-tool-bindings/plan.ts`）、两个注册点（`worker-tools/builtin.ts` / `bot-builtin.ts`）、遗留 agent 转发壳（`packages/agent/src/tool/PlanTool/`）、`packages/capabilities/package.json` 的两个导出、对应测试文件；worker bundle 已重建（plan 工具专属符号全为 0）。

**已验证**：见上表，`typecheck:all` / `architecture:check` / census / capabilities / host 全部退出码 0，无新增架构违规，且消除了 5 条被 baseline 容忍的跨包违规。

**未合并**：待 PR 与授权集成。

**不动的部分**（用户 2026-11-04 裁定）：Plan Mode（`plan-task`）、UI/CLI 的 `/plan` 命令、`docs/exec-plans/`、`~/.duya/projects/*/plans/` 磁盘工件（含 `economist` 的 1 个真实计划）。

回收：owner 退出且 PR 集成后走管理工具回收 managed worktree。
下一步：推送分支并开 PR，等 CI 与 review；集成需用户授权。
