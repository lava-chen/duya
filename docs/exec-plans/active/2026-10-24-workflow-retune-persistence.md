# Workflow live 并发上限持久化

状态：active · 更新：2026-10-24
分支：`codex/workflow-retune-persistence` · worktree：`.claude/worktrees/workflow-retune-persistence` · base：`686f3c81eace1477010b3b94c74f59ac78732a36` · owner：本会话

## 目标与边界

把运行中通过 `WorkflowManager.setRunConcurrency` 接受的 `maxConcurrency` 写入 Host 持有的 run snapshot；resume、stopped recovery 与待确认启动从快照恢复该值，避免重启后回退到 manager 默认值。

只改 workflow snapshot 契约、Host 存储适配、manager 与相关测试。保留现有 YAML/DAG、run ID、在途节点和观察事件语义；不改 provider governor、UI、作者面或 ZCode 分析器。

## 验收

- 初始创建的 DAG snapshot 持久化有效的运行并发上限。
- live retune 仍在原 run 生效、不取消在途节点，并在存储成功后返回；持久化失败不改变活动 engine 上限。
- resume、`resumeStopped`、`confirmLaunch` 使用 snapshot 中保存的上限。
- 旧 snapshot 没有该字段时用当前默认值并回填；损坏的非正整数快照拒绝恢复。
- Host Worker DB bridge 与 SQLite JSON snapshot 完整往返；无需 schema migration。
- 相关 workflow/Host 测试、`npm run typecheck:all` 与 `npm run architecture:check` 通过；不新增 baseline 指纹。
- 通过 PR 交付；不直推、不合并。

## 进度

- [x] 从最新 `origin/master` 建独立 worktree；base `686f3c81eace1477010b3b94c74f59ac78732a36`。
- [x] 记录 manager、bridge 与纯 workflow 测试基线：6 files / 34 tests 通过。
- [x] 扩展 snapshot contract / SQLite store / worker bridge，并让 launch、confirm、resume 与 stopped recovery 使用持久化上限。
- [x] 补 live-retune 上下调轨迹、存储失败原子性、恢复限流、旧快照回填、损坏值拒绝与 SQLite JSON 往返回归。
- [x] 相关 workflow suite：18 files / 218 tests 通过；architecture check 通过且无新增 fingerprint。
- [x] `npm run typecheck:all` 最终重跑退出码 0；无本次新增类型错误。
- [x] PR 前刷新 `origin/master`；仍为 base `686f3c81eace1477010b3b94c74f59ac78732a36`，无需 rebase。
- [x] 提交 `b733b644` 并开 draft PR #453。
- [ ] 等待 PR checks 与 review；按原边界不合并。

## 发现与决策

- 现有同步 `setRunConcurrency` 只调用活动 engine setter；snapshot 当前只保存 definition/hash/nodeStack，恢复按 manager 默认值新建 engine。
- SQLite snapshot 是 JSON blob，可增加可选字段而不改 schema；worker DB bridge 需要显式转发新字段。
- snapshot 缺字段属于旧记录兼容路径，应回填当下有效默认值；显式无效数值则拒绝，避免静默改变配置。
- ZCode 对照显示 live cap 随 run row 持久化。只采纳这一项恢复纪律，继续沿用 Duya YAML/DAG 和 Host 存储边界。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `686f3c81eace1477010b3b94c74f59ac78732a36` / 源码 clean；worktree-local `node_modules` overlay | Linux · Node v24.19.0 · npm 11.9.0；overlay 的 Handlebars 为 4.7.9，最新 lock 为 4.7.10 | `npm run build:packages -- --profile unit-suite` | 0 | 构建 19 个 package；未改源码 |
| 同上 / 源码 clean；同上 overlay | 同上；`DUYA_DATA_ROOT=/tmp/duya-workflow-retune-data` | `npx vitest run packages/host/tests/worker-workflows/manager.test.ts packages/host/tests/worker-db-bridge-workflow-run.test.ts packages/workflow/tests` | 0 | 基线 6 files / 34 tests passed；无基线失败 |
| 同一 HEAD / snapshot 契约、data store、worker bridge、manager 与回归测试 dirty | 同上；依赖通过 worktree-local overlay | `npm run architecture:check` | 0 | 0 new boundary violations；2 baseline fingerprints no longer triggered |
| 同一 HEAD / 同上；manager fixture 首轮新增 3-node DAG 缺 `description` | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-retune-data npx vitest run packages/data/tests/workflow-run-store.test.ts packages/host/tests/worker-workflows packages/host/tests/worker-db-bridge-workflow-run.test.ts packages/workflow/tests` | 1 | 17 files / 217 tests passed；1 failed：`ZodError`，`description` received `undefined`；fixture 已补齐 |
| 同一 HEAD / 同上；修复 manager fixture 必填 description | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-retune-data npx vitest run packages/host/tests/worker-workflows/manager.test.ts` | 0 | manager 14 / 14 tests passed |
| 同一 HEAD / 同上 | 同上 | `DUYA_DATA_ROOT=/tmp/duya-workflow-retune-data npx vitest run packages/data/tests/workflow-run-store.test.ts packages/host/tests/worker-workflows packages/host/tests/worker-db-bridge-workflow-run.test.ts packages/workflow/tests` | 0 | 18 files / 218 tests passed |
| 同一 HEAD / 同上 | Linux 6.18.55 · Node v24.19.0 · npm 11.9.0；worktree-local overlay | 首轮 `npm run typecheck:all`；再以允许脚本启动子进程的执行模式重跑 | 首轮 1；重跑 0 | 首轮在 `check-no-ts-suppress` 以 `spawnSync git EPERM` 退出；原命令重跑通过全仓构建和类型门禁；baseline gate 报告 0 新类型错误 |
| 同一 HEAD / dirty source 与 docs 如上 | Linux · Git origin | `git fetch origin`；`git rev-list --left-right --count HEAD...origin/master` | 0 | origin/master 仍是 base SHA，无需 rebase |
| `b733b644` / 验证过的实现与计划文档 | Linux · GitHub CLI 2.46.0 | `git push -u origin codex/workflow-retune-persistence`；`gh pr create --draft --base master --head codex/workflow-retune-persistence` | 0 / 0 | Draft PR #453 已创建；未合并 |
| `8879ba14` / 干净提交后的 draft PR 分支 | Linux · GitHub CLI 2.46.0 | `gh pr view 453 --json number,title,url,isDraft,baseRefName,headRefName,statusCheckRollup`；`gh pr checks 453` | 0 / 1 | PR #453 指向 master 且为 draft；暂时没有 checks 报告，checks 命令退出 1 |

## 接续 / 结果

实现和相关回归已完成。Live retune 在持久化成功后更新同一 engine，支持从 1→2→1 的数值轨迹；SQLite JSON 可回读 run cap，无 schema 变更。主干刷新确认无前进；worktree-local 依赖 symlink 已移除；Draft PR #453 已提交到 `master`，GitHub 尚未报告 CI checks。下一步等待 checks 与 review，不合并。
