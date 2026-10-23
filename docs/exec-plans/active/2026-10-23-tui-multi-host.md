# 让 duya tui 支持多窗口:一个数据目录一个可共享的 Host

状态：active · 负责人：mavis · 更新：2026-10-23
分支：codex/tui-multi-host · worktree：E:/Projects/duya/.claude/worktrees/tui-multi-host · base：c81ed169 · owner：mavis

## 目标与边界

`duya tui` 在同一台机器上可以同时开多个终端窗口，各自连到同一个 Host，读写同一份 `~/.duya` 数据库。

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

- [x] 1. worker 入口路径解析不再依赖 cwd（前置缺陷）——`137e58c8`
- [x] 2. `duya serve --client-scoped`：Host 跟踪客户端存活，最后一个客户端断开后自动退出
- [x] 3. `duya tui` 发现不到 Host 时拉起后台 Host 并附着
- [x] 4. owner 锁冲突转可操作提示；顺手修好三个静默失效的 Commander 选项
- [x] 5. 测试与验收

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

**实施中发现：Commander 按驼峰属性名存选项**。`serve.getOptionValue('client-scoped')` 返回 `undefined` 而不是抛错，选项被**静默丢弃**。同类问题已存在两处：`duya chat --runtime-file` 与 `duya chat/tui --api-format` 一直是失效的（`packages/cli/src/index.ts`）。只有单词选项两种写法同名，所以 bug 恰好只落在带连字符的选项上。本次一并修正，并在 `buildProgram` 的注释与 `packages/cli/AGENTS.md` 里写明这条规则；新增 `packages/cli/src/__tests__/cli-options.test.ts` 锁住它。

**客户端在场用「租约」而不是「请求频率」**：一个正在流式输出的长轮次**完全不发请求**，只有一条打开的事件流；按请求频率判断会把这种客户端判成已离开。租约是客户端主动持有的长连接（`GET /v1/host/lease`），在它想 Host 活着期间一直开着。Host 侧只数租约个数，从不因此拒绝谁——它是**在场信号，不是锁**。

**实施中发现：客户端租约端点必须先于 `server.close()` 拆掉**。Node 的 `server.close()` 会等所有连接结束，一个开着的租约会让关机永远等下去。所以 `close()` 先销毁租约响应，再关服务器。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| c81ed169（仅新增本计划） | Windows / Node 24.16 | 只读调研与实测，未运行门禁 | 未验证 | 见「发现与决策」实测表 |
| 137e58c8 | Windows / Node 24.16 | `npm run -w @duya/cli typecheck` | 0 | 切片 1 |
| 137e58c8 | Windows / Node 24.16 | `npx vitest run packages/cli/src/worker-path.test.ts` | 0；8 用例通过 | 切片 1 |
| 137e58c8 | Windows / Node 24.16 | 仓库外 cwd 跑 `duya serve`（数据根 = 临时目录） | `Execution: enabled`；`provides` 含 `agent_run_execution`（此前是 LEDGER-ONLY） | 切片 1 真实链路 |
| worktree dirty | Windows / Node 24.16 | `npm run -w @duya/data typecheck` / `-w @duya/host typecheck` / `-w @duya/cli typecheck` | 0 / 0 / 0 | 三个包 |
| worktree dirty | Windows / Node 24.16 | `npx vitest run packages/host/tests/client-lease.test.ts` | 0；7 用例通过 | 租约与自动退出 |
| worktree dirty | Windows / Node 24.16 | `npx vitest run packages/cli/src/__tests__/background-host.test.ts` | 0；4 用例通过 | 后台启动器（含双启动竞态） |
| worktree dirty | Windows / Node 24.16 | `npx vitest run packages/cli/src/__tests__/cli-options.test.ts` | 0；4 用例通过 | Commander 驼峰属性名 |
| worktree dirty | Windows / Node 24.16 | 端到端：独立数据根 + 两个真实 `duya tui` + 后台 `serve --client-scoped` | 两个窗口都连到 `http://127.0.0.1:55258`；45 s 后后台 Host 自行退出，descriptor / owner 锁 / `host.lock` 全部释放 | 验收 1–3 |
| worktree dirty | Windows / Node 24.16 | `npm run architecture:check` | 0；**无新增越界** | 255 条 baseline 指纹不再触发（既有债务，未重录） |
| worktree dirty | Windows / Node 24.16 | `npm run typecheck:all` | 0；整条链跑完，末步 eval check 4/4 | 首跑被 `check:encoding` 拦下（计划文档一个乱码字符），已修后重跑通过 |
| worktree dirty | Windows / Node 24.16 | `npx vitest run packages/cli packages/host/tests` | 0；**273 文件 / 2804 用例通过**，1 skipped | 无回归 |

## 接续 / 结果

已实现（分支 `codex/tui-multi-host`，未合并），共 5 个提交：

| 提交 | 内容 |
| --- | --- |
| `13ddb9f0` | 本计划 |
| `137e58c8` | 切片 1：worker 入口路径解析以 CLI 安装位置为锚 |
| `1ded68d3` | 切片 2：Host 客户端租约端点与 client-scoped 自动退出 |
| `2cf675f0` | 顺带修好三个静默失效的 Commander 选项（`--api-format`、`--runtime-file`） |
| `dcb23acf` | 切片 3+4：TUI 拉起可共享的后台 Host；owner 锁冲突转可操作提示 |

要点：

- **切片 2**：新增 `packages/host/src/client-lease.ts` 与 `GET /v1/host/lease`。`startLocalHost({ clientScoped: true })` 的 Host 在最后一个客户端离开后自行关闭，释放 descriptor、`host.lock` 与数据库 owner 锁。租约是**在场信号**，不是锁：多个客户端可同时持有。
- **切片 3**：新增 `packages/cli/src/tui/background-host.ts`。`duya tui` 找不到 Host 时拉起一个**独立进程**的 `duya serve --client-scoped`（detached，输出写 `<dataRoot>/logs/background-host.log`），等 descriptor 出现后附着。两个终端同时启动时以「读到 descriptor」为准，落败者附着到胜者。
- **切片 4**：owner 锁冲突改为可操作提示（点名 pid、给出 `DUYA_DATA_ROOT` 旁路）。`DatabaseOwnerLockError` 现在带结构化的 `ownerPid` / `ownerHostname`，不用再解析报错文本。
- 文档：`packages/cli/AGENTS.md`、`packages/host/AGENTS.md` 更新排障入口与关键文件表。

验证范围：三个包 typecheck、`architecture:check`、`typecheck:all`、cli+host 全量 2804 用例、以及真实进程上的双窗口端到端场景。

未覆盖：Electron 桌面端未重建（本次未改 main/preload，但 `packages/host` 的 dist 被 CLI 依赖，PR 前应跑一次 `npm run electron:build`）；`duya chat` 的多客户端行为未做端到端验收（它复用同一个 Host 与租约端点，但本次只在 TUI 路径上验证）。

回收：不适用，PR 未创建、未合并。
下一步：创建 PR；PR 描述里写清验收 1–6 的实测结果与上面「未覆盖」两项。

