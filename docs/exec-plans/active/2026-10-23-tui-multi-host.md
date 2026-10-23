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
- [x] 6. 重建被跟踪的 worker bundle（`85d74c86`）并跑通 `bundle:verify`

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
| 85d74c86 | Windows / Node 24.16 | `npm run bundle:verify` | 0；`FRESH 0/922` bundle inputs | 被跟踪产物与新租约端点同步 |
| 85d74c86 | Windows / Node 24.16 | `npm run electron:build` | 0；`Electron build complete`，native 模块已复制 | 桌面端打包链路未被本次改动破坏 |
| 85d74c86 | Windows / Node 24.16 | `npm run check:encoding` | 0；OK（11 known） | 编码门禁 |
| 45feb62f | Windows / Node 24.16 | `npx vitest run --changed=<origin/master> --maxWorkers=2`（与 CI 同范围） | 0；**183 文件 / 1766 用例通过**，6 skipped | 本地复现 CI 的测试范围，全绿 |

## CI 状态（run 39981375971）

`architecture`、`typecheck (ubuntu-latest)`、`build (ubuntu-latest)` 全过；`test (ubuntu-latest)` 唯一失败项是**一个未捕获异常**，而非用例失败：

```
Test Files  155 passed (155)      ← 全部测试文件通过
Tests       1441 passed | 6 skipped (1447)
Errors      1 error
Uncaught Exception: ENOENT: no such file or directory, open '/tmp/duya-cron-test-SMdvkM/logs/app.log'
  originated in apps/desktop/src/main/cli/handlers/crons.test.ts
```

**判定为 CI 上既有的共享 flake，与本改动无关**，三条独立证据：

1. **改动面不重叠**：本 PR 的 19 个改动文件里**零个**涉及 `logger` / `crons` / `automation` / `logging`。成因是 `crons.test.ts` 的 `afterEach` 用 `rmSync` 删掉临时目录后，还有异步日志写入在飞（`apps/desktop/src/main/logging/logger.ts:44` 把 `DUYA_CLI_USER_DATA_DIR` 当日志根）。
2. **同一时刻、同一签名的旁证**：并行跑的 **PR #396**（run 39980113738，不含本 PR 任何改动）报出**字节级相同**的错误：`ENOENT: open '/tmp/duya-cron-test-9YSI9Y/logs/app.log'`，同样是「Test Files 全 passed + 1 error」。
3. **本地同范围全绿**：以 CI 相同的 `--changed` 口径跑，183 文件 / 1766 用例通过，exit 0。

注：master 上的 push run（run 39975324429，SHA `c81ed169`）虽然 `test` job 显示 success，但按 `scripts/ci/test-scope.mjs:210`，push 事件的 `unit_scope=skip`，**测试步骤根本没执行**，因此不能作为对照基线；PR 触发的 run 才是可比口径。

## 接续 / 结果

已实现（分支 `codex/tui-multi-host`，PR #397 未合并），共 8 个提交：

| 提交 | 内容 |
| --- | --- |
| `13ddb9f0` | 本计划 |
| `137e58c8` | 切片 1：worker 入口路径解析以 CLI 安装位置为锚 |
| `1ded68d3` | 切片 2：Host 客户端租约端点与 client-scoped 自动退出 |
| `2cf675f0` | 顺带修好三个静默失效的 Commander 选项（`--api-format`、`--runtime-file`） |
| `dcb23acf` | 切片 3+4：TUI 拉起可共享的后台 Host；owner 锁冲突转可操作提示 |
| `4e870109` | 文档：`packages/cli/AGENTS.md`、`packages/host/AGENTS.md` |
| `85d74c86` | 重建被跟踪的 `packages/host/bundle/worker-entry.js`（新增租约端点后必须同步产物） |
| `45feb62f` | 本计划的验证记录补记（bundle / electron:build / CI 判定） |

要点：

- **切片 2**：新增 `packages/host/src/client-lease.ts` 与 `GET /v1/host/lease`。`startLocalHost({ clientScoped: true })` 的 Host 在最后一个客户端离开后自行关闭，释放 descriptor、`host.lock` 与数据库 owner 锁。租约是**在场信号**，不是锁：多个客户端可同时持有。
- **切片 3**：新增 `packages/cli/src/tui/background-host.ts`。`duya tui` 找不到 Host 时拉起一个**独立进程**的 `duya serve --client-scoped`（detached，输出写 `<dataRoot>/logs/background-host.log`），等 descriptor 出现后附着。两个终端同时启动时以「读到 descriptor」为准，落败者附着到胜者。
- **切片 4**：owner 锁冲突改为可操作提示（点名 pid、给出 `DUYA_DATA_ROOT` 旁路）。`DatabaseOwnerLockError` 现在带结构化的 `ownerPid` / `ownerHostname`，不用再解析报错文本。
- 文档：`packages/cli/AGENTS.md`、`packages/host/AGENTS.md` 更新排障入口与关键文件表。

验证范围：三个包 typecheck、`architecture:check`、`typecheck:all`、`bundle:verify`、`check:encoding`、cli+host 全量 2804 用例、`electron:build`、CI 同口径 `--changed` 183 文件 / 1766 用例，以及真实进程上的双窗口端到端场景。

**关于 `electron:build` 的产物噪音**：它内含 `bundle:worker`，重建的 `worker-entry.js` 与已提交版本**字节不同但语义相同**——esbuild 的 minify 标识符分配不可复现（`scripts/architecture/bundle-verify.mjs` 开头即记录了这一点），叠加 `packages/capabilities/src/ModuleTool/inline-content.ts` 被构建改行尾（-10 字节 / 10 行 CRLF→LF）。实测两份产物的 require 目标、HTTP 路径、路由、lease 引用四组锚点集合**完全一致**（41 / 158 / 35 / 83），metafile 输入集合也一致，唯一变化是 `inline-content.ts` 的行尾。`bundle:verify` 的判据是基于 Git 的新鲜度而非字节比对，因此这两份产物都算 FRESH。**处理方式是还原到已提交版本**（`git checkout -- packages/host/bundle/`）：已提交的那份才是 CI 验证过的，重建副本只会制造噪音 diff。

未覆盖：`duya chat` 的多客户端行为未做端到端验收（它复用同一个 Host 与租约端点，但本次只在 TUI 路径上验证）。

回收：不适用，PR #397 未合并。
下一步：等 CI 的 `test` job 这个既有 flake 消失或由集成者评估；合并需获授权集成者用 merge commit，随后重验并核对清单。

