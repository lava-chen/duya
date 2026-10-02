# Tech Debt Tracker

> 设计文档描述的目标状态与仓库实际状态之间的已知差距。
> 每条必须有**实测证据**和**明确的解锁条件**；没有解锁条件的条目等于没登记。

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
