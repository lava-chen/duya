# Tech Debt Tracker

> 设计文档描述的目标状态与仓库实际状态之间的已知差距。
> 每条必须有**实测证据**和**明确的解锁条件**；没有解锁条件的条目等于没登记。

---

## TD-0 · 架构闸门曾经是红的，且红得毫无意义 ✅ 已修（2026-10-03）

| 字段 | 内容 |
|---|---|
| **状态** | ✅ **已修** — selfTest 与 baseline 同批重录，`architecture:check` 现 exit 0 |
| **实测（修前）** | `npm run architecture:self-test` **exit 2**，`architecture:check` **exit 1**、**641 blocking**、**815 / 941 baseline 指纹已不再触发** |
| **根因** | `.architecture-baseline.json` 是用**修复前的 resolver** 录的。policy 注释记载了两次 resolver 修复（`strip-comments.mjs`；`packages/<x>/dist/` → `src/` 回映射），二者都改变了指纹，但**只有 `selfTest` 块被更新，baseline 从未重录**。于是同一批旧边在新 resolver 下全部读作 "not in baseline" |
| **为什么危险** | 闸门红 = 没人读。而且它红的方式会**掩盖真回归**：641 条里混着 2 条真实新增（`package-boundary-escape` 161→162、`deep-import` 24→25，均来自 plan-583 栈），在 641 条噪声里完全看不见 |
| **修法** | ① 先按实测更新 `selfTest`（期望值必须先和实测一致，否则 self-test 会掩盖漂移）；② 再 `--write` 重录 baseline（顺序不可反）；③ 两处差异都在 policy 里写明来源，`git log` 核对而非推断 |
| **顺带查明** | 2 条真实新增**不是**新回归 —— `git log` 显示都来自 `fix/583-track-a-p0` / `fix/583-track-q-test-debt-2`，属"上次测量之后才落地的旧债"，进 baseline 是正确的；同时 `module-dependency` 563→548、`cycle` 17→16 是真改善（PR #130 删死代码带走的边） |

> **教训（比修复本身重要）**：`selfTest` 与 `baseline` 是**同一个测量**的两个消费者。
> 只维护其中一个，另一个就会变成噪音放大器 —— selfTest 绿着而 check 红着，
> 或者反过来。**任何改 resolver 的 PR 都必须同时 `--write` 重录 baseline。**
> 已写入 `architecture-policy.yaml` 的 re-measurement 注释。

---

## TD-1 · main 进程无类型门禁（`tsc` 898 个既有错误）

| 字段 | 内容 |
|---|---|
| **状态** | 开放 · 阻塞 M0 / M7 的 CI 收口 |
| **实测** | `npx tsc -p apps/desktop/tsconfig.main.json --noEmit` → **898 errors**（2026-10-01，`origin/master` @ `b6f8e7c0` 之前的 `electron/tsconfig.json`，其 `include` 还是一份不完整的手工清单） |
| **同源** | plan 583 ISS-01（shipped `remote-mcp.ts` type errors）—— 这是同一个洞的两次暴露 |
| **为什么现在不修** | 挂上 `typecheck:all` 立刻红，会阻塞一切改动。搬迁 PR 不承担这笔债 |
| **当前安全网** | `npm run build:electron`（esbuild 解析 main/preload 的**每一条** import 边）+ `npm test` |

### 背景

`typecheck:all` 历来只覆盖 renderer —— 根 `tsconfig.json` 显式 `exclude: ["electron/**"]`，
且没有任何 npm script 跑 electron 的 tsc。main 进程的 336k LOC 从未进入过类型系统。

M7 搬迁把这件事从"没有配置文件"变成"有分层配置但故意不挂门禁"，
`apps/desktop/tsconfig.main.json` + `tsconfig.preload.json` 已经就位（ZCode 形态），
`AGENTS.md` 的 Footguns 已写明这个空洞。

### 解锁条件（按顺序）

1. **T1** 把 `tsconfig.main.json` 的 `include` 收到实测的**错误基线**（不要一次收全，
   否则无法区分"新引入"与"既有"）。
2. **T2** 落 `.architecture-baseline.json` 指纹式基线（依赖 M0 的 `architecture-check.mjs`）。
3. **T3** 在 `architecture-check.mjs` 里加 `typecheck-error-count` 规则，
   以 `errorCount ≤ baseline` 为通过条件 —— **只拦新增**。
4. **T4** 基线归零后，把 `typecheck:main` 改成硬门禁，接进 CI required check。

> **不要**在 T1–T3 之前把 `typecheck:main` 写进 `typecheck:all`。

---

## TD-2 · 54 条 `main → renderer` 跨边界边

| 字段 | 内容 |
|---|---|
| **状态** | 开放 · 归属 M3（`packages/shared`） |
| **实测** | 搬迁后仍为 54 条（provider 24 最集中，preload 类型 4，plugin 9，其余零散） |
| **为什么现在不修** | M7 明确选择"机械改写、留给 M3"。先建 shared 再搬会多一轮改写 |
| **解锁条件** | M3 落地：`packages/shared` 承接跨进程契约后统一改写 |

> 详见 `docs/architecture/03-target-structure.md` §2.1。

---

## TD-3 · 注释术语漂移：`agent-server` 被描述为 "FORK"，实际是 `spawn`

| 字段 | 内容 |
|---|---|
| **状态** | 开放 · 纯文档债，改动 1 行 |
| **实测** | `apps/desktop/src/main/control-plane/run-control-plane.ts:5` 写 "The agent-server is a FORK."；而 `apps/desktop/src/main/agents/agent-server-lifecycle.ts:122` 用的是 `spawn(process.execPath, [serverPath], { stdio: ['pipe','pipe','pipe','ipc'] })`，**不是** `child_process.fork()` |
| **为什么是债** | 语义结论不变（子进程不能开 `duya-core.db`，只能经 `db:request` 回 main），但 "FORK" 会让读者以为它**继承了 main 的 IPC 通道**。实际那是一条**显式声明的** `stdio[3]='ipc'`，由 `agents/server/router.ts` 与 `agents/process-pool/message-router.ts` **各自手动路由** `db:request` |
| **解锁条件** | 把注释改为 "spawned child process with a dedicated IPC channel"。**建议随 C1.7（42 环）一并做** —— 那批文件本来就要动 |

> 附带同源问题：`packages/cli/src/program/build-agent-runner.ts` 的注释写
> "The agent's subprocess is the desktop process"，同样把 spawn 描述成了进程内继承。
> 这条更值得改，因为它直接决定了 `guardProcessExit()` / `captureStreams()` 的必要性 ——
> 读者若以为真是同一进程，就会问"为什么要防 `process.exit`"。

---

## TD-4 · `agent-src` 归属分析曾按 LOC 划，判据应是外部信号

| 字段 | 内容 |
|---|---|
| **状态** | 已修正（文档层）· 见 `03` §5.1 现值表 |
| **实测** | `modes/` 16,095 行里只有 **1 个**进程信号（那一个就是 core/runtime 切口本身）；`compact/` **零外部信号**却是 4 文件环；`tool/` 60,137 行含 9 PROC + 4 NET。按 LOC 划归属会把这三块全部划错 |
| **同类已发生的错误** | 同一份分析的第二轮结论"barrel 参与内部环，改掉能解环"也被第三轮削弱 —— 见 `01` §9 修正记录第 8 条 |
| **解锁条件** | 已解锁：所有归属裁决改用信号表。**流程要求**：归属与解环类结论必须由脚本输出驱动，落地前实测验证，不得读图推断 |

> 这两条 TD 指向同一个根因：**审计脚本各答一个问题（成员 vs 路径），
> 但两者的合取也不足以支撑"改这一处就能解环"。**
> 凡涉及边界/解环的结论，都要用"改 + 重跑计数"闭环验证。

---

## TD-5 · `02-cycle-budget.test.ts` 有与整份审计相同的解析器盲点

| 字段 | 内容 |
|---|---|
| **状态** | 开放 · 测试本身有效，但有一个断言**目前是空转的** |
| **实测** | `packages/agent-protocol/test/02-cycle-budget.test.ts:99` 的 walker 只收相对 specifier：`if (!spec.startsWith('.')) continue;`（第 99 行） |
| **后果** | 该文件的 `is a leaf: nothing outside the package imports it yet`（第 218–230 行）**看不见 `@duya/*` 跨包边**。实测已有 **27 个文件** import `@duya/agent-protocol`（`agent-runtime` 9、`agent-core` 8、`agent-protocol` 自身 3、`apps/desktop` 3、测试 4），但这个断言仍然通过 —— 它只统计了相对路径 |
| **为什么重要** | 这正是 `01` §9 修正记录第 1 条批评 ZCode 治理的那一类洞：**只解析相对 import 的 checker 从来没检查过任何跨包 import**。本仓库的 SCC 预算测试也有同一个盲点。`agent-protocol` 的"零 IO 零内部依赖"目前是**文档声明 + 相对路径层面成立**，不是跨包层面被强制 |
| **解锁条件** | ① 给 walker 加 workspace 包名解析（读各包真实 `exports` 字段，与 `audit-imports.mjs` 同一套 resolver）；② 改完后 `is a leaf` 断言**预期会失败**（因为 `agent-runtime`/`apps/desktop` 已在用）—— 届时需要把该断言从"无外部 import"改成"外部 import 只允许来自 `agent-runtime` 与 `apps/desktop`，且经 public subpath"；③ 与 M0.5 的 CI 接入同批做 |

> **不要**在 ① 之前把"protocol 是叶子"当成已被强制的事实。
> 这与 `03` §1.2 ① 的平台端口层是同一类问题：**没有闸门的边界不是边界。**
