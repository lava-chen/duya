# 让 duya tui 支持多窗口:一个数据目录一个可共享的 Host

状态：active · 负责人：mavis · 更新：2026-10-23
分支：codex/tui-multi-host · worktree：E:/Projects/duya/.claude/worktrees/tui-multi-host · base：c81ed169 · owner：mavis

## 目标与边界

`duya tui` 在同一台机器上可以同时开多个终端窗口，各自作��同一个 Host，读写同一份 `~/.duya` 数据库。

允许修改 `packages/cli`、`packages/host`、`packages/agent-protocol`（如需要）。本次**不改 `DatabaseOwnerLock` 语义**，不做多进程共享 SQLite 写入，不建跨进程事件总线；`memory-state.db` 仍归 Desktop，TUI 不读。

关联：[2026-10-22 Desktop 与 TUI 共用 Host](2026-10-22-single-host-multiclient.md)（PR #360，已合并）实现了 Desktop(Host)→TUI(客户端)这一半；本计划补 **TUI→TUI** 那一半。610 队列 T40「最小 Web」依赖同一个「独立 Host + 多客户端」形态，本计划是它的前置。

用户已决策（2026-10-23 问卷）：TUI 找不到 Host 时**自动拉起后台 Host**；后台 Host 在**最后一个客户端断开后退出**（对齐 pi 的 server 引用计数语义）。

## 验收

1. 两个终端依次执行 `duya tui`：第二个**不出现** `DatabaseOwnerLockError`，启动行显示与第一个相同的 Host origin，两个窗口都能新建会话并发消息。
2. 关闭第一个窗口：第二个窗口继续可用（Host 未退出）。
3. 关闭最后一个窗口：后台 Host 在宽限期后退出，`~/.duya/.duya-db-owner-*.lock` 释放，`~/.duya/runtime/host-api.json` 移除。
4. 在仓库外目录执行 `duya serve` / `duya tui`：Host 仍为 `Execution: enabled`，不再退化为 LEDGER-ONLY。
5. 数据目录已被其它进程占用时：`duya tui` 给出**可操作提示**（不是裸栈），退出码非 0。
6. 门禁：`npm run typecheck:all`、`npm run architecture:check`、相关 vitest。

## 进度

- [ ] 1. worker 入口路径解析不再依赖 cwd（前置缺陷）
- [ ] 2. `duya serve --client-scoped`：Host 跟踪客户端存活，最后一个客户端断开后自动退出
- [ ] 3. `duya tui` 发现不到 Host 时拉起后台 Host 并附着
- [ ] 4. owner 锁冲突转可操作提示
- [ ] 5. 测试与验收

## 发现与决策

**根因**：`duya tui` 在自己进程里内嵌起 ephemeral Host。ephemeral 的定义是「不写 runtime descriptor、不拿 host.lock」（`packages/host/src/local-host.ts:362`、`:640`），但它**照样打开 DB、照样抢 owner 锁**（`:375`）。第一个 TUI 因此造成「有主但没人找得到」：第二个 TUI 读 `~/.duya/runtime/host-api.json` 读不到 → 回落自起 Host → 撞 `DatabaseOwnerLockError`。已在用户机器复现（PID 43148 持有两个 `.duya-db-owner-*.lock`，descriptor 不存在）。

**已验证的地基**（2026-10-23 实测，均在独立 `DUYA_DATA_ROOT` 下）：

| 事实 | 证据 |
| --- | --- |
| `duya serve` 能独立存活、写 descriptor、拿 DB 锁 | serve stdout：`Duya Host listening at http://127.0.0.1:53697` + `runtime/host-api.json` |
| `duya serve` 声明 `agent_run_execution` | `/healthz` → `provides: [session_persistence, workspace_filesystem, settings_store, agent_run_execution]` |
| 第二个 `duya tui` **今天就能附着**到 `duya serve` | tui stdout：`duya tui · Host http://127.0.0.1:53924 (api v1)`，无 owner 锁错误 |

⇒ 「一个 Host + 多个客户端」在 duya 里已经成立，缺的只是 TUI 无 Host 时的**取得方式**。

**前置缺陷**：`resolveHostWorkerPath()` 只认 `process.cwd()/packages/host/bundle/worker-entry.js`（`packages/cli/src/worker-path.ts:9`）。在仓库外执行 `duya serve` 实测得到 `Execution: LEDGER-ONLY (no worker entry found; set DUYA_HOST_WORKER_PATH)` → 无 `agent_run_execution` → TUI 附着会被 `discoveredHostRefusal` 拒绝。**后台 Host 方案在仓库外不成立，必须先修这条。**

**与上游的对照**（决定本计划不碰 `DatabaseOwnerLock`）：

- codex：状态库**零独占锁**，靠 `WAL` + `busy_timeout=5s` + `BEGIN IMMEDIATE` + BUSY 退避重试（`codex-rs/state/src/sqlite.rs:503,384`、`codex-rs/state/src/sqlite/busy_retry.rs:26-40,151`）；排他粒度降到 per-thread 的 OS advisory 锁（`codex-rs/rollout/src/writer_lock.rs:43-86`）；状态入口收敛到 app-server，daemon 的 `daemon.lock` **只锁启停不锁数据**。
- pi：TUI 路径不用共享 DB，会话是每会话一个 append-only JSONL；下一代 `session-backends/sqlite-node` 用 `WAL` + `busy_timeout=5000`（`src/sqlite/repo.ts:172-176`）+ **per-session writer lease + fence token**（`src/sqlite/storage/writer-leases.ts:16-31`）；server 模式服务端持有 per-session 单例 runtime + 引用计数，客户端取 shared/exclusive 租约（`packages/client/src/session-handle.ts:13`）。

**拒绝的方案**：删除或放宽 `DatabaseOwnerLock`。沿用 [2026-10-22 计划的结论](2026-10-22-single-host-multiclient.md:51)：它保护迁移执行、WAL checkpoint 调度、run/worker 归属与**进程内事件主干**；两个 owner 会得到两条互不可见的事件总线。codex/pi 没有这个顾虑，是因为它们的状态入口只有一条（app-server / PiServer），事件总线天然只有一条。本计划补上 TUI→TUI 的入口，因此**不需要动锁**。

**后台 Host 的生命周期实现选择**：用**客户端身份 + 心跳**，不用 TCP keep-alive 计数，也不用新增协议端点。

- TCP 连接计数不可靠：TUI 空闲时可能没有长连接，且 keep-alive 超时由 server 决定，语义隐式。
- 新增端点会动 `agent-protocol` 的版本化契约，成本更高。
- 选定：请求头 `x-duya-client-id`（**纯增量**，不改协议版本）+ Host 侧 `Map<clientId, lastSeenAt>` + 客户端定期发 `getHealth()` 心跳。Host 在 `--client-scoped` 模式下，若所有已知客户端都超过宽限期未见 → 自行关闭并释放 DB 锁。

**竞态处理**：两个 TUI 同时启动 → 都发现没有 descriptor → 都尝试拉起后台 Host → `host.lock` 让其中一个失败。处理办法是**都以「读到 descriptor」为准**：spawn 之后轮询 `readLocalHostRuntime()`，谁写成功谁提供 descriptor，落败的那个直接附着到胜者，不视为错误。

**已知取舍**：后台 Host 退出时会一并关闭它派生的 worker；宽限期取值让「刚关掉一个窗口再开一个」不必重启 Host。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| c81ed169（仅新增本计划） | Windows / Node 24.16 | 只读调研与实测，未运行门禁 | 未验证 | 见「发现与决策」实测表 |

## 接续 / 结果

计划已写，实现未开始。

下一步：在本 worktree 完成切片 1（worker 路径解析），跑 `npm run -w @duya/cli typecheck` 与相关 vitest。
