# 90 — 执行日志

## 2026-10-05 — 610 设立轮

### 本轮做了什么

把 600 / 601 / 602 合并为一条主线,并把"现在做到哪、下一步做什么"收敛到一处。
产出:[README](README.md)(状态源)、[01 A1 契约](01-slice-a1-g7-loop-detection.md)、
[02 客户端运行时轴](02-client-runtime-axis.md)(A0 的依据)。

### 推翻的三个结论

#### ① 「600 的 11 份计划文档不在任何分支上」——错的

它们在 `docs/600-plan-archive`(1 ahead / 0 behind),一直好好的。
判据错误的来源:**只查了 `origin/*` 与工作区,一个本地分支都没看** ——
而 worktree 工作流恰恰会把大量"只存在于本地"的工作留在本地分支上。
这个错误结论被 `docs/exec-plans/README.md` 与 601 §8.2 引用,并据此推了三轮计划。
**一条关于"资料是否存在"的假事实,代价高于技术错误:照它行动会重建一个本来完好的东西。**

#### ② 602 的立论前提被实测推翻

| 前提 | 实测 |
| --- | --- |
| `better-sqlite3` 是 V8-ABI 原生模块 | **N-API 插件**(`node-addon-api`) |
| Node 与 Electron 需要两份 `.node` | 同一个 `prebuilds/win32-x64.node` 在 Node 24.16.0(ABI 137)与 Electron 44.2.0(ABI 149)下**都加载成功**,SQLite 3.53.4 |
| 需要 `ensure-sqlite-abi.mjs` 来回换 | `lib/binding.js` 先读 `prebuilds/`;`build/Release` 在标准 `npm ci` 后**根本不存在** |

因此 600 的「S6 排在 602 Phase 2 之后」**失去存在理由**(那条约束的唯一目的
是让机械改动先于语义改动落盘),**S6 解封**。602 不取消,降级为可选旁支 C1。

#### ③ 门禁 G7 指错了方向

`TURN_LOOP_SHAPE.modelStream` 硬编码 `/\.streamChat\s*\(/`,而 S2 已把模型请求
移进 `model-leg` 缝,于是该子句在真循环上失配、只在入口上成立。
**A1 的依据不是"S2 还没做完",而是判据本身坏了。**详见 [01](01-slice-a1-g7-loop-detection.md)。

### 本轮引入的新事实(回答"包能否同时驱动三端")

| 包 | 源文件 | 碰 Node 内建 | 浏览器安全 |
| --- | --- | --- | --- |
| `agent-protocol` | 32 | 0 | ✅ |
| `agent-core` | 5 | 0 | ✅ |
| `conductor` | 102 | 0 | ✅(但 `exports` 无 `./renderer`,**不可寻址**) |
| `ai` | 95 | 1(`node:crypto`) | ⚠️ |
| `plugin-core` | 44 | **5**(`fs`/`net`/`crypto`) | ❌ |

而 `apps/desktop/src/renderer` 从 `@duya/plugin-core` 与 `@duya/ai` import **值**。
**桌面 renderer 今天能跑,只是因为 Electron 的 renderer 带 Node。**
结论见 [02](02-client-runtime-axis.md),并据此新增切片 **A0**。

### 纪律记录:本轮自己也犯了两次同类错

1. **引了两个不存在的文件**(`01-slice-a1-g7-loop-detection.md` 与本文件),
   写进 README 时先写链接后建文件 —— 与我批评 600 索引"引用了不存在的分支"同源。
   已在合并前补齐。
2. **做重了 #215**:`docs/600-plan-archive` 那 11 份文档**已有一个 PR 在跑**,
   我开 PR 前没查已有 PR,把它们又搬了一遍。已改为关闭 #215、由本 PR 承载。

### 门禁实测

| 命令 | 结果 |
| --- | --- |
| `npm run architecture:check` | 932/932 tolerated,**无新增** |
| `npm run architecture:self-test` | OK |
| `npm run check:encoding` | OK |
| `npx vitest run packages/agent-runtime` | **632/632 in packages/agent-runtime(50 文件)** |
| `npx vitest run scripts/` | **279/284 in scripts(14 文件)** —— 4 红边界门禁 + 1 红切片分类,均为 master 既有 |

> `packages/agent-runtime` 那 8 条失败曾一度出现,根因是 master 重置后未重跑 `build:packages`:
> `packages/agent/dist` 与 `plugin-core/dist` 都不存在。补跑后恢复 632/632。
> **这是环境产物,不是回归** —— 与其相信数字,不如先排掉已知的环境原因。

### 未决

| # | 问题 | 归属 |
| --- | --- | --- |
| 1 | G7 判据改准后 live findings 变了,与 baseline 不一致。**新增的是真违规还是 `ports.ts` 的已知过读?** `--write` 会吞掉真违规,禁止 | A1 收尾 |
| 2 | 602 是否值得做(理由已从"逃 ABI"降为"删原生依赖") | C1 |
| 3 | `apps/web` 是否立项、何时建骨架 | B2 |
