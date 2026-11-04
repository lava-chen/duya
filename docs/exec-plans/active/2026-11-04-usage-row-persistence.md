# 持久化行的 usage 块：写侧字段名与读侧对齐

状态：active · 负责人：wb-context-usage · 更新：2026-11-04
分支：codex/context-usage-persist · worktree：C:/Users/lavachen/.duya/worktrees/duya-158718b0aef8/context-usage-persist · base：7ef8cbd0 · owner：wb-context-usage

## 目标与边界

用户能观察到：`duya chat` 里跑过一轮之后，`/context` 的 `used` 有真实数字（不再是
「no usage anchor yet」），`/cost` 有本会话计数，Desktop 重启后上下文环不再塌成「?」。

根因（已定位，见「发现与决策」）：Host worker 记录 assistant 行时把 usage 块写在
`AssistantMessage.usage`，而持久化链路（Journal → IPC DTO → rollout 行）只认
`Message.tokenUsage`，于是 usage 从未落库，任何从持久化历史重建锚点的消费者都拿不到锚点。

允许修改：`packages/host/src/worker-session-runtime.ts`、
`packages/host/src/ipc-message-adapters.ts`，以及 `packages/host/tests/` 下的用例。

本次不处理：`packages/cli/src/tui/slash/session-info.ts` 里「未锚定 vs 不可知」被合并成
一个 `null` 的展示语义（另开切片）；老会话的 rollout 没有 usage，无法回填。

## 验收

- 新增用例：一条只带 `usage` 的 assistant 行，经 runtime → projectTimelinePersistenceMessages
  后行上出现 `tokenUsage`；再经 `ipcMessageToNewEvent`（DTO 只带 `token_usage` 字符串）
  产出的 rollout entry 交给 `computeContextEstimate` 必须 `anchored === true`。
- 变异证据：去掉 runtime 里的 `tokenUsage` 赋值 → 第一条转红；去掉 adapter 里的顶层
  `tokenUsage` → 第二条转红。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0；
  `node node_modules/vitest/vitest.mjs run packages/host/tests packages/cli/src/tui/slash` 全绿。
- 真实链路：`duya chat` 跑一轮后 rollout 文件里 `"tokenUsage"` 出现次数 > 0，`/context` 出现 `used` 数字。

## 进度

- [x] 定位根因与影响面（29 个 rollout 全量核对，0 条带 tokenUsage）
- [x] runtime：`recordTurnAssistantMessage` 同时写 `tokenUsage`
- [x] adapter：`ipcMessageToNewEvent` 把 DTO 的 `token_usage` 还原成顶层 `tokenUsage`
- [x] 用例 + 变异验证
- [ ] 门禁 + commit + PR

## 发现与决策

- **写侧**：`worker-session-runtime.ts:799` 写 `(row as AssistantMessage).usage`；
  `worker-journal/Journal.ts:201` 与 `JOURNAL_MESSAGE_FIELDS`（同文件 294-324）只读
  `tokenUsage`/`metadata.token_usage`；`agent-protocol/src/message-ingest.ts:21-27` 的
  `LEGACY_KNOWN_KEYS` 同样只有 `tokenUsage`。写的是 A、存的是 B，全程落空。
  来源：`git log -S "usage = input.usage"` → `8f7f5032 feat(host): run CLI and Desktop
  through the Host worker`（2026-10-14），该提交同时带入遗留 Journal（`tokenUsage` 语义）
  与新 runtime（`usage` 语义）。
- **读侧全按 `tokenUsage`**：`transcript/projector.ts:100`、`ipc-message-adapters.ts:596`、
  `ui/hooks/useContextUsage.ts:356`、`cli/tui/slash/shared.ts:251`。因此修写侧即可，不改读侧契约。
- **为什么 adapter 也要改**：Journal DTO 的 `token_usage` 被 `ipcMessageToNewEvent` 放进
  `metadata.token_usage`（`:340`），`ingestMessage` 会原样保留 metadata，但 rollout entry 的
  message 没有顶层 `tokenUsage` —— 而 CLI `readMessages` 读的是 rollout 原文，经
  `projectTimelinePersistenceMessages` 只认顶层字段。故 DTO 解析回顶层是必要的第二处。
- **不改 metadata.token_usage**：`messageToIpcRow`（`:596`）优先读它，保留即保持 DB 行兼容。
- **落库的是单次调用块，不是本轮累计**：`recordAssistantMessage` 是「每条装配消息一次」
  （`agent-runtime/src/engine/ports.ts:756`），一个多工具轮次会产生多条 assistant 行，
  而 composition 交给它的是 `turnUsageBlock()`（本轮累计）。若原样落库，`/cost` 的
  `sumMessageUsage`、`seedTokenUsageFromHistory`、Desktop 的 usage-aggregator 都会把同一轮
  数 N 次 —— 即 plan 546 修掉的重复计费下移一层。故用 `deriveSingleCallUsage`（plan 546
  建立的归一化器，幂等）先取单次调用再写 `usage` 与 `tokenUsage`。副作用：行上不再带
  `calls[]`，但逐行求和即得会话总量，种子与聚合器都不需要该账本。
- **注意（本次未修）**：`row.usage` 对内存锚点实际是**惰性**的 —— `ingestMessage` 的
  `LEGACY_KNOWN_KEYS` 不含 `usage`，写进 timeline 的那份副本会丢掉它；活轮次的压缩锚点
  走 `run-engine.ts:3073` 的 `noteUsage`（运行期状态），所以没有暴露成 bug。要让
  `usage` 真成为内存锚点需另行补白名单，超出本切片。
- **为什么没有选「只给本轮最后一条挂累计块」**：记录发生在每条消息装配完成时，journal
  已经发过（`INSERT OR IGNORE` 幂等），事后无法安全回填最后一条。
- 证据：`~/.duya/sessions/**/rollout-*.jsonl` 29 个文件，assistant 行上千条，
  `"tokenUsage"` 出现 0 次（`input_tokens` 仅出现在代码正文里）；当前会话 64 条 assistant 全无。
  另：`~/.duya/duya-main.db` 的 `messages` 表 0 行（存储已全部走 rollout），排除了「DB 有、读侧丢」的可能。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 7ef8cbd0（base） | Windows / Node 22.22.2 | 扫 29 个 rollout | 0 / tokenUsage 命中 0 | 见上「证据」 |
| 工作区（实现 + 用例） | Windows / Node 22.22.2 | `vitest run packages/host/tests/message-context-anchor.test.ts` | 0 / 2 passed | 新增 DTO→rollout→anchor 用例 |
| 工作区（实现 + 用例） | 同上 | `vitest run packages/host/tests/worker-product-runtime/` | 0 / 32 files, 179 passed | runtime 行的 `tokenUsage` 断言 |
| 工作区（变异 1） | 同上 | 删掉 `row.tokenUsage = input.usage` | 1 / 目标用例转红 | 收到 `undefined`，证明断言有牙齿 |
| 工作区（变异 2） | 同上 | 删掉 adapter 顶层 `tokenUsage` | 1 / 目标用例转红 | `durable.tokenUsage` 为 `undefined` |
| 工作区（变异 3） | 同上 | `deriveSingleCallUsage` 换成直传累计块 | 1 / 新用例转红 | 收到 `input_tokens: 120000`（应 40000） |
| 工作区 | 同上 | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all`（关闭沙箱，嵌套 git 需外部权限） | 0 | 类型门禁（改完最终版后重跑） |
| 工作区 | 同上 | `npm run architecture:check` | 0 / no new boundary violations | 未新增指纹；49 条 baseline 不再触发属存量 |
| 工作区 | 同上 | `vitest run packages/cli/src/tui/slash` | 1 / 291 passed, 1 failed | 失败为 `presets.test.ts` 的 `mode & 0o077`，在 base 7ef8cbd0 上同样失败（Windows 权限位），与本次改动无关 |
| 工作区（组合跑） | 同上 | `vitest run` 两个 host 测试入口 | 179 passed + 1 次 `Timeout waiting for worker to respond`（pool teardown） | 单跑同目录复现不出，判为运行器一次性 teardown 抖动 |

## 接续 / 结果

未提交：实现进行中。
回收：未回收（任务进行中）。
下一步：改 runtime 与 adapter，补两条用例并做变异验证。
