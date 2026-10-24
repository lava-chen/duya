# TUI 工具行状态：成功结果显式声明 success

状态：active · 负责人：codex/tui-tool-status · 更新：2026-10-24
分支：codex/tui-tool-status · worktree：E:/Projects/duya/.claude/worktrees/tui-tool-status · base：686f3c81

## 目标与边界

用户观察到：TUI 里每个单独成行的成功工具调用都画 `?`（`bash(...)`、`read(...)`），而同屏的分组头却画 `✔`。

`?` 不是字体缺字，是 `unknown` 状态字形（`packages/cli/src/tui/transcript-view.ts:734`）。链路为：执行器只给失败结果写 `status: 'error'`，成功结果没有状态位；drain 适配器只把 `<tool_error>` 当正面证据，其余返回 `isError: undefined`（`packages/agent-runtime/src/adapters/run-engine-ports.ts:1182`）；协议把 undefined 映射为 `indeterminate`（`packages/agent-runtime/src/engine/run-engine.ts:3835`），TUI 再画成 `?`。610 的 G-7 规则（缺失状态不得冒充 success）本身正确，缺的是生产方对成功显式表态。

本次允许修改：`StreamingToolExecutor` 的成功消息、drain 适配器的状态读取、相关测试、worker bundle。不处理：分组头在真正的 unknown 批次上仍画 `✔` 的显示约定。

## 验收

1. `npx vitest run packages/agent-runtime/test/run-engine-ports-drain.test.ts packages/agent-runtime/test/tools/execution/streaming-tool-executor.test.ts` 全绿。
2. `npx vitest run packages/cli/tests/integration/shared-client-vertical.test.ts` 全绿，且断言真实 worker 的 `tool.call_completed` outcome 为 `success`；把 bundle 换回 master 旧产物时同一断言失败，报 `indeterminate`。
3. `npm run architecture:check` 通过；`npm run typecheck:all` 结果记录在验证表。
4. `npm run bundle:worker` 后 `packages/host/bundle/worker-entry.js` 与源码一致。

## 进度

- [x] 定位 `?` 的来源（`unknown` 字形 + indeterminate 链路）
- [x] 执行器成功消息写 `status: 'success'`（worker 成功、主路径、权限放行重试、重试成功、延迟结果路径）
- [x] drain 读取生产者声明的状态，文字标记降为回退；补 `<tool_use_error>` 识别
- [x] 单测：drain 4 个新用例 + 执行器成功位用例
- [x] 真实 worker 集成断言 + 反向（旧 bundle）验证
- [x] 重建 `packages/host/bundle`
- [x] 门禁（`typecheck:all`、`architecture:check`）与聚焦用例复跑
- [x] PR #457 与 CI（架构 / build / test / typecheck / test scope 全绿）
- [ ] 授权集成后同步、重验与回收

## 发现与决策

- 生产 drain 确实走 `toDrainItem`（`packages/host/src/worker-run-composition.ts:130`），因此适配器修复落在真实链路，不是测试专用函数。
- 用旧 bundle 复现：真实 worker 的成功工具 outcome 是 `indeterminate`，与新断言对照成立。
- 状态位优先级高于文字标记。理由是 `read` 可能读到含 `<tool_error>` 字样的文件；旧规则会把这种读取误判为失败。
- `status` 只接受生产者陈述过的值（success/done → 非错误；error/failed → 错误）；无状态的中性消息（如“等待用户确认”）仍保持 undefined，不补推成功。
- 顺带修复同一适配器对裸 `<tool_use_error>`（依赖规划器合成错误）的漏判：此前的正则只认 `<tool_error>`，这类失败也会落到 indeterminate。
- `/tmp/typecheck-all.log` 是共享路径，被并发 worktree（`tui-queue-steer`）覆写；本计划的门禁证据改用 worktree 内 `tmp/typecheck-all.log`（含 `EXIT:` 标记）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base 686f3c81 + 本次改动 | Windows 10.0.26200 / Node v24.18.0 | `npx vitest run packages/agent-runtime` | 0 · 107 文件 / 1175 用例通过 | 本地 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui packages/cli/tests` | 0 · 75 文件 / 943 用例通过 | 本地 |
| 同上 | 同上 | `npx vitest run packages/cli/tests/integration/shared-client-vertical.test.ts` | 0 · 真实 worker outcome=success | 本地 |
| 旧 bundle（master 产物） | 同上 | 同上 | 1 失败 · expected 'indeterminate' to be 'success' | 反向验证 |
| 4017ec9e（源码 + 测试 + bundle 已提交） | 同上 | `npx vitest run` 上述 3 个聚焦文件 | 0 · 3 文件 / 24 用例通过 | 本地 |
| 4017ec9e | 同上 | `npm run architecture:check` | 0 · no new boundary violations（baseline 未新增指纹） | 本地 |
| 4017ec9e | 同上 | `npm run typecheck:all` | 0 · 全链通过（`build:packages` 21/21、typecheck-electron-gate OK、eval check 4/4） | `tmp/typecheck-all.log` 第 677 行 `EXIT:0` |
| 8b65a337（PR #457 head） | GitHub Actions ubuntu-latest / Node 22.x | `gh pr checks 457` | 全部通过 · architecture 2m29s、build 2m30s、test 2m10s、typecheck 6m48s、test scope 13s | actions/runs/40096512421 |

## 接续 / 结果

已实现并本地验证：提交 `0be1af2c`（源码）、`6e99489d`（单测）、`4017ec9e`（bundle + 真实 worker 断言）、`55e6c912`（计划）。PR [#457](https://github.com/lava-chen/duya/pull/457)，CI 全绿（run 40096512421）；等授权集成；未合并。
回收：worktree 保留到 PR 集成后。
下一步：获授权后用 merge commit 集成 #457，再重跑 `shared-client-vertical` 并核对 bundle 未漂移，最后回收 worktree。
