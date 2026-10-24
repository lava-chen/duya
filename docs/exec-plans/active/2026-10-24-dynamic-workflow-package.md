# 动态工作流核心包与并发、恢复纪律

状态：draft PR #436 · CI 修复中（用户已授权合并，待门禁通过）· 负责人：Codex · 更新：2026-10-24
分支：`codex/workflow-core-package` · worktree：`.claude/worktrees/workflow-core-package`
base：`1296b7c7b6e1995b5220ec14ae6c00bff93057a1`（当前 `origin/master`）· owner：本会话

## 目标与边界

新增 `packages/workflow`（`@duya/workflow`）作为 runtime 层、零 IO 的动态工作流核心。Host 继续持有 run 存储、进度通道、worker 装配与执行绑定，通过端口注入能力。新包只依赖协议与核心类型；不进入 `capabilities`，也不并入 `agent-core` / `agent-runtime`。

保留 YAML/DAG 定义面。禁止引入 ZCode TS taint/因果分析器、多层 run service、第二套脚本作者面或 WorkflowPanel 交互改版。旧 `packages/agent/src/modes/workflow/` 只读对账并冻结；不整树删除 legacy agent。

关联：`docs/exec-plans/active/622-agent-platform-convergence/07-workflow-dag-parallel.md` 是较窄的同层并行卡；本计划按本次授权扩展为核心抽包、并发/失败/恢复一体实现。还需在实现前核对上层 610/622 顺序约束。

## 验收

- `npm run typecheck:all` 与 `npm run architecture:check` 通过；`@duya/workflow` 在无数据库、无 worker 环境完成调度用例。
- 同阶段互不依赖节点并行；run 级 `maxConcurrency` 与 provider 级 AIMD governor 分离；运行中 retune 不新建 run、不打断在途节点，并产生 `concurrency-changed` 与 `run-stalled` 观测。
- 失败只阻断依赖子树，独立分支保留结果；重试采用指数退避与抖动；预算耗尽与取消为 run 级停止，且不写可重放 journal。
- 定义整体 hash 与 journal 是恢复事实源；定义 hash 不匹配时拒绝 resume；修复 trailing failure 剪枝与 orphan `running` 对账；明确脚本运行时和 DAG 定义各自 hash 来源。
- graph fixture 与数值轨迹覆盖并发上限、失败隔离、退避时序、live retune、hash 失配及断点恢复。不得新增 architecture baseline 指纹。
- 每个 S0–S6 切片各一个 Conventional Commit；只开到 `master` 的 draft PR，不合并、不直推主分支。若 `origin/master` 前进，PR 前 rebase 并重跑门禁。

## 进度

- [x] S0：逐文件对账 Host 与 legacy Agent workflow，记录引用方与删除条件。
- [x] S1：抽取 schema、validate、expr、journal 类型、resume-token、scheduler 与并发控制；公开入口零 IO。
- [x] S2：接线 workspace build order、tsconfig 与 architecture policy；登记 `managed: true`、声明窄 `requires`；Host 改从新包导入并移除已迁移重复实现。
- [x] S3：就绪集并行调度、run 限流与 provider AIMD governor 分离、live retune 与观测事件。
- [x] S4：依赖子树失败隔离、指数退避加抖动、预算耗尽/取消的 run 级停止。
- [x] S5：整份定义 hash 与 journal 恢复纪律、trailing failure 剪枝、orphan running 收敛。
- [x] S6：补齐纯包 graph fixture 与数值轨迹，跑完整验收。

## S0 差异表

基于 `21351df668adefc0357741a5f79a1513e297df61`。Host 有 32 个 workflow 源文件；legacy Agent 有 29 个同名路径，均为单行 re-export 到 Host 对应模块；Agent 无独有实现。Host 独有 `execution-binding.ts`、`runner.ts`、`runtime-child.ts`，是 worker/Host 接线文件。

`引用方`：下表的 Agent shim 没有发现仓内直接 import；引用方通过 Host 公共子路径工作。当前引用包括 `apps/desktop/src/main/ipc/workflow-handlers.ts`、`apps/desktop/src/main/agents/server/{workflow-runtime-manager,router}.ts`、`packages/agent/src/process/{legacy-workflow-execution,workflow-runner,workflow-runtime-child}.ts`、`packages/host/src/{worker-process-assembly,worker-process-entry,worker-session-runtime}.ts` 及 `packages/host/tests/worker-workflows/**`。静态旧路径还留在 `scripts/architecture/slice-census.txt` 和 `slice-classification.test.ts`，`packages/ui/src/lib/workflow-types.ts` 有历史注释。

| 文件名（相对 workflow 目录） | 差异 | 引用方 | 删除条件 |
| --- | --- | --- | --- |
| `decision-adapter.ts` | Agent 单行转发；Host 有实现 | Agent 路径无直接调用；Host 子路径由 Host 测试/工作流调用 | 仅在 Agent 退役计划允许且全仓/外部消费者核对无引用后删 shim |
| `dwf/contracts.ts` | Agent 单行转发；Host 有实现 | 同上 | 同上；本任务保留 legacy shim |
| `dwf/def-to-dwf.ts` | Agent 单行转发；Host 有实现 | 同上 | 同上；保留 YAML/DAG 定义面，不扩作者面 |
| `dwf/frontmatter.ts` | Agent 单行转发；Host 有实现 | 同上 | 同上 |
| `dwf/index.ts` | Agent 单行转发；Host 有实现 | 同上 | 同上 |
| `dwf/planner-dwf.ts` | Agent 单行转发；Host 有实现 | Agent 路径无直接调用；DWF planner 由 Host 子路径提供 | 同上；并核对是否属于本次核心边界 |
| `dwf/runtime.ts` | Agent 单行转发；Host 有实现 | Agent 路径无直接调用；Host DWF runtime/测试 | 同上；零 IO 界面不得引入第二脚本作者面 |
| `dwf/store.ts` | Agent 单行转发；Host 有实现 | Host DWF store 测试/Host 调用 | 同上 |
| `engine.ts` | Agent 单行转发；Host 有实现 | Host workflow tests 与 Host manager | 同上；实际算法迁入新包后 Agent shim 仍冻结 |
| `error-class.ts` | Agent 单行转发；Host 有实现 | Host runners/engine/tests | 同上 |
| `expr.ts` | Agent 单行转发；Host 有实现 | Host validate/map/engine/tests | 同上；Host 重复算法仅在新包接线完成后删 |
| `gui-artifacts.ts` | Agent 单行转发；Host 有实现 | Host runners/tests | 同上 |
| `host.ts` | Agent 单行转发；Host 有实现 | Host engine/DWF/tests | 同上；Host 适配与端口装配留在 Host |
| `human-runner.ts` | Agent 单行转发；Host 有实现 | Host engine/tests | 同上 |
| `index.ts` | Agent 单行转发；Host 有 barrel | Host 测试与 `@duya/host/worker-workflows` API | 同上；先迁移 Host/外部消费者，再删 Host 重复实现 |
| `journal.ts` | Agent 单行转发；Host 有实现 | Host manager、Desktop server journal 类型、Host tests | 同上；协议/核心 journal 类型迁移后 Host 只留存储适配 |
| `manager.ts` | Agent 单行转发；Host 有实现 | Host tests 与 Host 工作流接线 | 同上；确认 run 存储职责归 Host 后再拆边界 |
| `map-runner.ts` | Agent 单行转发；Host 有实现 | Host engine/tests | 同上；迁移核心后 Host 重复算法才可删 |
| `node-runner.ts` | Agent 单行转发；Host 有实现 | Host engine/tests | 同上；端口注入完成后删重复实现 |
| `output-schema.ts` | Agent 单行转发；Host 有实现 | Host node/DWF runtime/tests | 同上；先核对其依赖是否属于窄契约 |
| `planner.ts` | Agent 单行转发；Host 有实现 | Host tests/Host decision service | 同上；Host 侧 DecisionService 不应下沉成包依赖 |
| `resume-token.ts` | Agent 单行转发；Host 有实现 | Host engine/manager/tests | 同上；resume contract 迁移后删重复实现 |
| `run-log.ts` | Agent 单行转发；Host 有实现 | Host run-log tests/Host manager | 同上；文件与 run 存储 IO 留在 Host |
| `schema.ts` | Agent 单行转发；Host 有实现 | Host validation/runner/tests；UI 保留历史注释 | 同上；schema 迁移并切换引用后删 Host 重复实现 |
| `tracker.ts` | Agent 单行转发；Host 有实现 | Host run tracker tests/agent-core tracker interface | 同上；Host 状态持久化/进度适配留 Host |
| `validate.ts` | Agent 单行转发；Host 有实现 | Host tests/runner | 同上；迁移校验算法并切换引用后删 Host 重复实现 |
| `verify.ts` | Agent 单行转发；Host 有实现 | Host planner/decision service/tests | 同上；核对 DecisionService 是否通过端口注入 |
| `workflow-files.ts` | Agent 单行转发；Host 有实现 | Desktop IPC workflow handlers / Host tests | 同上；文件系统实现留 Host |
| `execution-binding.ts` | Agent 无对应文件；Host worker 装配实现 | `worker-process-assembly.ts` | Host worker 装配/执行绑定，保留 Host |
| `runner.ts` | Agent 无对应文件；Host workflow launch adapter | `worker-session-runtime.ts`、`worker-process-assembly.ts`、`worker-process-entry.ts`、legacy Agent process | 外层 Host adapter 保留；仅其纯算法依赖可迁移 |
| `runtime-child.ts` | Agent 无对应文件；Host 子进程入口 | `worker-process-entry.ts`、legacy Agent process | 子进程/worker 生命周期留 Host |

没有对 `packages/agent/` 做整树删除。29 个 shim 本次冻结；上表“删除条件”是后续独立退役条件，不是本计划的自动清理许可。

## 发现与决策

- 实际 base 已将 Agent workflow 实现收敛为转发 shim；本次迁移源以 Host 实现为准。`packages/agent` 仍由独立退役计划治理。
- `@duya/workflow` 放 runtime 层，`requires` 只声明协议与核心类型。包不接触 DB、worker、run 存储或 progress channel；通过端口注入。
- 现有 622-07 卡按旧切分只覆盖 DAG 并行，且明确暂不做失败级联/退避。本次用户明确扩大范围，需在新包测试中覆盖整个行为链；共享源码仍按本计划单独提交。
- `.codegraph` 在共享检出只有 `.gitignore`，隔离 worktree 无索引；当前工具列表没有 CodeGraph 能力，本次定位使用仓内 `rg` 与源码引用对账。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `21351df668adefc0357741a5f79a1513e297df61` / worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm ci` | 1 | npm 默认缓存 `/home/agent/.npm/_cacache` 不可创建 |
| 同上 / worktree clean | 同上 | `npm ci --cache /tmp/duya-workflow-npm-cache` | 1 | better-sqlite3 node-gyp 默认缓存 `/home/agent/.cache/node-gyp` 不可创建；无源码改动 |
| 同上 / worktree clean；依赖仅在本 worktree | 同上 | `npm ci --ignore-scripts --cache /tmp/duya-workflow-npm-cache` | 0 | 安装 1686 包；不运行原生安装脚本，workflow 测试与 TS 门禁不依赖该原生构建 |
| 同上 / 本计划与 index 未提交；`node_modules/`、`dist/` ignored | 同上 | `npx vitest run packages/host/tests/worker-workflows/` | 1 | 初次无 build 产物：10 suites 在 import 阶段失败，错误签名 `Failed to resolve entry for package "@duya/ai"`；2 files / 15 tests passed |
| 同上 / 本计划与 index 未提交；`node_modules/`、`dist/` ignored | 同上 | `npm run build:packages -- --profile unit-suite` | 0 | 按 authoritative build order 构建 18 个 unit-suite packages |
| 同上 / 本计划与 index 未提交；`node_modules/`、`dist/` ignored | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/` | 0 | 基线：12 files / 185 tests passed |
| 同上 / 本计划与 index 未提交；build 产物 ignored | 同上 | `npm run typecheck:all`（默认 sandbox） | 1 | `check:no-ts-suppress` 的 Node 子进程对 `git ls-files` 返回 `EPERM`；后续同命令受限授权运行成功 |
| 同上 / 本计划与 index 未提交；build 产物 ignored | 同上 | `npm run typecheck:all`（受限授权） | 0 | 20 包构建、protocol/core/runtime/web/Electron/CLI/voice/evals 类型门禁通过；Electron ratchet 无新增错误，9 个旧 key 收缩；eval 4/4 |
| 同上 / 本计划与 index 未提交；build 产物 ignored | 同上 | `npm run architecture:check`（默认 sandbox） | 2 | audit runner 的 Node 子进程返回 `EPERM`，未进入扫描 |
| 同上 / 本计划与 index 未提交；build 产物 ignored | 同上 | `npm run architecture:check`（受限授权） | 0 | 2623 findings 全部已容忍；无新增违规；255 条旧指纹已不触发，未写 baseline |
| `c03348b5a8e5f8d59a5e499b63b6cad945296d80` / `packages/workflow/**` + 本计划未提交；`node_modules/`、`dist/` ignored | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npx tsc -p packages/workflow/tsconfig.json --pretty false` | 0 | 新包源码独立严格编译；公共入口暴露 schema/expr/validate、hash/token ports、journal 与 scheduler |
| 同上 / 同上 | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/workflow/tests/core-contracts.test.ts` | 0 | 1 file / 5 tests：稳定 hash、journal cache/prune/clock 注入、DAG ready set、live limiter、resume payload shape |
| 同上 / 同上 | 同上 | `rg -n "require\\('node:|from ['\"]node:|import\\(['\"]node:|process\\.|Date\\.now|setTimeout|fetch\\(" packages/workflow/src` | 1（无匹配） | 纯源码未发现 Node builtin、host clock/timer、process 或网络调用 |
| `6a6a0ebc` / S2 改动；package/lock、build/policy/tsconfig/Vitest、Host adapters 与 `packages/workflow/src/**` | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm install --package-lock-only --ignore-scripts --offline --cache /tmp/duya-workflow-npm-cache` | 0 | 仅登记本地 `@duya/workflow` workspace 与 Host/Runtime 依赖，无 registry 更新 |
| 同上 / 同上 | 同上 | `npm install --ignore-scripts --offline --cache /tmp/duya-workflow-npm-cache` | 0 | 添加当前 worktree 的 `node_modules/@duya/workflow` workspace link |
| 同上 / 同上 | 同上 | `npm run build:packages -- --target @duya/workflow --target @duya/host`（首次） | 1 | 错误签名 `dwf/runtime.ts: Semaphore is not exported from ../host.js`；Host adapter 未转出旧兼容符号，补齐 export 后重跑 |
| 同上 / 同上 | 同上 | `npm run build:packages -- --target @duya/workflow --target @duya/host` | 0 | 13 包依赖闭包构建通过，新包位于 agent-core 后、agent-runtime 前 |
| 同上 / 同上 | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 0 | 14 files / 205 tests passed；覆盖既有 Host 工作流与新包，workflow layer purity 通过 |
| 同上 / 同上 | 同上 | `npm run typecheck:workflow` | 0 | `@duya/workflow` 声明与源码 typecheck 通过 |
| 同上 / 同上 | 同上 | `npm run check:test-coverage` | 0 | 所有 tracked test 被收集；仅有 baseline 中的 1 条 known orphan |
| 同上 / 同上 | 同上 | `npm run architecture:check`（受限授权） | 0 | 2641 findings 全部已容忍；无新增违规；256 条旧指纹未触发，baseline 未改写 |
| `6a6a0ebc0b4e72d98352be5afcf3743dd401bc1b` / S2 改动文件；`node_modules/`、`dist/` ignored | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm run typecheck:all`（受限授权） | 0 | 21 包构建及 protocol/client-core/core/workflow/runtime/web/Electron/CLI/voice/evals 类型门禁通过；Electron ratchet 无新增错误；eval 4/4 |
| `dda132b2b1ed382a89ff84ac08411553bb418d91` / S3 工作文件；`node_modules/`、`dist/` ignored | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm run build:packages -- --target @duya/workflow --target @duya/host` | 0 | 工作流与 Host 依赖闭包 13 包构建通过 |
| 同上 / 同上 | 同上 | `npm run typecheck:workflow && npx vitest run packages/workflow/tests/scheduler.test.ts` | 0 | 工作流严格类型检查通过；1 file / 5 tests passed，含并发轨迹、AIMD 和 stalled 观察 |
| 同上 / S3 工作文件及 `packages/workflow/tests/scheduler.test.ts`；`node_modules/`、`dist/` ignored | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 0 | 15 files / 211 tests passed，含 Host live retune 不新建 run 断言 |
| 同上 / 同上 | 同上 | `npm run architecture:check`（受限授权） | 0 | 2642 findings 全部已容忍；无新增违规；256 条旧指纹未触发，baseline 未改写 |
| 同上 / S3 早期工作文件 | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 1 | 6 个 Host 用例错误签名均为预期 `waiting` / `failed` 实际得到 `complete`；异步任务收尾后调度循环未折叠 terminal failure / suspension。引擎在 phase 成功记录前处理终态并等待在途任务后重跑，最终 15 files / 211 tests 通过 |
| 同上 / S3 早期工作文件 | 同上 | `npm run build:packages -- --target @duya/workflow --target @duya/host`（首次） | 1 | `TS2304: Cannot find name 'HostAgentSpec'`；补全 node-runner 类型导入后依赖闭包构建通过 |
| `fde7f7aac3916030b3915c3790a2820d8b3e9008` / S4 开工前 worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 0 | S4 基线：15 files / 211 tests passed |
| `fde7f7aac3916030b3915c3790a2820d8b3e9008` / S4 修改 `packages/workflow/src/{engine,node-runner,map-runner}.ts`、Host engine test 与新纯包用例；`node_modules/`、`dist/` ignored | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm run build:packages -- --target @duya/workflow --target @duya/host` | 0 | workflow/Host 13 包依赖闭包通过；新 signal、分支隔离及 retry port 类型通过编译 |
| 同上 / 同上 | 同上；测试数据根 `/tmp/duya-workflow-data` | `npx vitest run packages/workflow/tests/failure-semantics.test.ts packages/workflow/tests/scheduler.test.ts`（首次） | 1 | 新 fixture 把 `map.over` 写成模板 `${params.items}`，运行语法要求表达式 `params.items`，错误签名 `expr_error`；修 fixture 后重跑通过，无产品代码变更 |
| 同上 / 同上 | 同上 | `npx vitest run packages/workflow/tests/failure-semantics.test.ts packages/workflow/tests/scheduler.test.ts` | 0 | 2 files / 9 tests passed；依赖子树、跨 phase 结果保留、`[125, 500]` ms 抖动轨迹、map budget 与预先取消覆盖 |
| 同上 / S4 改动文件及新测试；`node_modules/`、`dist/` ignored | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 0 | 16 files / 215 tests passed；旧 Host error policy、workflow pure tests、layer purity 均通过 |
| 同上 / 同上 | 同上 | `npm run typecheck:workflow` | 0 | 新包源码严格类型检查通过 |
| 同上 / 同上 | 同上 | `npm run architecture:check`（受限授权） | 0 | 2642 findings 全部已容忍；无新增违规；256 条旧指纹未触发，baseline 未改写 |
| `51b8a631c435e7c59c160c32df228c9185b77f48` / S5 开工前 worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests scripts/architecture/layer-purity.test.ts` | 0 | S5 基线：16 files / 215 tests passed |
| `51b8a631c435e7c59c160c32df228c9185b77f48` / S5 dirty；`node_modules/`、`dist/` ignored | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts scripts/architecture/layer-purity.test.ts`（首次） | 1 | `runtime-child.test.ts` 恢复用例的 mock 未携带 `workflow:ready` 保存的 snapshot hash，导致 fail-closed 后未读取 journal；修正 mock 以传递真实快照 hash/source |
| 同上 / 同上 | 同上 | `npm run typecheck:all`（受限授权，首次） | 2 | `packages/ui/src/components/workflow/run-display/run-status.test.ts` TS2741：穷举 `WorkflowRunStatus` 未覆盖新增 `stopped`；补映射到已有 `interrupted` 展示态并增加终态断言，无交互改版 |
| 同上 / S5 变更文件；`node_modules/`、`dist/` ignored | 同上 | `npm run build:packages -- --target @duya/workflow --target @duya/data --target @duya/host` | 0 | 13 包依赖闭包构建通过；覆盖最后的 stale-run 查询与 Host 恢复接线 |
| 同上 / S5 变更文件及 UI 状态穷举映射；`node_modules/`、`dist/` ignored | 同上；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts packages/ui/src/components/workflow/run-display/run-status.test.ts scripts/architecture/layer-purity.test.ts` | 0 | 19 files / 259 tests passed；SQLite 用例覆盖 orphan running 收敛、原子 journal replacement 与 `awaiting_confirm` 持续保留 |
| 同上 / 同上 | 同上 | `npm run typecheck:all`（受限授权，第二次） | 0 | 21 package build、protocol/core/workflow/runtime/web/Electron/CLI/voice/evals 检查通过；Electron ratchet 无新增错误、9 个旧 key 收缩；eval 4/4 |
| 同上 / 同上 | 同上 | `npm run architecture:check`（受限授权） | 0 | 2644 findings 均已容忍；无新增违规；256 条旧指纹未触发，未写 baseline |
| `aebd78e76551d36e78d6ba0ab952bd34efad1d97` / S6 开工前 worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0；测试数据根 `/tmp/duya-workflow-data` | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts packages/ui/src/components/workflow/run-display/run-status.test.ts scripts/architecture/layer-purity.test.ts` | 0 | S6 基线：19 files / 259 tests passed |
| `aebd78e76551d36e78d6ba0ab952bd34efad1d97` / S6 fixtures、调度与失败用例未提交 | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npx vitest run packages/workflow/tests` | 0 | 4 files / 17 tests passed；图 fixture 被 scheduler、失败隔离和纯内存恢复用例共同使用 |
| 同上 / 同上；测试数据根 `/tmp/duya-workflow-data` | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts packages/ui/src/components/workflow/run-display/run-status.test.ts scripts/architecture/layer-purity.test.ts` | 0 | 20 files / 260 tests passed；并发轨迹峰值 2、retune 顺序稳定，含 DB/Host 集成与纯包图用例 |
| 同上 / 同上 | 同上 | `npm run typecheck:workflow` | 0 | 新包源码严格类型检查通过 |
| 同上 / 同上 | 同上 | `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck packages/workflow/tests/*.test.ts packages/workflow/tests/fixtures/*.ts` | 0 | 新增纯包 fixture 与测试通过严格 TypeScript 检查 |
| 同上 / 同上 | 同上 | `npm run build:packages -- --target @duya/workflow --target @duya/host` | 0 | 13 包依赖闭包构建通过 |
| 同上 / S6 文件与本计划；`node_modules/`、`dist/` ignored | 同上 | `npm run typecheck:all`（受限授权，最终） | 0 | 21 package 构建及全部 protocol/core/workflow/runtime/UI/Electron/CLI/Web/voice/evals 类型门禁通过；Electron ratchet 无新增错误、9 个旧 key 收缩；eval 4/4 |
| 同上 / 同上 | 同上 | `npm run architecture:check`（受限授权，最终） | 0 | 2644 findings 均为基线容忍项；无新增违规；256 条历史指纹未触发，baseline 未写入 |
| `fe32f4f6c334fde2c80b0e1487b940212bafb6c7` / worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `git fetch origin` | 0 | `origin/master` 从 `21351df668adefc0357741a5f79a1513e297df61` 前进到 `2ca7886fbae7197d30db4b4c553f59ca4b03fedf` |
| 同上 / clean | 同上 | `git rebase origin/master` | 0 | 无冲突；7 个切片提交已重放到 `2ca7886fbae7197d30db4b4c553f59ca4b03fedf` 之上 |
| `663b5043b506aba2d4278ae4fbab4a6fc8ed7ea1` / rebased worktree clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm run typecheck:all`（受限授权，rebase 后） | 0 | 21 package 构建及 protocol/core/workflow/runtime/UI/Electron/CLI/Web/voice/evals 全部通过；Electron ratchet 无新增错误、9 个旧 key 收缩；eval 4/4 |
| 同上 / clean；测试数据根 `/tmp/duya-workflow-data` | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-data npx vitest run packages/host/tests/worker-workflows/ packages/workflow/tests apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts packages/ui/src/components/workflow/run-display/run-status.test.ts scripts/architecture/layer-purity.test.ts` | 0 | 20 files / 260 tests passed |
| 同上 / clean | 同上 | `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck packages/workflow/tests/*.test.ts packages/workflow/tests/fixtures/*.ts` | 0 | Workflow graph fixture 与纯包测试严格 TypeScript 检查通过 |
| 同上 / clean | 同上 | `npm run architecture:check`（受限授权，rebase 后） | 0 | 2685 findings 均为基线容忍项；无新增违规；257 条旧指纹未触发，baseline 未写入 |
| `e0b867519f115244061d0a80bd43783c3ff3e96c` / clean；PR #436 初次 CI | GitHub Actions · Ubuntu 26.04 · Node 22.x | PR 全量 test job（run `40078155559`） | 1 | 1,176 个文件中 1 个失败：`scripts/architecture/slice-classification.test.ts` 将新 `packages/workflow/**` 列为 unexplained；13,099 passed、2 expected-fail、23 skipped。CI 失败签名与架构映射漏登一致 |
| 同上 / clean；PR #436 初次 CI | GitHub Actions · Ubuntu 26.04 | architecture job（run `40078155559`） | 1 | `npm run bundle:verify` 报 `worker-entry.js` 与 `BashTool/BashWorker.js` stale，14 个源输入在 bundle commit 后变更；其余 architecture 步骤通过 |
| 同上 / 本地分类表两文件未提交 | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npx vitest run scripts/architecture/slice-classification.test.ts`（加分类规则、尚未更新规则表 hash） | 1 | 30 tests 中 1 项为 reviewed rule table hash 不匹配：`cf513c5ff92b47e5` → `ab8016b8343270e6`；更新该 map tripwire，不改 architecture baseline |
| 同上 / `scripts/architecture/slice-classification.{ts,test.ts}` 未提交 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts` | 0 | 1 file / 30 tests passed；新 `packages/workflow/src` 归入 runtime-coordination，workflow 测试目录按既有约定作为明确 unclassified prefix |
| 同上 / 切片分类与 worker bundle 输出未提交 | 同上 | `npm run build:packages -- --target @duya/host` | 0 | 构建 13 包 host 依赖闭包；包含 `@duya/workflow` |
| 同上 / worker bundle 输出未提交 | 同上 | `npm run bundle:worker` | 0 | 重建 `packages/host/bundle/worker-entry.js`、`BashTool/BashWorker.js` 和 metafile；有既有 `import.meta`/CJS 构建 warning |
| 同上 / bundle 输出未提交 | 同上 | `npm run bundle:verify` | 1 | verifier 以最后提交 bundle 的 git 历史为准；生成物仍是工作区未提交状态，提交同次变更后复验 |
| 同上 / bundle 与分类表未提交；architecture 默认 sandbox | 同上 | `npm run architecture:check` | 2 | `audit-imports.mjs` 的 `spawnSync(node)` 返回 `EPERM`，未进入门禁扫描 |
| 同上 / 同范围 | 同上，受限授权运行 | `npm run architecture:check` | 0 | 无新 boundary violations；257 个旧 baseline 指纹不再触发；未写入或新增 architecture baseline 指纹 |
| 同上 / 同范围；typecheck 默认 sandbox | 同上 | `npm run typecheck:all` | 1 | `check:no-ts-suppress` 的 `spawnSync git ls-files` 返回 `EPERM`，未完成门禁 |
| 同上 / 同范围 | 同上，受限授权运行 | `npm run typecheck:all` | 0 | 21 包构建与 protocol/client-core/core/workflow/runtime/web/Electron/CLI/voice/evals 全部通过；Electron ratchet 无新增错误；eval 4/4 |
| 同上 / 分类表与 bundle dirty；工作流 package 源/测试 clean | 同上 | `npx vitest run packages/workflow/tests` | 0 | 4 files / 17 tests passed，独立于 DB、worker 与 Electron |
| 同上 / 分类表与 bundle dirty | 同上 | `npx vitest run packages/host/tests/worker-product-runtime/engine-chat-start-assembly-proof.test.ts apps/desktop/src/main/ipc/__tests__/project-entity-handlers.test.ts --reporter=verbose` | 0 | 2 files / 26 tests passed；全量本地运行中的瞬时失败在单独复核中未复现 |
| 同上 / 分类表与 bundle dirty；全量 Vitest 未完成 | Node v24.19.0 · 本地网络受限 | `npx vitest run` | 130（人工中断） | 未筛选全量启动；多个 Electron 集成文件在 collection 时下载 binary 失败并显示 `0 test`，输出 `TypeError: fetch failed`，不能作为完整测试结果 |
| 同上 / 分类表与 bundle dirty；网络权限开启后全量 Vitest 未完成 | Node v24.19.0 · 本地网络权限已批准 | `npx vitest run` | 130（人工中断） | 外连仍无法获取 Electron binary；还出现的 Host/IPC 本地失败在上行两文件单独重跑全部通过。全量无跳过地由 PR CI 复验 |
| `e0b867519f115244061d0a80bd43783c3ff3e96c` / classification, bundle and plan dirty | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `git fetch origin` | 0 | `origin/master` 前进自 `2ca7886fbae7197d30db4b4c553f59ca4b03fedf` 至 `c426d029`；先提交 CI 修复，再 rebase 并重跑完整门禁 |
| `60af2c95` / CI 修复提交 | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `git rebase origin/master` | 首次 1；冲突解决后继续 0 | 8 个提交重放；仅 `worker-entry.js` 与 worker metafile 冲突，按 rebase 后源码重新生成，不手工拼接生成文件 |
| `4b22e70bf14a64693a4751232c0bada08cf35e98` / rebase 正在重放 CI 修复，两个 bundle 路径已从冲突状态恢复 | 同上 | `npm run build:packages -- --target @duya/host && npm run bundle:worker` | 0 | 13 包依赖闭包通过；根据已重放源码生成 `worker-entry.js`（4.47 MB）与 `BashWorker.js`（33.09 KB），随后 `git rebase --continue` 完成 |
| `82665fab2e2fab581513f72b7749d0872e038b72` / 仅计划文档未提交；`origin/master=c426d029668ed0a0d6dae5ca9429b4a878925abd` | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `npm run architecture:check`（rebase 后，受限授权） | 0 | 2703 findings 均为已容忍项；无新违规；2 条旧指纹消退；未写 baseline |
| 同上 / 同范围 | 同上，受限授权 | `npm run typecheck:all`（rebase 后） | 0 | 21 包构建、protocol/client-core/core/workflow/runtime/web/Electron/CLI/voice/evals 通过；Electron ratchet 无新增错误；eval 4/4 |
| 同上 / 同范围 | 同上，受限授权 | `npx vitest run packages/workflow/tests scripts/architecture/slice-classification.test.ts` | 0 | 5 files / 47 tests passed：workflow graph/并发/失败/恢复全套及新包分类完整性 |
| 同上 / 同范围 | 同上，受限授权 | `npm run bundle:verify`（rebase 后） | 0 | worker bundle commit 为 `82665fab`；两个产物 `ok`，0/945 输入在生成提交后变化 |
| `e64aab3d340507e3176fb6bf248dfd3e3aa4081b` / clean | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 | `git fetch origin` | 0 | `origin/master` 从 `c426d029668ed0a0d6dae5ca9429b4a878925abd` 前进到 `1296b7c7b6e1995b5220ec14ae6c00bff93057a1`，与 GitHub PR base 一致 |
| `e64aab3d340507e3176fb6bf248dfd3e3aa4081b` / clean | 同上 | `git rebase origin/master` | 0 | 9 个提交重放，无冲突；分支现在基于 `1296b7c7` |
| `b5ed92d3b4d481a80beb5b7a833f9bcddd6a57e6` / 仅计划文档未提交；`origin/master=1296b7c7b6e1995b5220ec14ae6c00bff93057a1` | 同上，受限授权 | `npm run bundle:verify`（再次 rebase 后） | 0 | bundle commit 为 `e91d4302`；两个产物 `ok`，0/945 输入变化 |
| 同上 / 仅计划文档未提交 | 同上，受限授权 | `npm run architecture:check`（第二次 rebase 后） | 0 | 2703 findings 均已容忍；0 新违规；2 条旧指纹消退；baseline 未写入 |
| 同上 / 同范围 | 同上，受限授权 | `npx vitest run packages/workflow/tests scripts/architecture/slice-classification.test.ts`（第二次 rebase 后） | 0 | 5 files / 47 tests passed |
| 同上 / 同范围 | 同上，受限授权 | `npm run typecheck:all`（第二次 rebase 后） | 0 | 21 包构建及 protocol/client-core/core/workflow/runtime/web/Electron/CLI/voice/evals 通过；Electron ratchet 无新增错误，eval 4/4 |

## 接续 / 结果

已完成并提交 S0（`6c915fd010105530b3f8139d35df5f528d29ff8f`）、S1（`6726e736dfd65b21a32e60e066c5a0b565d1181b`）、S2（`568439ff1cc5984b71a5276e333ba899e5feb2c2`）、S3（`ddfabc9e8546c041615abe0124e3e7e3dc45c912`）、S4（`f788d2c861320466ef4903380beb2752812ba7ea`）和 S5（`34c3dfd4650db746949fd38817d2376815d5e5b4`）。S6 的 fixture、数值轨迹及本次 rebase 验证记录与该计划同属当前提交。S3 在同阶段就绪集并发派发；run gate 与共享 provider AIMD governor 分离，提供 live retune、`concurrency-changed` 和 `run-stalled` 观察。S4 的 `on_error: fail` 失败节点仅阻断其依赖子树（含后续 phase），独立分支继续并把成功结果留在 journal；已有默认 `skip` 仍保持软跳过语义。重试通过注入时钟和随机源按 250ms 基数、指数增长、0.5–1.5 全抖动、30s 上限等待。budget 与 abort 作为 run 级停止；map fan-out 不再吞 budget/cancel，也不为停止写失败 node record。

S5 将 DAG hash 绑定到校验后的整份定义；DWF hash 覆盖解析出的完整脚本正文和规范化 frontmatter（运行参数不参与）。resume 前置校验 hash 和 journal，缺失或损坏时拒绝冷启动回退；DAG 旧快照可由冻结定义计算并一次性回填 hash。恢复从持久 journal 剪掉未解决失败/依赖失败标记，保留独立成功缓存；orphan `running` 变为不可重放的 `skipped/orphan_running`，run 收敛到显式可恢复 `stopped`。`awaiting_confirm` 不参与 orphan reconciliation，保留高风险人工确认门。S5 定向测试 19 files / 259 tests、全仓 typecheck 和 architecture gate 通过；首次运行分别发现 DWF 恢复测试 mock 缺 hash 与 UI 穷举缺 stopped 展示映射，均已修正。`node_modules/`、`dist/` 均 ignored，architecture baseline 未新增指纹。全仓 gate 需在此执行环境用受限授权运行，默认 sandbox 会拦其子进程。

S6 把并发、失败隔离和 stopped recovery 图提取为可复用 fixture；纯包恢复用例只使用注入 Host、ports 和内存 journal，无数据库或 worker。数值轨迹断言并发峰值 2、live retune 后在途任务顺序、AIMD `[4, 5, 2, 3]` 和退避 `[125, 500]` ms。最终全仓类型和架构门禁通过，S6 定向回归为 20 files / 260 tests。

已将 `codex/workflow-core-package` 推送到 origin，并创建到 `master` 的 draft PR #436（`https://github.com/lava-chen/duya/pull/436`）。首轮 CI 揭示 architecture slice map 漏登和 Host worker bundle 过期；修复提交已先后 rebase 到 `c426d029` 与最新 `1296b7c7`。第二次 rebase 无冲突，bundle freshness 为 0/945 变化；最新 base 上 architecture、typecheck 与 workflow/classification 测试均通过。计划文档现有重跑记录待提交，随后 force-with-lease 更新 PR 并等待 GitHub 全量 CI；若全绿则按用户授权合并。合并后再 clone ZCode 官方开源仓库，在独立目录只读学习对比，不移植代码。
