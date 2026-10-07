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
| `conductor` | ~~102~~ → **118**(2026-10-06 更正) | 0 | ✅(但 `exports` 无 `./renderer`,**不可寻址**) |
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
| 1 | ~~G7 判据改准后 live findings 变了~~ **已答(2026-10-06):真违规,归 A3。** 详见 [A1 契约的收尾更正](10-slice-a1-g7-loop-detection.md#2026-10-06--收尾更正本文件的状态与未决问题均已过时) | 已关闭 |
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

### A3 第二轮:判据可判读了,但那条边**切不断**(未提交代码)

判据改成深度有界之后,A3 的真实问题浮出水面 —— 它不是"还没搬完",是**搬不动**。

**新实测(纠正上一轮的过期前提):**

| 上一轮说 | 实测 |
| --- | --- |
| `agent-runtime/src/index.ts` 在 depth 1,所以搬过去也会被报 | **它在 depth 3**(经 `run-engine-model.ts`,而后者不在 depth-1 集合里)。**"1 → 2" 的结论前提已失效** |
| `MessageSessionTool.ts:7` 造出第二条边 | 它**根本不在入口的可达集里** |
| 入口有 44 个 depth-1 模块 | 45 个,其中**只有 `:76` 一个** value-import `DuyaAgent` |

于是剩下的机制只有四种,逐一评估:

1. **工厂/适配器接缝** —— 入口照样拿到 `duyaAgent`、照样 `.streamChat()`。
   **这个仓库已经这么干过并记录在案**:`packages/agent-runtime/src/engine/ports.ts:12-15`
   写着 `headless-run-host.ts` "wires a real RunController around an executor that
   still calls duyaAgent.streamChat, and that combination **passes the old
   acceptance gate while the loop has not moved at all**"。工厂就是它换了个名字。**否决。**
2. **动态 `import()`** —— 骗门禁。**否决。**
3. **子进程边界** —— 门禁 docstring 自己列的答案,代价是整套启动路径。
4. **把循环搬到 `ExecutionChannel` 后面** —— 真解,但**它要的东西不存在**:
   `ports.ts:7` 明写 "Types and interfaces only. No implementation, no wiring",
   `workerImplementsExecutionChannel()` 返回 **false**。

**结论:A3 交的不是一个待搬的代码块,是一个缺失的实现。** 在 `ExecutionChannel`
落地之前,G7 的绿只能靠隐藏循环 —— 而那正是本仓库已经付过学费的假绿。

**未提交任何代码。** 树干净在 `34068b44`。

### 这一轮抓到的两个门禁自身缺陷

1. **`boundary-gates.test.ts:1031` 把 G7 钉死为红**(`toBeGreaterThan(0)`)。
   这让 A3 **无论怎么正确修复都会红**。已改为断言"每条 finding 都有文件、
   `via` 和理由",并用一次**无界深度调用必须找得到东西**来证明扫描非空转 ——
   空结果于是成为 A3 正在争取的合法状态,而不是被禁止的状态。
2. **`isTurnLoopModule` 传未剥注释的源码会答非所问。** 实测
   `packages/agent-runtime/src/engine/ports.ts`(每个 import 都是 `import type`
   的纯类型+文档模块,五处命中全是散文):`isTurnLoopModule(raw)` = **true**,
   `isTurnLoopModule(stripComments(raw))` = **false**。
   两个 live 调用点都已传 stripped,所以**门禁判定没变**;已加守卫与这段实测说明,
   防止下一个调用者踩同一个坑。

> 这两条的共同形状:**门禁在断言"当前结论"而不是"判据本身"时,就再也无法被修复。**
> 与 610 §4 第 5 条同源 —— 门禁必须**能红也能绿**。

### A3 第三轮:不是"缺实现",是"缺一次重构"(未提交代码)

按裁决去实现 `ExecutionChannel` 运行体,**结果发现前提再次被推翻 —— 而且这次是好消息**:

> **`RunEngineImpl` 已经存在,而且它就是一个真实的循环拥有者。**

实测确认:

| 事实 | 证据 |
| --- | --- |
| `packages/agent-runtime` **从不** import `@duya/agent` | 全包搜索 `from '@duya/agent'` **零命中**;跨包只有 `@duya/agent-protocol` 与 `@duya/agent-core` |
| 它**已经有完整循环** | `run-engine.ts:355` `for (let turn = 1; ; turn++)`、`:619` `ports.model.stream`、`:1014` `ports.tools.dispatch`、`:1086` `ports.tools.drain` —— 正是 `ports.ts:26-31` 点名的四个决策点 |
| 端口已绑定 | `buildEnginePorts`(`run-engine-ports.ts:264`)绑定 model/tools/context/approval/events/sideEffects |
| `workerImplementsExecutionChannel()` 返回 false | 那是**名字检查**,不是实质 —— 实质已经在了 |

**所以"实现 `ExecutionChannel`"这件事已经做完了。剩下的不是造实现,是把遗留循环改写成端口调用。**

### 剩余工作的精确尺寸(实测)

- 循环体 `DuyaAgent.ts:1825-3300` ≈ **1475 行**
- 循环内有 **36** 个 `this.<member>` 协作者(压缩协调器、timeline/持久化写、`llmClient`、模式协调器、mailbox claim、fork turn、视觉分析……)
- 循环内有 **16** 处压缩调用点(`ports.ts:1048-1053`)
- `TurnOutputPort` 与 `CompactionPort` 被声明为**可选,正因为遗留循环仍在做这些副作用**;在遗留循环停手之前绑定它们,每个副作用会**做两遍**(`ports.ts:1019-1053`)。**切换是全有或全无。**
- **11** 行 drain-carryover 必须同批落地(`agent-process-entry.ts:3040-3042`)

代码里的注释与这个结论完全一致(`agent-process-entry.ts:3038-3046`):
> "That change is a REFACTOR of `DuyaAgent.streamChat` -- its body has to become port calls,
> because `packages/agent-runtime` may not import `packages/agent` -- and it is the whole of
> the remaining cutover."

### 这个尝试已经失败过一次

入口此前对每次 `chat:start` 跑 `RunEngineImpl`,结果被作为 phantom run 移除
(`agent-process-entry.ts:2989-3008`);`headless-run-host.ts:22-26` 是那次假绿的记录。
**所以这不是"没人试过",是"试过、失败了、原因已记录"。**

### 未提交任何代码

树干净在 `fbc055d7`。没有动 baseline、没有动 `scripts/architecture/`、没有碰共享检出。

### 行为证据的一个诚实缺口

`packages/agent-runtime/test/run-engine-loop.test.ts`(20 例)确实覆盖了引擎自己的循环与多轮,
但**它证明的是引擎的循环,不是产品的轮次** —— 产品轮次仍是 `DuyaAgent.streamChat`。
**今天全仓库没有任何测试跑过一次真实的多轮工具报错轮次。** 这是切换前最该补的东西。

### A3 的未决(需要裁决)

| 问题 | 为什么必须先答 |
| --- | --- |
| 遗留循环的改写是**一个原子切片**,还是能分批? | `turnOutput` 与 `compaction` 在遗留循环停手前不能绑定 —— `ports.ts:1019-1053` 明说会**每个副作用做两遍**。分批保证重复执行,所以这是全有或全无 |
| 切换前要不要先补**真实多轮 + 工具报错**的测试? | 今天的测试证明的是**引擎的循环,不是产品的轮次**;产品轮次仍走 `DuyaAgent.streamChat`,全仓库没有一次真实轮次的覆盖。上一轮失败(phantom run)的教训是:门禁能绿而行为已经变了 |
| 失败兜底:若这次改写仍失败,退回哪条路? | 引擎已经存在且干净,所以**不需要**子进程边界了 —— 那是"没有引擎"时的退路 |

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

---

## 2026-10-06 — 数字更正轮(纯文档,零代码改动)

> 起因:A3 的勘察发现本系列若干数字**复现不出来**。本轮把每个数字重新测一遍,
> 错的改掉,并记下「原值 → 现值 → 怎么测的」。
> **工作基线 `205a4cd4`(A1 合并点)。本轮不跑 npm install、不改代码、不改 `scripts/`。**

### 更正清单

| # | 原值 | 现值 | 怎么测的 |
| --- | --- | --- | --- |
| 1 | `ai` 95 文件 / 1 碰 Node;`plugin-core` 44 / 5 | **不变**(复核通过) | 见下方「§0 复核:两个计数是对的,但数法要写清」 |
| 2 | `conductor` 102 文件 | **118** | `*.ts` 66 + `*.tsx` 52 |
| 3 | `ToolExecutionPipeline` 在 `DuyaAgent.ts:2036` / `:2037` | **`:2067`**(唯一构造);`:76` 是值 import | `Select-String 'ToolExecutionPipeline'` → 仅 `:76`、`:2067` |
| 4 | `DuyaAgent.ts` 5011 行 / 255 KB(两处不一致) | **5295 行 / 255371 字节** | `Get-Content .Count` + `Get-Item .Length` |
| 5 | S2 两文件「在 master」 | 在 **`packages/agent/src/process/`**:729 行/36122 B、556 行/26986 B | 目录列举;`git log --all --diff-filter=A` 确认从未在 `agent-runtime/src/engine/` 下存在过 |
| 6 | A2 完成标志「375 条无新增」 | 自相矛盾 → 改为「370 → 375 且 5 条全 declared」 | `architecture-policy.yaml:1182`(`205a4cd4` = 370;`origin/master` = 375) |
| 7 | A1「进行中、未合并」 | **已合并**(PR #219 / `908b5baf` / `205a4cd4`) | `git log --oneline` |
| 8 | A3 = 搬 `ToolExecutionPipeline` | 错 → 必须让 `isTurnLoopModule(DuyaAgent.ts)` 变 false | 去注释后逐子句:`DuyaAgent.ts` 3/3,删掉 pipeline 仍 2/3 |
| 9 | A3 风险清单 | 新增 `discarded` 一次性闩 | `StreamingToolExecutor.ts:479`/`:481`/`:758`/`:729-732`;`discard()` 在 `DuyaAgent.ts:2407`/`:2746`/`:3368` |

### 最重要的一条:`ports.ts` 的「已知过读」是假的

`boundary-gates.mjs:265-268` 的代码注释声称 `agent-runtime/src/engine/ports.ts`
「带 (a)(c) 又点了缝的名字,因此被报出来」。**实测:`rep=false, model=true, tool=false`
= 1/3,`isTurnLoopModule` 为 false —— 它今天不发出任何 finding,这条过读是休眠的。**
它的原始正则命中全在注释里(`:453` 的 `StreamingToolExecutor.getRemainingResults` 就在 JSDoc 中),
`stripComments` 之后就没了。

**所以 A1 §4 那个未决问题的答案是「真违规」,不是「已知过读」。**
**本轮不修改该文件**(不归本切片所有),只在此记录:那段注释现在已知是错的。

### 顺带记一条纪律:数法本身会造假

本轮有一处指控是「`ai` 碰 Node 的文件数应为 3,`plugin-core` 应为 2」。**复核后两个都错,
但错的是数法,不是原文**:

- 只认 `node:` 前缀 → 漏掉裸 `fs`/`path` → `plugin-core` 少算 3 个。
- 不去注释 → 把注释里提到 `node:crypto` 的文件算进去 → `ai` 多算 2 个
  (`auth/oauth/*` 用的是 Web Crypto 全局 `crypto.getRandomValues` / `crypto.subtle.digest`)。

**口径固定为:去注释 + 统计真实 import/`require` specifier + `node:` 与裸名都算。**
原文的 `ai`=1 / `plugin-core`=5 在这个口径下是对的。
**一个数对不上,先怀疑数法,再怀疑原文** —— 但两种情况都必须留下「怎么数的」,否则下次还会对不上。

### A2 合并时带出的 TS2393(本系列主题的一个标本)

A2 已合并为 **PR #222**(`a046cdf6`,分支 `plan/610-a2-merge-214`)。它同时修掉一个缺陷:

**#214 的 `a7193092` 给 `RunEventEmitter` 追加了一个逐字节相同的第二个 `async publish`。**
怎么定位的:该 commit 的 diff 只动了 `packages/agent-runtime/src/events/event-emitter.ts`(+39 行),
其中 `:643` 是新增的 `async publish(event: RunEvent): Promise<EmitResult>`,
与既有的 `:344` 完全重复 —— TypeScript 报 **`TS2393`**。

**关键在于:`architecture:check` 是绿的,vitest 也是绿的,只有 `typecheck:all` 红。**
一个检查不到任何东西的门禁照样报绿 —— 这正是本系列 §4 第 4 条说的病,
也正是 `typecheck:all` 必须在提交前跑的原因。修在 `70f3a85e`。
**修完的证据:`git diff 205a4cd4 origin/master -- <event-emitter.ts>` 为空 —— 该文件与 A2 之前逐字节相同。**

### 本轮没能测、因此没写进基线的东西

- **`npm run architecture:check` 的「无新增」在无 `node_modules` 的检出上测不出来。**
  `core-io` 扫描会报 `vite-node not found` 并自造一条未基线化 finding
  (本次在 `205a4cd4` 上:total 931 / tolerated 930 / new 1,new 的就是这条环境产物)。
  **门禁数字离开自己的工具链就没有意义。**
- **vitest 一次都没跑。** 纯文档轮,不装依赖。
  因此 `boundary-gates.test.ts` 那两条红的**成因是读源码 + 直接跑门禁定出来的,不是跑出来的**,
  引用时保留这个区别。

### 仍然未决

- **`the live tree is fully baselined` 这条红要等 A3。** 它现在红,正是因为 G7 有了那条真 finding;
  **它转绿就是 A3 的成功信号**,不许用 `--write` 提前转绿。
- **`boundary-gates.test.ts:294` 的行号钉死**(断言 75,现测 76)是 `be766fde` 之后的漂移,与 A1 无关。
- **603/602(C1)** 与 **`apps/web` 是否立项**(B2)照旧未决。

---

## 2026-10-07 — A3 翻转:17 个前置切片(分支 `plan/610-final-flip`)

PR #250–#258 已合入 `master @ 7a3e77d7`。翻转工作在分支 `plan/610-final-flip`,
worktree `E:\Projects\duya\.claude\worktrees\610-final-flip`(junction 复用 `node_modules`,
**留在原地,禁止 `git worktree remove`**,带不带 `--force` 都不行 —— 会跟随 junction 删掉主检出的
`node_modules` 与各包 `dist`,本项目已真实发生过两次)。

### 已落地的前置切片

| 切片 | commit | 内容 |
| --- | --- | --- |
| S3 | `e3df4a9f` | 正向证明:真 `duyaAgent` + `RunEngineImpl`,两轮两腿均被调用 |
| S4a | `1164565e` | hook 表面:`on_start` / `after_finalize` + `hook-source.ts` |
| S4b-1 | `91a07677` | `applyTurnModes` |
| S4b-2 | `10de6b33` | `_projectModelMessages` 投影 |
| S4b-3 | `3746a3f2` | 采纳:6/7 phase 采纳 `#contribute` |
| S4b-4 | `08778183` | anti-dead-loop 硬停(`RepeatedCallStreak` + `RepeatedCallStopPolicy`) |
| S4b-5 | `131613ca` / `18f9ee64` | loop-bus 事实测定 + `ports.ts` 陈旧注释修正 |
| S4b-6 | `23e21523` | fork/reply 诊断证明(通道活,但没喂输入) |
| S4b-6b | `2c46ead0` | fork marker public 接缝 + per-run 重置 |
| S4b-6c | `5bd4132a` | 修 turn-2 投影饥饿(fork run 丢自己的 tool result) |
| S4b-7 | `2b70c640` | 控制命令(零模型调用) |
| S4b-8 | `d528b2b4` / `3b1abb70` | 控制动词表测试 + `before_commit` phase |
| S4c-a | `bef7f1c8` | 关掉已测缺口(`after_finalize` 动作断言、`ModeExitPort`、特征化重指向) |
| S4c-b1…b3 | `f8db0faa`…`5090a0cc` | 裁决 4 个矛盾 premise;`progress_update`、中止对齐、端口变必需;`SessionEnd` 两个相反决策;实测驱动面 72 测试 / 14 文件 |
| S4c-c | `42d4d5fd` | 生产接线层:`createRunEventSpine` + `WorkerAdapterSurface` 实现 |

### 一条必须写下来的判断错误

**前 11 个切片每一个都证明了「引擎能做」,没有一个证明「生产在用」。** 我曾用前者当作后者安全的依据。
这是实质判断错误,不是措辞问题。S4c-b4 的 worker 实测发现生产接线层**整层不存在**,
**拒绝实现并上报** —— 那是正确结果,不是失职。

### 主 agent 亲自做的变异(共 8 个,每个都挑 worker 没做的方向)

run-scoped streak 改 per-turn → `2 failed / 5 passed`;去掉 fork 守卫 → `4 failed / 4 passed`;
streak 限制在 `after_tool` phase → `2 failed / 6 passed`;抽掉遗留 per-run 重置 → `1 failed / 9 passed`;
`isRunOwnBranchRow` 丢 id 比对 → `3 failed / 9 passed`;循环 `turn = 1` → `0` 验守卫正则 → `1 failed / 11 passed`;
遗留 `PreFinalize` 总线加 `inject` → 命中 parity 测试。

**第 7 个变异保持绿,并因此发现了一个真测试缺口**(已由 S4c-a 修):把 `after_finalize` 的贡献改成
采纳到 `deferred.current`,测试**仍然全绿**。原因是该测试断言的是「不在 transcript」(结果),
而不是「未被采纳」(行为),而两者当前恰好重合。已改为断言 `ports.context.defer` 不被调用,
并加对照测试证明那个 tap 是活的。

### D3 裁决:`result` 用量路由(选项 **B'**,不是 worker 推荐的 B)

worker 上报的三条事实,主 agent 已逐条独立复核,全部成立:引擎 `assistant.usage` 每轮一次且 last-wins;
入口按每次 LLM API 调用记账并**实时读** `agent?.model`;`ctx.model` 在 run 开始从 manifest 冻结。

**但根因比上报的更精确,不是「两个权威之争」,而是「收窄处丢字段」。**

| 环节 | 事实 |
| --- | --- |
| provider | `packages/ai/src/api/*.ts` 每次 LLM 调用 yield 一个 `{ type: 'result', data: TokenUsage }`,**带 cache 桶** |
| 遗留 | `DuyaAgent` 原样透传,入口的 `result` 记账块(**每次调用**求和 + 逐次 `calls[]` + 实时 `agent?.model` 归因)今天完全正确 |
| 引擎 | `ModelFrame.usage`(`packages/agent-runtime/src/engine/ports.ts` 的 `ModelFrame` 联合)只有 `inputTokens` / `outputTokens` / `totalTokens` —— **没有 cache 字段** |
| 收窄点 | `toModelFrame(event: SSEEvent): ModelFrame | null`,`packages/agent/src/process/run-engine-model.ts` —— **cache 桶就是在这里丢的** |
| 消费 | `run-engine.ts` 的 `case 'usage':` 交给 `addUsage`,last-wins 覆盖 |

所以丢的是**两样东西**:粒度(只剩最后一次调用)与 cache 桶(在收窄处丢失,下游无法恢复)。

**裁决:**

- **保持逐次调用记账与逐次归因。** 接受轮级归因被否 —— 那会让整个轮次记到 run 开始时冻结的模型上,
  轮中热切换就记错账。
- **入口保持唯一归因权威。** 不引入逐调用 `ctx.model` 解析器,不把模型标记搬进引擎,
  不在引擎里另造一份 `calls` 形状的账本 —— 引擎今天没有逐调用模型的诚实来源,宿主才有(宿主掌握热切换面)。
- **入口的记账块不需要行为改动。**

被否的选项:**(A) 保留遗留 `result` 通道** —— 不可能,它的生产者是正要被删的那个循环。
**(C) 轮级归因** —— 记错账。**(B) 原案**(引擎发布逐调用 ledger)—— 需要逐调用 `ctx.model` 解析器
**加** projector 改动,且是从引擎没有诚实来源的地方**发明**一份账本:同样的数据,更多机制。

机制(宿主侧 `createClientModelPort` 透传,还是收窄后转发)交由 S4c-d1 实测后定。

### 本轮实测门禁

- `architecture:check` 在 `42d4d5fd`:`1009/1009 tolerated, 0 blocking`;self-test cross-boundary edges `832`
- `mutation-proof-a1`:`7/7`
- 边界门禁:G1 `known 0, new 0, stale 0`;G3 `known 0, new 0, stale 0`;G4 `known 2, new 0, stale 0`;
  G6 `known 9, new 0, stale 0`;**G7 `known 0, new 1, stale 0`**(预期稳态,就是 A3 要转绿的那面红旗);
  G8 `known 1, new 0, stale 0`;G9 `known 5, new 0, stale 1`(既有 stale)
- `packages/agent-runtime`:`711/711 in 59 files`(必须单独跑,本机并发下会 flaky)
- `packages/agent/src/process`:`398/398 in 35 files`
- `npm run typecheck:all`:exit 0

**既有失败(不是本系列造成的,不要顺手修):**
`packages/agent/tests/unit/agent` `181/190 in 23 files`(9 个既有失败);
`packages/agent/tests/integration` `35/36 in 4 files`(1 个既有失败,隔离下稳定,非超时)。

**根 `npm test` 不是可用门禁** —— 同一 pristine HEAD 两次跑出 17–19 个失败文件。
`npx vitest run packages/agent` 是**子串过滤**,不是基线。

### 仍然未决

- **翻转本体尚未开始。** `agent-process-entry.ts` 仍有 1 处 `agent.streamChat(` 调用,`DuyaAgent.ts`
  的遗留轮次循环仍在,G7 仍红。
- **翻转还缺的生产接线**(实测宿主侧义务为 0):`composeLegacyRunPorts` 的生产调用方、
  `beginTicket` / `settleTicket` / `turnOutputSink` / `deferFragment` 的宿主生产者。
- **网络仍断**(需用户在机器上重启代理客户端):`gh api rate_limit` 持续 EOF,
  所有 HTTPS 失败。32 个 commit 已在本地,**未推送**。恢复后先 probe 再推,绝不盲推。

---

## 2026-10-07 — S4c-d1 落地;S4c-d2 第二次被拒:翻转是**三个宿主**,不是一个

### d1(逐调用用量路由)已落地并复核

`2388da9e feat(agent): route per-call token usage to the billing authority`。
机制:**宿主侧 tap**,不是引擎侧 ledger。`createClientModelPort` 新增可选的
`onPerCallUsage`,在生成器循环内、**`toModelFrame` 收窄之前**拦下每个 provider `result` 帧原样交给宿主。
engine 侧零改动(`ModelFrame` / `RunEvent` / 事件注册表都没碰)。

主 agent 独立复核:`architecture:check` `1011/1011 tolerated, 0 blocking`;新测试 `6/6`;
commit 落地、树干净、G7 仍 `known 0, new 1, stale 0`。**主 agent 自做变异**:
删掉 `event.type === 'result'` 类型守卫 → `1 failed / 5 passed`,完全回退后 `6/6` 绿、树干净。

**worker 抓到了 briefing 的一个真错误**:我写「provider `TokenUsage` 带 `cache_read_tokens`」,
实测该名字在 `packages/ai` 里**零命中**;真实字段是 `cache_hit_tokens`,
`cache_read_input_tokens` 是 **Anthropic wire 名**,adapter 会归一化掉。
**我读了消费路径,没读类型声明 —— 验证了路径不等于验证了字段名。**

### d2 被拒,且拒绝是对的:翻转的对象不是入口,是**三个宿主**

worker **没有提交任何东西**,树干净停在 `2388da9e`。它给出的阻塞事实,主 agent 已独立复核:

**遗留轮次循环是三个生产调用点的唯一驱动,不是入口一个:**

| 调用点 | 它驱动的路径 |
| --- | --- |
| `process/agent-process-entry.ts` | `chat:start`(本次分配的 scope) |
| `process/headless-run-host.ts`(`createAgentExecutionChannel`) | CLI 的 headless 运行 |
| `tool/SubagentTool/runAgent.ts` | 子代理工具执行 |

复核方式:扫 `packages/agent/src` 全部 `.ts`,排除 `__tests__`,再按接收者剔除 provider 接缝
(`llmClient` / `client` / `visionClient` / `activeClient` / `deps.llmClient` /
`sources.llmClient` / `this`)。剩下的 `DuyaAgent.streamChat(` 正好三处。
(`cli/index.ts` 另有两处命中,但两处都在**注释**里 —— 那是 H8.1 改动的说明文字,不是调用。)

**「先删循环」在没有翻转全部三个宿主之前,会让其中两个路径一个驱动都没有** —— 正是 briefing
禁止的那个顺序。所以 d2 不能按原 scope 落地。

**次级阻塞,独立于上面那条**:入口无法忠实绑定 `beginTicket` / `settleTicket`。
入口没有 `runEpoch`,也没有 `RunFence`;runtime 侧唯一的 fence 生产者是 `recoverRun`,
它为 **epoch+1 的恢复**铸造 fence,并要求已有 committed checkpoint。
**首次尝试没有 committed state 可言 staleness,因此不存在一个诚实的 epoch-0 fence 可绑。**
现有全部供给者都在伪造 `FIRST_EPOCH` 和 `GROUND_FENCE`。绑一个假 fence 正是 briefing 警告的 stub。

### worker 的因果探针(值得单独记一笔)

它没有制造一个绿灯来证明自己,而是**证明了它所依赖的因果断言**,然后完全回退:
把循环体里两条 `for await` 腿中的**模型腿**头改成 `for`(纯空白改动,语义上惰性,只改扫描面),
**G7 从 `new 1` 变成 `new 0`,状态从 `NEW` 翻成 `BASELINED`** —— 之后完全回退,G7 复原。

这正是 `CUTOVER-BOUNDARY.md` 记载的**假绿**:G7 可以靠「让判据看不见循环」变绿,
而不是靠「循环真的没了」。worker 明确表示**不采用这条路**,只用它确立因果。
这条与既有的「门禁形状判据对重构不瞎」互为镜像:那次证明判据禁得住重构,这次证明判据**能被绕过**。

### 三片序列(据此重排)

删除循环只能在三个宿主都翻转之后进行,所以:

| 片 | 内容 | 循环 | G7 |
| --- | --- | --- | --- |
| **d2a** | 入口改由引擎驱动 | 保留(headless/subagent 仍用它) | 仍红 |
| **d2b** | headless 宿主改由引擎驱动 | 保留(subagent 仍用它) | 仍红 |
| **d2c** | 子代理改由引擎驱动 + **删循环** | 删除 | **转绿** |

每片都安全:任何时刻至少一个宿主仍驱动循环,不存在「零驱动」窗口。
parity 测试在整个过程中保持双边有效。

### 另一条被实测推翻的记载

`packages/agent/tests/unit/agent` 的既有失败是 **10 failed / 358 passed**(37 文件),
不是此前记录的 `181/190 in 23 files` / 9 failed —— 后者是**子串过滤**跑法,
会额外扫进 `unit/AgentTool/`。两次跑的 scope 不同,数字不可互换引用。

---

## 2026-10-07 — S4c-d2a 第三次被拒:三条**静默失败**型前置缺口

worker 同样**零提交**,树干净停在 `bbcd9127`。它造了一个四臂探针(真 `duyaAgent`、
已注册探针工具、脚本化 provider,数**真实工具执行次数**),主 agent 逐条独立复核,
三条全部成立。

| 臂 | 账本 | declared-tools 刷新 | 历史 | 工具执行 | 终态 | turn-2 角色 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 无 | 无 | inline | **0** | **`failed`** | — |
| B | 有 | 有 | `by_ref` | **1** | completed | `user,assistant,tool,user` |
| C | 有 | 有 | **inline** | 1 | completed | **`["user"]`** |
| D | 有 | **无** | `by_ref` | **0** | completed | `user,assistant,tool,user` |

### 缺口一:副作用账本是**强制的**,却无法诚实绑定

`RunEngineImpl.#ticket`:无账本时,**任何非 `read_only` 的调用直接 `throw`**
——「不是假设没有副作用工具,而是无副作用工具才可派发」。

而 `composeLegacyRunSources` 的 `sideEffectOf: () => null`,经 `resolveSideEffectClass`
把**每个**工具解析成 `undeclared`(非 `read_only`)。根因是 `ToolMetaInput` 没有
`sideEffect` 成员,产品里**没有任何工具声明过类别**。

**所以账本绑定不是可选优化,是工具腿能跑的前提。** 而绑定它需要 `runEpoch` 与 `RunFence`:
`chat:start` 两者都没有,runtime 侧唯一的 fence 生产者 `recoverRun` 要求已有 committed
checkpoint,首次尝试没有。现有供给者全在伪造 `FIRST_EPOCH` + `GROUND_FENCE`。

**诚实解法只有两条路:** (a) Control Plane 在 `chat:start` 上送来 `runEpoch` 与初始
`RunFence`(它现在只送 `runId`,且 `runId` 还是可选的);或 (b) 在 `@duya/agent-protocol`
里加一个**首次尝试 fence 生产者**,由协议自己定义 epoch 1,而不是由调用方断言。

### 缺口二:`buildLegacyRunInput` 发的是 inline 历史,turn 2 会饿死

它发 `history: { kind: 'inline', value: history }`,而**同一函数**的 `catalog` 却是 `by_ref`
——函数的注释只解释了后者,没解释这个不对称。引擎对 inline 读 `input.history.value`,
那份值在 run 开始就冻结;只有 `by_ref` 才回落到 `assembled.messages`。
臂 C 实测:工具跑了、run `completed`、turn-2 的请求里 **tool result 不存在**。
现有全部证明性 harness 都把它覆盖成 `by_ref`,所以这个缺口此前对测试**不可见**。

### 缺口三:declared-tools 守卫在引擎路径上永远是空的

`declaredToolsForRequest` 初始为 `new Set<string>()`,由 `TurnStreamRunner` 每次尝试调
`refreshDeclaredTools` 填充。引擎路径的 `createClientModelPort` **从不调它**,
守卫保持空集 → **每一次工具派发都被拒**(臂 D:工具执行 0 次,而 run 仍报 `completed`)。

`turn-pipeline-producer.test.ts` 的注释早就写明了这个陷阱:「守卫以**空集**开始并拒绝
它之外的任何工具,所以跳过刷新的测试会看到每次调用都是 `tool_error`,
并且可能因为**从未派发任何东西**而『通过』一个静音管道的断言」。

### 为什么这三条比红门禁更严重

**它们全是静默失败**:run 正常完成、门禁全绿、但工具一个没执行、tool result 不上线。
一个「跑完了但什么都没干」的产品,比一条红门禁危险得多 ——
红门禁会拦住 push,这三条不会。

### 因此 d2a 不能开工,先补三片前置

| 前置 | 内容 | 跨层? |
| --- | --- | --- |
| **P1** | 诚实的首次尝试 fence(账本才能绑定) | **是** —— 要动 Control Plane 契约或协议 |
| **P2** | `buildLegacyRunInput` 的历史改 `by_ref` | 否 |
| **P3** | 引擎模型腿接上 `refreshDeclaredTools` | 否 |

三片都不大,但都必须先有**证明它们真的修好了上述行为**的测试 ——
现有 harness 会覆盖掉缺口二,所以必须造一个不覆盖的生产形状探针。

