# 90 — 执行日志

## 2026-10-05 — 610 设立轮

### 本轮做了什么

把 600 / 601 / 602 合并为一条主线,并把"现在做到哪、下一步做什么"收敛到一处。
产出:[README](README.md)(状态源)、[01 A1 契约](10-slice-a1-g7-loop-detection.md)、
[02 客户端运行时轴](11-slice-a0-client-runtime-axis.md)(A0 的依据)。

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
**A1 的依据不是"S2 还没做完",而是判据本身坏了。**详见 [01](10-slice-a1-g7-loop-detection.md)。

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
结论见 [02](11-slice-a0-client-runtime-axis.md),并据此新增切片 **A0**。

### 纪律记录:本轮自己也犯了两次同类错

1. **引了两个不存在的文件**(`10-slice-a1-g7-loop-detection.md` 与本文件),
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

---

## 2026-10-05 — 单一计划收敛轮

### 做了什么

把 600 / 601 / 602 **从三个独立计划收成 610 的三章**。合并前 `active/` 下有三个目录,
索引里并排列了三行,每行各声明一个"唯一 next action",而**三行互不引用对方的顺序约束**。

那不是三份计划,是三个互相不知情的真相源。任何人只读索引,都会拿到三个互相矛盾的"下一步",
而且没有任何一处列出三者合起来后的全局顺序。

现在的结构:

```
active/610-architecture-series/
  README.md                        唯一入口,唯一 next action
  01-layered-architecture/         原 600,11 份
  02-headless-control-plane/       原 601,6 份
  03-sqlite-driver/                原 602,4 份
  10-slice-a1-g7-loop-detection.md
  11-slice-a0-client-runtime-axis.md
  90-execution-log.md
```

`active/` 下现在只有 587 与本系列。587 的合同已被第 01 章的 `10-takeover-from-587.md` 接管,
索引里降为 P1,只作查证来源,不再单独排期。

### 链接完整性

跨章移动会打断相对链接,所以**逐条重写后实测**,不是"应该没问题":

- 写了一个链接扫描器覆盖整个 `docs/exec-plans`,先测出本范围内的 30 条断链,
  修完再测,**610 与索引范围内 0 条**。
- 修的过程里第一版规则**过宽**:它把 600 自己的兄弟文件(`02-tooling-and-extensions.md` 等)
  也加上了 `../`,因为章节目录名 `01-`/`02-`/`03-` 与 600 内部文件编号前缀撞名。
  改成按实际文件名回退才对。**撞名是这类批量改写最容易静默出错的地方。**
- 扫描器顺带发现 `active/` 下另有一批**历史计划**(448/452/460/511/518 等)存在断链。
  那些与本轮无关,未动。

### 一次重复劳动的记录

发现本地分支 `fix/600-a1-turnloop-detection`(`c4b166a1`)已含**与本会话完全相同**的
`boundary-gates.mjs` 改动(逐字节一致),另加一份 191 行的 `mutation-proof-a1.mjs`。
那份变异证明 5/5 通过,并且记录了一个我没写的已知缺口(判据匹配名字而非职责)。
**采用它,丢弃本会话工作树里的副本。** A1 的合并应以那份分支为准。

---

## 2026-10-06 — A3 判据重定义轮

### 本轮最重要的一件事:G7 的目标定义本身是错的

A1 修好了判据,**门禁变准了,于是它开始报出真违规** —— 而真违规指向的那个边界,
按原计划搬代码**只会让门禁更红**。这不是"还没做完",是"目标写错了"。

三个探针,每个都注入 → 实测 → 回退 → `git status` 空:

| 探针 | G7 findings | 为什么 |
| --- | --- | --- |
| 循环搬进 `packages/agent/**`,被 value-import | **1 → 2** | 新模块仍在入口闭包内,立刻成为新 finding |
| 循环搬进 `agent-runtime/**`(G8 认的归属) | **1 → 2** | `agent-runtime/src/index.ts` 已经 `run-engine-model.ts:105` 在闭包内 |
| 修 G4(去掉入口直接 import) | **仍 2** | `MessageSessionTool.ts:7` value-import 入口,`DuyaAgent` 仍可达 |

**根因:worker 入口是进程根。** 运行中的 worker 按静态 value import 加载的模块,
按定义就在它的闭包里 —— 而循环必须被加载才能运行。
所以"入口不得可达循环"这个判据**不可满足**,且唯一的出路是动态 `import()`
(扫描器看不见 = 骗门禁)或换进程。

**唯一的诚实出路是改判据。** 已落地(`68e39283`):

- G7 改为**深度有界**:查 depth 0/1,即入口自己拥有或直接 import 的循环。
  这正是 S1a 描述的那个回归(入口自己构造循环而不是驱动 `ExecutionChannel`)。
- depth 1 之外的模块是**循环自己的调用链**加载的,正常。G8 已经按包判归属,
  两者合起来仍覆盖"循环放错地方"的两种方式,而且**各自都能真的转绿**。
- 变异证明:注入一个满足三子句的模块到入口 → `new 1 → 2` 并指名文件;
  回退 → `1`。双向已验。

### 变异证明抓到了我自己

改完判据后 `mutation-proof-a1.mjs` 从 5/5 掉到 **2/5** —— 因为它的 fixture 是
4 跳 adapter 链,超过新的深度上界。**这就是变异证明的价值:它抓的是"门禁悄悄不再检查"。**
已改为显式传深度(4,实测跳数,不是猜的),5/5 恢复。
顺带:那条"live tree is fully baselined"的红,已改成会**指名哪个门禁哪个文件**,
而不是一个无信息的布尔。它**故意保持红** —— 那是 A3 剩下的活。

### 判据修正不能靠重录 baseline 抹掉

610 §4 第 5 条禁止"为了让门禁变绿而加豁免"。G7 那条 finding 是真的,
所以正确处置是**让红信息更可判读**,而不是让它消失。

### 另一个真缺陷:门禁能全绿而 `typecheck:all` 是红的

PR #214 的 `a7193092` 给 `RunEventEmitter` 追加了一个与既有**逐字节相同**的
`async publish` → `TS2393`。**esbuild 不做类型检查,vitest 让后声明的赢**,
于是 `architecture:check` 绿、运行时测试绿、只有 `typecheck:all` 红。
原样合并会落下一个过不了自己 pre-commit 门禁的 master。已在 `70f3a85e` 修掉。

### 被实测推翻的数字(又一次)

我自己用 `node:` 前缀正则统计"某包碰 Node 内建的文件数",**两个都反了**:
`@duya/ai` 报 3 实为 **1**(两个 `auth/oauth` 的 `node:crypto` 只在文档注释里,
早就用 `crypto.subtle`);`plugin-core` 报 2 实为 **5**(另外 3 个写的是**裸** `fs`/`path`,
正则锚定 `node:` 完全匹配不到)。

**差点据此去"修正"一份准确的计划文档。** 正则带前缀锚点时先问:
**有没有人写成裸名字?** 统计这类东西要用仓库现成的解析器(`importsOf`),不要临时写 grep。

### 本轮实测门禁

| 命令 | 结果 |
| --- | --- |
| `npm run architecture:check` | **935/935 tolerated,无新增**,baseline 930 **未动** |
| `npm run architecture:self-test` | OK |
| `node scripts/architecture/mutation-proof-a1.mjs` | **5/5**,含负向对照 |
| `npx vitest run packages/plugin-core` | **22/22**(22 文件) |

### 未决

| # | 问题 | 归属 |
| --- | --- | --- |
| 1 | G7 的 depth 1 finding 仍在,红且**应当红**。转绿需要真正切断 `agent-process-entry.ts:76` 那条边 | A3 下一步 |
| 2 | B1:6 个 handler 自身的图层已可无 Electron 加载,但它们的依赖图里仍有 45 个层外硬 import(实测),A1 的"全图可加载"版本不在 B1 所有权内 | B1 续 |
| 3 | A0 §3.2 plugin-core 二分未做 —— 实测它对 renderer 闭包贡献 21 个文件、**0** 个 Node 内建,barrel 已排除真正碰 Node 的三个模块 | 独立切片 |
| 4 | 602/C1 是否值得做(理由已从"逃 ABI"降为"删原生依赖") | C1 |


