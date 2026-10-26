# TUI 租约丢失与事件流中断的韧性修复

状态：active · 负责人：本会话 (2026-10-26) · 更新：2026-10-26
分支：codex/tui-lease-resilience · worktree：E:/Projects/duya/.claude/worktrees/lease-resilience · base：e9391659 (origin/master) · owner：本会话

## 目标与边界

用户在 dev:tui 的回合中出现 `× terminated`，下一条消息变成 `× fetch failed`，但 worker
实际已经跑完并持久化了完整答案（2026-10-26 会话 `9e59852d`，run `c212be6f`）。

已确认的链条（证据见「发现与决策」）：

1. client-scoped Host 的最后一个 lease 消失；Host 只记录 idle 判定，不记录 acquire /
   release，丢失原因不可见。
2. 30 s 宽限后 `onIdle` 调 `shutdownHost`，它**先** `server.close()`——这一步销毁在途
   run 事件流——**之后**才 drain worker。用户看到的 `terminated` 来自这里。
3. CLI 的 `watchAgentRunEvents` 是单次 `for await`，没有重连，传输错误直接成为回合错误。
4. Host 已经关闭，用户下一条消息得到 `fetch failed`。
5. lease 客户端不知道自己已经丢失，也没有重新申请。

本次实现的行为变化：

- Host 记录每次 lease 的获取 / 释放、持有时间、释放原因与剩余租约数，并在 idle 判定触发
  时记录当时状态：下一次事故可以从日志定位到「谁在什么时候掉线」。
- Host 的 idle 停机在 worker 仍 mid-turn 时先等待回合 settle（有界，沿用
  `idleShutdownDrainTimeoutMs`），**再**关闭 HTTP 服务，run 事件流在回合结束前保持可读。
- idle 等待或停机开始前若有客户端重新建立 lease，取消这次停机并继续服务。
- CLI 的 lease 在传输层丢失后按退避重新申请；Host 不提供 lease（404）时保持不申请。
- CLI 的 run 事件流中断后从 `afterSeq` 续订；若 run 已终结，用 durable 事件补齐后再按记录
  判定终态。一次断线不再等于回合失败。

不处理：

- TUI 先起后台 Host、再开 Desktop 仍会撞 `DatabaseOwnerLockError` 的启动顺序问题——属
  [TUI 多 Host](2026-10-23-tui-multi-host.md)。
- 让 Desktop 的 Host 支持 lease：它不走 `clientScoped`，没有 idle 停机。
- usage 实时帧与 provider 上报口径；drain 默认上限（仍为 120 s）。

关联：[租约 GC 与 footer 宽度](2026-10-25-tui-lease-gc-and-footer-width.md)（#487 的
「保留 Response」与 drain）、[Desktop 与 TUI 共用 Host](2026-10-22-single-host-multiclient.md)
（lease 是 presence 信号，不是锁）。

路径所有权：`packages/host/src/client-lease.ts`、`http-server.ts`、`local-host.ts`、
`idle-shutdown.ts`（新增）、`http-client.ts`；`packages/cli/src/tui-command.ts`、
`packages/cli/src/chat.ts`、`packages/cli/src/tui/client-lease-holder.ts`（新增）、
`packages/cli/src/tui/run-event-resume.ts`（新增）及对应测试。

## 验收

- 基线（e9391659，未改动）：`npx vitest run` 下列 5 套件 27 tests 全绿。
- 新增用例覆盖：lease 日志事件（获取 / 释放 / 原因）、mid-turn 时先 settle 再关服务、
  drain 期间重新附着取消停机、lease 丢失后重新申请、事件流断线后从游标续订、
  run 已终结时用 durable 事件补齐。
- `npm run typecheck:all`、`npm run architecture:check` 通过，只允许既有 baseline。
- 真机冒烟（合并后）：`npm run build:cli-dev` + `dev:tui`，确认回合期间人为杀掉 lease
  仍能看到答案；退出 TUI 后 background Host 在 idle 宽限后自行退出。

## 进度

- [x] 事故链与基线确认
- [x] 建独立 worktree、依赖 overlay 与 `build:packages`
- [x] Host：lease 可观测 + 重附着回调
- [x] Host：idle 停机改为 turn-aware（先 settle 再关服务，可取消）
- [x] CLI：lease 丢失检测与重新申请
- [x] CLI：run 事件流游标续订
- [ ] 测试、门禁、PR（测试与门禁已完成，PR 待建）

## 发现与决策

- 事故证据（2026-10-26）：`~/.duya/logs/background-host.log` 在 17:26:06 出现
  `Idle shutdown: waiting for mid-turn workers to settle {"timeoutMs":120000}`，而
  worker 日志同一 run 在 03:30:20Z 写的是 `engine run settled: completed`、
  `Persisted token budget delta: +11830`，没有任何 provider / stream 错误。答案在
  rollout 里完整存在（`64fb4742`，2924 字符）。即：run 没坏，是 Host 先关掉了用户正在
  看的流。
- `http-server.close()` 先销毁 `#activeRunEventStreams`，所以「先关服务再 drain」必然把
  用户正在看的回合显示成 `terminated`，即使 worker 马上就会完成。顺序必须反过来：
  drain 时服务仍开着，run 的事件继续写给客户端；drain 结束后才关闭。
- idle 判定是一次快照，不是持续状态。drain 可能持续到两分钟，期间客户端完全可能回来
  （重启终端、lease 重连）。因此需要 `onClientAttached` 取消待执行的停机，否则韧性修复
  会在客户端回来后把它踢掉。
- 丢失原因必须由 Host 记录：客户端（`tui-command.ts`）目前把 lease 获取失败静默转成
  `null`，Host 又不记录 release，事故后无法区分「lease 请求失败」「连接被回收」「Host
  自己销毁」。日志只写数量与时长，不写 token 与请求内容。
- lease 重新申请只能做在客户端：Host 无法区分「客户端崩了」与「连接抖了一下」，只有
  客户端知道自己还想让这个 Host 活着。Host 不提供 lease（桌面 Host 或前台 `duya serve`）
  时返回 `null`，保持不申请。
- 续订游标取自 `HostEventStream` 实际接受的最后一个 seq，而不是 socket 层。`HostEventStream`
  已经按 seq 去重，重放安全；若 run 在断线期间终结，SSE 可能不再给出完整历史，因此先用
  `readAgentRunEvents({ afterSeq })` 补齐 durable 事件，再读 run 记录判终态。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| e9391659（未改动） | win32 / node v24.16.0 | `npx vitest run`（client-lease / local-host / worker-manager-settle / chat-tui-host-stop-continue / tui-host-attach） | 0，5 suites / 27 tests passed | 基线全绿 |
| e9391659 + 本切片未提交改动 | win32 / node v24.16.0 | `npx vitest run`（上列 5 套件 + idle-shutdown / client-lease-holder / run-event-resume / chat-tui-lease-loss / host-event-stream） | 0，10 suites / 57 tests passed | 新增 17 个单测 + 1 个真机 Host e2e |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 全仓 strict 通过 |
| 同上 | 同上 | `npm run architecture:check` | 0，`OK — no new boundary violations` | 另有 3 条既有 fingerprint 不再触发的提示，与本次无关 |

新增 e2e `chat-tui-lease-loss.test.ts` 用真实 ephemeral client-scoped Host（`clientLeaseIdleTimeoutMs: 100`、
`idleShutdownDrainTimeoutMs: 15_000`）复现事故：回合中途关闭 lease，1.5 s 后重新附着，断言
答案仍到达 TUI、`view.errors` 为空、run 记录为 `completed`、Host 仍健康；再关闭新 lease 后
Host 在宽限后自行退出。这覆盖了「lease 丢失 → idle → 先 settle 再关」与「重附着取消停机」
两条路径的真实链路，而不只是 mock。

## 接续 / 结果

- 已完成：Host lease 生命周期日志（acquired / released + `heldMs` / `reason` / `leases`）与 idle
  判定日志；`createIdleShutdown` 把 drain 移到 `server.close()` 之前，等待期间可被重附着取消；
  `HostClientLease.lost` 让客户端知道租约被 Host 结束；`holdClientLease` 退避重申请；
  `watchRunEventsWithResume` 从 `afterSeq` 续订并在 run 已终结时用 durable 事件补齐。
- 已实现、已验证：上表全部命令在本检出退出码 0。
- 未验证：合并后的真机冒烟（`npm run build:cli-dev` + `dev:tui`）。
- 未处理：TUI 先起后台 Host 再开 Desktop 的 DB owner 顺序问题（归
  [TUI 多 Host](2026-10-23-tui-multi-host.md)）。
- 下一条动作：提交并开 PR，等 CI 与 review；合并授权后做真机冒烟。
- 注意：`packages/capabilities/src/ModuleTool/inline-content.ts` 是检出级 EOL 幻影
  （`git diff --ignore-cr-at-eol` 为空），不得提交。
