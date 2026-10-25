# TUI 租约 GC 断连与 footer 宽度修复

状态：active · 负责人：ZCode 会话 (2026-10-25) · 更新：2026-10-25
分支：codex/tui-lease-drain-footer · worktree：E:/Projects/duya/.claude/worktrees/tui-lease-fix · base：270ba528 (origin/master) · owner：本会话

## 目标与边界

用户在 dev:tui 实测遇到三个症状（2026-10-25 17:25 会话 `3c0435fa`）：

1. `✗ terminated`：TUI 的 client lease 连接被 GC 掐断（`openClientLease` 未保留
   `Response` 引用，undici 取消未读 body 关闭连接），client-scoped Host 30s 后
   判定空闲自杀，`killAll()` SIGTERM 了 mid-turn worker。已用最小复现脚本证实
   （保留引用则连接存活）。
2. token 统计停在第一回合：同上（第二回合未 finalize 即被杀）；usage 帧本身
   是 per-finalized-call 粒度（run-engine 刻意设计，不在本次范围）。
3. footer 模型标签 `medium` → `mediu`：`⚡`(U+26A1) 在 blessed 宽度表量 1 列、
   Windows Terminal 画 2 列，右对齐行末字符被顶出 ConPTY 末列裁掉。

本次修复：A) lease 客户端保留 Response 引用；B) Host 空闲停机前等待 mid-turn
worker 结束（有界）；C) footer 速率标签去掉 `⚡`。

不处理：usage 实时帧接入 CLI（P3 feature，数据在 ring 已算好但链路未接）；
MiniMax input=0 的上报口径；blessed 宽度表 vendoring（cell-width.ts 注明是
独立变更）。

关联：租约机制来自 [单 Host 多客户端](2026-10-22-single-host-multiclient.md)。
路径所有权：`packages/host/src/http-client.ts`、`packages/host/src/local-host.ts`、
`packages/host/src/worker-manager.ts`、`packages/cli/src/tui/footer.ts` 及对应测试。

## 验收

- `npx vitest run packages/host/tests/client-lease.test.ts packages/host/tests/local-host.test.ts packages/host/tests/worker-manager-*.test.ts packages/cli/src/tui/__tests__/footer.test.ts`（在检出根）全绿，含新增用例。
- 新增：lease 保留用例（连接在 GC 压力下不落）、drain 用例（idle 停机等待 STREAMING worker 结束再 kill，超时则继续 kill）。
- 基线：改动前先跑同范围测试记录既有失败。
- `npm run typecheck:all`、`npm run architecture:check` 通过（只允许既有 baseline）。

## 进度

- [x] 诊断三症状根因（ lease GC / usage 粒度 / ⚡ 宽度差 1）
- [x] 建 worktree（junction 58 links）+ 计划文档
- [x] 基线测试记录（42 测试全绿）
- [x] Fix A：openClientLease 保留 Response
- [x] Fix B：WorkerManager.waitForWorkersToSettle + local-host idle 停机 drain
- [x] Fix C：formatTokensPerSecond 去掉 ⚡
- [x] 门禁与测试
- [ ] commit + PR

## 发现与决策

- 复现证据：lease fetch 返回后 Response 出作用域，node 24 下连接 8.1s 后被服务端
  观察到关闭；保留引用对照组 65s 存活。事故时间线：17:25:26 拿租约 → ~17:25:34
  GC 掐断 → +30s 宽限 → 17:26:06 `Killing all workers`。
- worker-manager 的 `sessionLifecycle.getState()`（run-execution.ts:252 接
  WorkerSessionRegistry）足以判断 mid-turn（`STREAMING`/`COMPLETING`）；
  run ledger（run-control-plane）是持久账本，无内存 settle 订阅，不用。
- drain 放在 shutdownHost 内 server.close 之后：此时不再接受新租约，窗口有界；
  显式关闭路径（SIGINT/SIGTERM → host.close()）保持立即退出，只有 onIdle 传
  drain 超时（默认 120s，可配 `idleShutdownDrainTimeoutMs`）。
- 去掉 `⚡` 而非补宽度表：cell-width.ts 注明 vendoring 是独立变更；过量测量
  （画窄的终端多 1 空格）无害，欠量测量（画宽的终端裁末列）有害，但补表先例
  不开，chrome 中唯一 emoji-presentation 字符就是它，删除即消除该类风险。
- lease 断连的最终机制（NODE_DEBUG=undici 实证）：Response 不可达后由 undici 的
  fetch GC finalizer abort 请求（日志 `request errored - undefined`），普通脚本
  约 8.1s 墙钟后发生；显式 `globalThis.gc()` 因保守栈扫描反而不触发，vitest
  worker 内 10s 也不触发。因此 lease-GC 测试是行为哨兵（修复后确定性通过，
  回归时视回收时机而定），确定性证据靠独立复现脚本与本记录。
- 架构门禁出现 "2 baseline fingerprint(s) no longer triggered"：既有债务收缩，
  与本次改动无关，未做 `--write` 重录。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 270ba528（base，未改动） | win32 / node v24.16.0 | `npx vitest run`（client-lease / local-host / footer / worker-manager×3） | 0，42 passed | 基线全绿 |
| dirty（A/B/C 已落） | 同上 | 同范围 9 套件 | 0，90 passed（含 4 新增） | `npx vitest run` |
| dirty | 同上 | `npm run typecheck:all` | 0，pass 4 / fail 0 | 门禁 |
| dirty | 同上 | `npm run architecture:check` | 0，OK — no new boundary violations | 门禁 |
| stash 修复后 | 同上 | 旧代码跑 lease-GC 用例 | 通过（哨兵未触发，见发现） | 机制靠 NODE_DEBUG 复现 |

## 接续 / 结果

（待填）

回收：worktree 保留至 PR 集成。
下一步：基线测试 → 实现 A/B/C → 门禁 → PR。
