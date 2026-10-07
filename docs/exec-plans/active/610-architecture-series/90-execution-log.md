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

---

## 2026-10-07 — P1 / P2 / P3 三片前置全部落地

**这一轮两个 worker 都没有拒绝执行** —— P1 与 P2+P3 各自独立验证了全部前提,没有找到假命题。

| 片 | commit | 内容 |
| --- | --- | --- |
| **P2** | `bd8af689` | `buildLegacyRunInput` 的历史改 `by_ref`(digest 为 `sha256Hex(canonicalJson(rows))`,走协议自己的哈希) |
| **P3** | `99b7ae2e` | `createClientModelPort.stream()` 的**第一条语句**调 `refreshDeclaredTools`,`LegacyRunHost.refreshDeclaredTools` 设为**必需**(可选正是它当初静默的原因) |
| **P1** | `3b6eeeb8` | `firstAttemptFence` —— `@duya/agent-protocol` 里的首次尝试 fence 生产者 |

### P1 的裁决依据来自仓库自己

`AttemptLeasePort` 的文档(`packages/agent-runtime/src/engine/ports.ts`)早已写明:
「在别处铸造 fence —— **包括在 Control Plane 上、放进 manifest** —— 会构成第二个权威,
而真正重要的那个权威是**拒绝写入**的那个」。

所以 (a)「Control Plane 送来 fence」正是仓库自己点名的那个被禁方案。选了 (b):
`firstAttemptFence({ runId, state })`,其中 `state` 是一个**调用方必须从持久存储里查出来的答案**,
不是一个它可以断言的值:`{ committed: false } | { committed: true; committedFence: number }`。
`committed: true` 直接 **throw**,并点名它拒绝复制的那个 fence。

epoch 取 `FIRST_EPOCH` 而非 0,因为 `RunEpoch` 从 1 起算且 `encodeReplayCursor` 拒绝更小的值 ——
一个携带 epoch 0 的 fence 无法出现在任何 cursor 里,它的 attempt 也就永远无法与别的 run 区分。

### 主 agent 独立复核

三个证明文件 `5 passed (3)`,架构门禁 `1023/1023 tolerated, 0 new blocking`,
`packages/agent/src/process` `409/409 in 39 files`。三个 worker 并发写进同一棵树,
整合态由主 agent 亲自跑过。

### 主 agent 自做变异:一个**保持绿**的变异,及其正确解读

把 `firstAttemptFence` 返回的 token 从 `GROUND_FENCE.token` 改成 `+99` ——
**测试保持 3/3 绿**。

**这不是测试空转,而是测出了保证的精确边界。** 下游**没有任何东西校验 fence 的 token 值**。
真正的保证是**铸造被门禁**:你无法为「不在首次尝试」的 run 拿到首次尝试 fence,
因为生产者在 `committed: true` 上会抛。这条是承重的(worker 的 `if (false && …)` 变异 → `1 failed / 2 passed`)。

而对于一次**真正**的首次尝试(没有任何 committed state 可冲突),任何 token 按定义都是 current
—— `isFenceCurrent` 比的是 `incoming.token >= highest`,而此时 highest 为 0。
所以我的变异在语义上是**惰性**的,不是它本该变红而没红。

**该记的教训:「诚实的 fence」保证的是「不能凭空铸造」,不是「fence 会被校验」。**
这两个是不同的性质,写下来时不要混用。

### 下一步

P1–P3 就位,重试 **d2a**(入口改由引擎驱动,不删循环,G7 预期仍红),
之后 d2b(headless)、d2c(子代理 + 删循环,G7 转绿)。

P1 自己划的范围限制已记录在案:它让诚实的 fence **变得可用**,
但**没有**把 worker 入口接到账本上 —— 那个绑定需要 Control Plane 的 `runId`,
属于翻转切片本身。另外 `SqliteCheckpointStore` 在树里只以注释存在(`checkpoint-store.ts:95`),
没有那个类;所以生产者 `state` 参数正是将来真实存储要回答的那道缝。

---

## 2026-10-07 — d2a 重试第四次被拒:第五条缺口,**运行生命周期仍私有**

P1–P3 四条前提**全部为真**(worker 逐条对照源码确认),但它发现了一条 briefing 未列的前提为假:
**`composeLegacyRunPorts` + spine + surface 一旦有了 turn handle 就足够驱动入口 ——
而没有任何生产路径能不写私有字段就拿到那个 handle。**

### 实测(不是推断)

`assembleTurn` → `buildTurnPipeline` 在 `abortController` 为空时 **throw**:

```ts
const abortController = this.abortController;
if (!abortController) {
  throw new Error('buildTurnPipeline called with no run in progress: the abort controller has already been cleared');
}
```

而 `abortController` 是 `private abortController: AbortController | null = null`,
**只在 `streamChat` 里被赋值与清除**,没有 setter。那段 throw 的注释自己说明了为什么不能给默认值:
「悄悄替换成一个新 controller 会造出一个调用方无法 abort 的 tool-use context」。

worker 用一次性探针实测两臂:**无 cast → throw**;**有 cast → 3 个工具跑通**。
现有 **14 个**驱动引擎的 harness 全部用私有字段 cast 绕开,
其中 `turn-assembly-seam.test.ts` 直接把那个 cast 称作「the honest boundary」。

### 第四条:`streamChat` 的序言还有四件事引擎路径够不着

`_resolveAgentProfile`、`_dispatchOrchestratorMode`(`run-engine.ts` 里**根本没有** orchestrator 概念)、
`promptContexts` 轨道(skills / plugins / mentions —— `hook-source` **按设计丢弃** context)、
以及 `currentTurnId`。

**所以「翻转」不是换驱动,是从生成器里把运行生命周期抽成一个公开接缝。**
直接翻的结果只有两种:入口的每一轮都 throw,或者静默丢掉
skill/plugin/mention 注入、agent profile、orchestrator 模式和 turn id ——
**两者都是本系列要防的那类静默失败。**

### 因此新增前置片:`beginRun` 公开接缝

在 `duyaAgent` 上开一个 `beginRun`,接管 `streamChat` 序言所拥有的东西
(abort controller、profile、turn id、prompt-context 轨道、orchestrator 派发),
返回 handle 加一个 close。这是**一个方法**,做完入口的翻转才诚实。

先例就在这个仓库里:#236 加的 public 接缝 `claimInterTurn`,它旁边的注释写着
「PUBLIC, and it is the whole reason `_sweepInterTurn` exists」。

---

## 2026-10-07 — P4 公开运行生命周期接缝落地;并顺带修掉一个真泄漏

`beb6d18f`(先放松一条按文本钉死的测试)+ `287259e3`(接缝本身)。

`duyaAgent.beginRun(request): Promise<RunHandle>`。handle 暴露
`turnId` / `turnContext` / `appliedProfile` / `requestedMode` / `orchestrator` /
`signal` / `controller` / `abort()` / `close()`。
**是一个方法,不是字段也不是 setter** —— run 必须拥有 controller;`abortController`
保持 `private`,文件里只剩两处写入(安装、释放)。

遗留循环**调用** `beginRun`,所以只有一份实现,不是两个答案。

### worker 又推翻一条我的子前提,而且翻出的是个真缺陷

我说「`abortController` 在 `streamChat` 里被赋值**与清除**」。实测:**只有一处赋值,
从不清除**(`HEAD~2` 的 `DuyaAgent.ts` 里唯一写入是 `:2449`,另三处命中全是读取或无关局部变量)。

两个后果:
1. `buildTurnPipeline` 那句「the abort controller has already been cleared」
   描述的是**当前树到不了的状态** —— 这条 throw 有一半是死代码。
2. 长生命周期 agent 上,**run 的控制器泄漏过了生成器**。`close` 现在清它,
   并且带身份检查 —— 一个被取代的 handle 什么也不释放。

### 五项序言职责:三项到达,两项**明确报告为未达**

| 职责 | 到达? |
| --- | --- |
| abort controller | 是,完全拥有 |
| agent profile | 是 —— `appliedProfile` 让驱动把**同一个值**交给 `beginTurnAssembly` |
| turn id | 是 |
| prompt-context 轨道 | **部分** —— 重置与释放已拥有,**生产者是 generator 闭包局部**(`dispatchHooks` 经 `yield*` 到达,composition 无法消费一个 `yield`) |
| orchestrator 派发 | **否** —— 解析可以(注册表查询,`beginRun` 报告),**派发不行**:`_dispatchOrchestratorMode` 是 yield 遗留 SSE 词汇的 async generator,而 `agent-runtime` 的 `ports.ts` 里**零** orchestrator 成员(实测) |

**所以 d2a 仍不能开工**:一个拿到非 null `orchestrator` 的驱动必须拒绝驱动 turn 装配 ——
否则 orchestrator 模式会被静默丢弃,又是那类静默失败。

### 主 agent 独立复核

架构门禁 `1023/1023 tolerated, 0 new blocking`;`run-lifecycle-seam.test.ts` `6/6`;
`packages/agent/src/process` `415/415 in 40 files`;G7 仍 `known 0, new 1, stale 0`。

worker 自己的红证据:同一测试在 `HEAD~2` 上 **6/6 全红**(4 × `agent.beginRun is not a function`)。

### 主 agent 自做变异:一个保持绿的变异,以及它真正的含义

拆掉 `close()` 里的 `this.forkTurn = null` → **415/415 仍绿**。
再加拆掉 `beginRun` 里的那一处 → **1 failed / 414 passed**,红的是
`the marker cannot outlive the run that set it`。

**结论:fork 标记有两道冗余守卫**(run 开始时重置 + 释放时重置),
测试钉的是**不变量**而不是某一行。覆盖是真的。

**这条与先前两次「保持绿」是同一个形状:一个保持绿的变异,在宣布「覆盖的是 X」之前,
必须先问「有没有第二道守卫在补偿它」。** 否则无法区分「被冗余守卫覆盖」与「根本没覆盖」。
P1 的 fence token、`close()` 的身份检查、这次的 fork 标记,三次都是冗余双守。

---

## 2026-10-07 — P5:orchestrator 派发从生成器里搬出来,作为「走哪条腿」的**路由**落地

先答一个必须先答的问题:**orchestrator 模式是第二个驱动,还是现有驱动里的一个分支?**
**实测:是第二个驱动。** 一句话证据 —— `streamChat` 的模式分支
`yield* this.orchestratorFramesFor(run); return;` 在 `beginTurnAssembly` **之前**返回,
那一轮永远到不了 turn 装配,也就到不了 `while` 循环。
`ModeModifierOrchestrator.execute` 自己也这么说:它拿 `llmClient` / `toolRegistry` /
abort controller,「does NOT run through the agent tool loop」。
**所以它不是「引擎 turn 的一个分支」,它是替换掉那个 turn 的另一个驱动。**

### 阻塞点其实只有「private」

P4 的结论说 orchestrator 派发不可达,理由是词汇问题(遗留 SSE)和
`agent-runtime` 的 `ports.ts` 零 orchestrator 成员。**前半句量错了**:
`_dispatchOrchestratorMode` 本来就与生成器帧无关 —— 实测它只读 agent 字段、
解析出的 modifier、prompt 与 options,一样都不读 `streamChat` 的闭包局部。
**唯一的障碍是它是 private。** 所以本片做的是搬运,不是翻译。

`duyaAgent.orchestratorFramesFor(run)`:一个**非** `async *` 的方法,先校验再返回
遗留的 async generator。**刻意不是 generator**:async generator 的函数体要到第一次
`next()` 才执行,「返回一个空流」的驱动看不出任何异常 —— 正是本系列要防的那类静音。
`@throws` 于 `run.orchestrator === null`,那属于调用错误(普通轮必须去装配)。
`RunHandle` 多一个 `request`,派发从**它**读 prompt 与 options:参数由驱动再传一次
就是第二轮输入的第二份账。

`selectRunDriverLeg(agent, run)`(`process/run-composition.ts`)把这个决定**命名一次**:
要么 `{kind:'orchestrator', frames}`,要么 `{kind:'engine'}` —— 没有第三个答案。
是 union 而不是 boolean,因为要防的失败正是「boolean + 驱动忘了的那个分支」。

遗留循环**调用**同一个 `orchestratorFramesFor`,所以模式解析只有一份
(`beginRun` 的注册表读),编排器和引擎驱动不可能对同一轮给出不同的答案。
`_dispatchOrchestratorMode` 的 `abortController` 从 `this.abortController!` 改成
由 handle 传入 —— 那个 `!` 断言的是一个可能被后一轮 `beginRun` 改指的字段。

### 为什么不给引擎一个 orchestrator 端口(方案 A 更差的实测理由)

`ports.ts` 自己写着:它**禁止**引入 `@duya/ai` 的 `SSEEvent`,因为那个 union 的
渲染器那一半(`tool_group_progress` / `agent_progress` / `mode_changed` /
`goal_updated`)正是引擎不许携带的词汇。orchestrator 产出的**就是**这个 union,
而且它按设计取代整个循环。给引擎加一个 orchestrator 端口,要么把渲染器词汇搬进引擎
(它明文禁止),要么丢掉一部分帧。**两条都是静默失败。** 方案 (B) 把帧原样转给遗留
生成器喂过的同一个消费者,行为逐帧不变。

### 附带测出的一件事:**目前没有任何生产模式声明 `orchestrator`**

`modes/index.ts` 注册 6 个模式,全部是 modifier 范式;`research-mode.ts` 的文件头
自己写着「It does NOT take over the stream」。所以 `streamChat` 的 orchestrator 分支
**在生产里当前不可达**。能力是真的(注册表 API 是 plan 224 的),分支是未执行的 ——
这恰恰是路由不能交给每个驱动自行决定的理由。

### 与 prompt-context 轨道生产者的关系:**可分离**

orchestrator 派发读的是 agent 字段 + 模式 + prompt + options;它**从不**读
`promptContexts`(实测)。轨道的生产者是另一类东西 —— hook context 经 `dispatchHooks`
这个被 `yield*` 到达的闭包局部到达,skill/plugin/mention 是模块级。两者机制不同、
根因不同(前者是「引擎没有帧汇」,后者是「合成消费不了一个 yield」),**共享的只有
「都在序言里、都还没抬出生成器」这一层位置**。可以并行推进,不必合并。

### 删掉遗留循环的那一版,现在**允许**假设什么

1. **不能再假设「入口只命名一个驱动」。** orchestrator 轮今天走的就是
   `agent.streamChat(` —— 方案 (B) 保留它。翻转之后入口仍然要保留这**一次**
   `agent.streamChat(` 调用(当且仅当 `selectRunDriverLeg` 判为 orchestrator 时),
   或者把同样的 `yield*` 留在原地。`live-turn-single-driver.test.ts` 里
   `legacyDrivers + engineDrivers === 1` **必须保留** —— 它防的是「一个驱动都没有」,
   而不是「遗留字样为零」。诚实表述是:**入口始终有一个驱动;翻转改变的是哪一类轮走哪一条腿。**
2. **不能再假设删掉 `streamChat` 就等于删掉 orchestrator。** `_dispatchOrchestratorMode`
   与它的产出词汇必须另有归属(`orchestratorFramesFor` 现在是那个归属),
   否则被删掉的是一整个产品能力。
3. **不能再假设 turn 装配对每一轮都可达。** 编排器轮明确不可达,而且这是**设计**,
   不是缺陷。

### 门禁与变异

架构门禁 `1023/1023 tolerated, 0 new blocking`;G7 状态行 `G7 NEW`、计数行
`known: 0   new: 1   stale: 0`(与 P4 相同,不是本片动的);
`orchestrator-run-leg.test.ts` `5/5`;`packages/agent/src/process` 见下。

worker 的红证据:同一测试在**只有测试、没有生产改动**的树上 `5/5 全红`
(4 × `selectRunDriverLeg is not a function`,1 × `agent.orchestratorFramesFor is not a function`)。

变异方向(**前面几片都没测过的**:路由决策本身):把 `selectRunDriverLeg` 的
`if (run.orchestrator)` 改成 `if (false && run.orchestrator)` —— 也就是
「拿到编排器轮却去装配 turn」这个本片要防的静默失败本身 ——
**3 failed / 5 passed**,红的三个分属三个不同的 block
(路由腿、abort 腿、遗留对拍腿),不是同一处断言的重复。
剩下的两个(拒绝、引擎腿)按设计就该绿:它们不碰编排器腿。

### 一个顺手被门禁抓住的账

`legacy-driver-surface.test.ts` 红了 —— 它普查「哪些测试驱动遗留循环」,
而本片的对拍块**真的**调了一次 `agent.streamChat(`。已按实测更新
(新增一行 `[5, 1]`,72 → 73)。这不是放宽:普查的职责就是让驱动面不能静默漂移,
而这一行正是翻转之后不能迁移的那一类。
---

## 2026-10-07 — A0 结案;§3.2 判定不需要;A5 五项决策书

### A0 已完成并合入 master

`§3.1`(`@duya/ai` 的 WebCrypto,`7f45d418`)、`§3.3`(`conductor` 的 `./renderer` + `./renderer/*`,`456bfffa`)、门禁 **G10**(`scripts/architecture/browser-closure-gate.mjs`,实测 `PASS 0/789`)都已落地。
**「A0 一片都没开始」是错的** —— 切片表那一行只写定义不写进度,进度在 §5.1。

### §3.2(plugin-core 二分)判定为**不需要**

实测 5 个碰 Node 内建的文件,**零个**是渲染器的消费者(逐个列了消费者)。
而**不变量已被 G10 强制**:在 barrel 加一行 `export { PathSafetyValidator }` → `G10 FAIL 2/790` exit 1,
回退 → `PASS 0/789`。**在没有任何拆分存在的情况下,这个不变式已经生效。**

唯一剩余收益是 7.6 KB 死代码(barrel 保留 18 个模块 / 556,092 bytes;直连四个符号只要 4 个 / 548,482),
而 `"sideEffects": false` 一行即可拿到**逐字节相同**的产物。

**但那一行现在不加**:它是对整个包的声明,而 plugin-core 嵌着 `plugins/builtin/**` 资源树,
且 **vitest 不做 tree-shaking,测试绿在这里什么都不能证明**。要加必须单独立片,以生产 Rollup 构建为验收。

**两处更正,都记在这里**:① 「plugin-core 只有 2 个文件碰 Node」是**错的**,是 **5 文件 / 8 处 import**;
2 是只数了 `node:` 前缀,另三个用裸 `fs`/`path`。G10 自己的头注释写过:报较小的数字「比没有门禁更糟,
因为它会被当作证据引用」——那正是 briefing 里犯的错。② 「计划说三个模块」是**误读**:§3 标题是
「三处必须先拆的**耦合**」,§3.2 正文点名的正是五个文件。**计划是对的。**

### A5 五项决策书(只读测绘,主 agent 已复核)

| # | 决策 |
| --- | --- |
| 1 | **收窄 `data`,保留 G24 但改写它**。原变异证明过不了(`data` 的 migration 和连接建立里合法地有条件分支)。改成:「`data` 内无领域生命周期规则、无策略常量;策略常量归 CP 并注入」,`PENDING_WAKE_STALE_MS` 作为worked negative。接口改造集中在 `session-fork.ts` 一个文件。 |
| 2 | **`memory` 拆分,顺序加一步**:`memory(agent)` → **切断 data⇄memory-state 的环** → `data` → `memory(desktop)`。测绘**新发现**这个环: `db/core/projectService.ts` → `memory-state/db`,而 `memory-state/index.ts` → `db/core/projectService`。**必须在 `data` 成为包之前切断**,否则 `packages/data` 会 import `apps/desktop/...`,即一个包 import 一个 app。 |
| 3 | **`tooling` 倒数第二个,且只搬机制**。计划 §0 说它「是其他包的前置」——**实测为假**:`modes/` 反向依赖 6 个 specifier 打进 `OSTool`/`CanvasConductor`/`SubagentTool`,而 `tool/registry` 被 **62 个文件**引用(不是 27)。**`modes/` 不搬进 `tooling`** —— 那会第一天就违反 G7 并孤立 20 个外部导入者。 |
| 4 | **`capabilities` 最后**。30 个未归属 `tool/` 子目录(110 prod 文件)+ 26 个散落 `tool/*.ts` = 136。判别式:**主体能否纯粹表述为外部之物**(文件、shell、浏览器、技能、设备)→ capabilities;主体是 Goal / Task / Session / Run / 记忆切面 → CP。实测 13 个 import 生命周期、17 个 import 干净。 |
| 5 | **`connectors` 只搬计划那 7 个文件**,`app-connections/` 31 文件**记为延期**。不记的话 `packages/connectors` 就是个长期空壳,撞 G25。 |

### 主 agent 对决策书里三个「真的开不了」的裁决

测绘说 `UpdateStateTool` / `MemoryWriteTool` / `PlanTool` 需要产品裁决而非测量,并明确拒绝替我拍。
用上面的判别式,主 agent 裁决如下:

- **`UpdateStateTool` → CP/运行时**。主体是记忆切面 + bot 身份。它只 import `types`,生命周期知识全在**接线**里
  (`setMemoryTierBridge` / `setBotIdentityBridge`),依赖图永远抓不到它 —— 这正是需要判别式而非 import 计数的原因。
- **`MemoryWriteTool` → CP/运行时**。它对记忆根目录做裸 `fs`/`path` I/O,**复制了记忆布局知识而没有用 `memory-state`**。
  归属之外,这是一个真缺陷,应改为走 `memory-state`。
- **`PlanTool` → CP/运行时**。它的兄弟 `EnterPlanModeTool`/`ExitPlanModeTool` import `modes/plan/plan-tracker`,
  它自己不 import —— **这个不对称本身就是气味**。

三者都要在能搬之前先被重新插到注入端口后面。

### G10 的真相:门禁不跑,但它的**测试**跑

测绘纠正了「没有任何东西跑它」的说法:`vitest.config.ts` 包含 `scripts/**/*.test.ts`,
而 `test.yml` 跑 `npm test` —— 所以 G10 **每个 PR 都被单元测试**(含红向变异证明)。
但**门禁本身从未作用在真实 import 图上**。

**后果:A5 不能引用 G10 作为回归网。** 今天真正的网是 `architecture:check` 的直接边规则。
G10 的独有价值是**闭包式检测**(抓传递性的 Node 内建牵引),而 `core-io` 在直接边上看不见。
这恰恰在 `capabilities` 落地时最重要 —— 那正是渲染侧可能出现传递依赖的时刻。
**要么在迁 `capabilities` 之前把 G10 接进 CI,要么把「G10 保护 Web 故事」这句从 A5 的前提里划掉。**

### 出域依赖计数口径必须写死

两份测绘在 7 行里有 6 行不一致,两者口径都合理。**口径不写进 `00-contracts.md`,
下一个实现者会量出第三套数字,并把它当成「门禁动了」的论据。**
先约定「是否计入 npm / workspace specifier」,再谈任何依赖它的设计结论。
所有 escape 计数都是**下界** —— 动态 `import(变量)` 对它们不可见,包括那个 62 文件的 registry fan-in。

### 新发现的第二个 SQLite

`apps/desktop/src/main/memory-state/` 是**第二个 SQLite 库**(12 个 `.sql.ts` migration、`schema.ts`、
`db.ts` 单例)。计划 06 §5 没有把它列为 `data` 的来源。决策书把它划进 `data`,并把
`control-plane/sqlite-repository.ts` 留在 CP —— 后者自己的文档说「不执行 DDL、不跑 migration、不构造 `Database`」,
它是**端口绑定**不是持久化。### P0:headless / CLI 路径的 prompt 从未到达执行器

d2b 派活前 worker 停下报告:翻转的**对象**前提为假 —— 它没有改任何代码。
经主 agent 独立复现,属实。这是一个**先于架构收口的产品级缺陷**,不是翻转的副产品。

链条共四跳,每一跳单独看都合理:

1. `HeadlessRunHost.start(intent)` 把真 prompt 交给 `this.#controller.start(manifest, { prompt: intent.prompt, ... })`。
2. `RunController` 用这份真 input 调它自己的 `channel.start(manifest, input, sink)`。
3. `headless-run-host.ts` 的 controller 桥接 `start: async (manifest, input, sink) => ...`
   **接收了 `input` 然后丢弃**,只把 `{ frame, end }` 转给 `this.#transport.start`。
4. `InProcessTransport.start` 因此自己**捏造** `RunStartInput = { sessionId: '', prompt: '', options: {}, revision: '' }`,
   再交给 `createAgentExecutionChannel`,后者执行 `agent.streamChat(input.prompt, options)` —— 拿到的是 `''`。

**独立测量**(主 agent 亲自跑,非转述):以 `prompt: 'THE-PROMPT-abc123'` 启动一次 run,
执行器收到的 prompt 数组为 `[""]`,canary 匹配 `false`。探针已删除,树干净。

**为什么至今没有任何东西变红**:既有测试的 `scriptedAgent` double 声明为 `async *streamChat()`,
**一个参数都不接**,因此它在结构上无法观测这件事。不是断言写错,是被测替身看不见。
worker 枚举了 6 条可能的 prompt 通道(controller 的 input / transport 捏造 / RunManifest /
`HeadlessRunHostOptions` / `InProcessTransportOptions.private` / controller 的 `envelope` 臂),6 条都不通。

**影响面**:`packages/agent/src/cli/index.ts` 的三个 host 站点都走这条路径,含 `runTask` 的
`runHost.start({ prompt: task, ... })`。桌面端 `apps/desktop/src/main/agents/server/run-orchestrator.ts` 亦引用 `HeadlessRunHost`。

**裁决:P10 独立切片,先于 d2b。** 不并入 d2b 的理由按重要性排序:
1. 它是**当下就在影响用户**的缺陷,不是 plan 610 的架构债;藏进一个 55 commit 的架构 PR 里会被淹没。
2. d2b 需要的恰恰是「prompt 能到达执行器」。先修,翻转切片就不必同时夹带 transport 移除这个结构性改动。
3. 它可独立测试、独立回退。放在 flip 分支上做成一个原子 commit(而非另开分支),
   是因为 d2b 正在重构同一个文件,两个分支改同一文件必然产生冲突。

**顺带更正两处 briefing 错误(均为我的)**:
- 我称 `headless-retirement.test.ts` 会钉住该符号 —— **错**。它在扫描时**排除** `headless-run-host.ts`,翻转不会在那里注册。
  真正会红的是 `h8-2-consumer-inventory.test.ts`:它把一个 `cli` turn 条目**定义成**本文件里的 `agent.streamChat` 调用点。
- 那两个 desktop 测试**在 pristine HEAD 上就已经是红的**(`4 failed / 10 passed`),原因是树里有 5 处
  `agent.streamChat(` 而只登记了 2 处,其中 4 处在测试文件里。
  **因此它们不能作为 d2b 的基线门禁** —— 我在 briefing 里没有把这一条说清,是第二个前提错误。

### P10 落地:prompt 已送达执行器

**更正上文一处我写错的事实。** 上文称既有测试的 `scriptedAgent` double「一个参数都不接」,
**这是错的**。它确实声明 `streamChat(prompt)` 并把 prompt 推进 `prompts` 数组
(`headless-run-host.test.ts:54-55`)。真实情况是:**`prompts` 每次运行都被填满,
却从未被断言过。** 所以缺口是**一条缺失的断言**,不是一个测不出来的量。
缺陷本身不变,变的是「为什么它没被发现」的答案 —— 修复的准确描述是
「去断言早已在记录的东西」,而不是「让它变得可观测」。

worker 在实现中推翻了我的这条前提,主 agent 复核后确认 worker 是对的,
并已把新测试文件里同源的错误注释一并改正 —— 错误的前提一旦写进代码注释,
就会成为下一个实现者的「依据」。

**修复**:`InProcessTransport.start` 增加**可选**第 4 参 `input?: RunStartInput`,
缺省值就是修复前捏造的那个空对象;`headless-run-host.ts` 的桥接把真实 input 转发下去。
端口仍是三参形状:subprocess 与 http-sse 把 prompt **过线**发送,所以它们的 `start` 不需要 input;
本适配器没有线,transport 调用是唯一入口。

**主 agent 独立复核**(不复用 worker 的测试):另写探针,以
`prompt: 'THE-PROMPT-abc123'` + 一个哨兵 toolRegistry 启动一次 run,执行器实际收到:

```
PROBE_PROMPTS=["THE-PROMPT-abc123"]      修复前为 [""]
PROBE_CANARY_ARRIVED=true
PROBE_OPTION_KEYS=["toolRegistry","maxTurns"]
PROBE_REGISTRY_IDENTITY=true             按引用相等,不是拷贝
```

**顺带修好的一件事(此前是第二个静默缺陷)**:修复前 `input.options` 是捏造的 `{}`,
所以 `toolRegistry` **从未到达执行器** —— CLI 带着工具注册表跑,等于没带。
现在它按引用原样送达,`maxTurns` 合并仍保留。已在 48 文件 / 459 测试内确认无新增失败。

**回归测试**:`headless-run-host-prompt.test.ts`,7 条。去掉生产改动后为 **4 failed / 3 passed**,
修复前复现 `['']`;恢复后 7/7。

**门禁**:`packages/agent/src/process` 47/452 → 48/459;`agent-runtime` 59/711 前后不变(单独跑);
`architecture:check` 1047/1047 tolerated、baseline size 1044 未动;
G7 仍红且两行逐字不变;`typecheck:all` exit 0。
那两个已知红的 desktop 测试 **4 failed / 10 passed 未变**(本次没有增删 `agent.streamChat(` 调用点)。

**已知未修**:`run-routing.ts:336-340` 的注释仍写着 `InProcessTransport` "does today"
转发空 session —— 该注释现已过期,但不属于本切片拥有的文件。

---

## 2026-10-07 — P0-3 复核:不是「一个字段读错」,是**两套词表**对不上;且严重性记录有误

原先的记录是:「`legacy-sse-projector.ts` 写 `done.data.reason` 而 `sse-frame-codec.ts`
读 `event.reason` → `chat:done.reason` 恒 undefined,影响已上线的 worker entry」。

**这条的机制部分为真**(主 agent 逐字复读两侧源码确认),但**范围被严重低估,
且严重性判断反了**。机械比对(脚本提取两侧词表,非肉眼)的结果:

- projector 产出 **25** 个 type;codec `switch` **48** 个 case。
- **产出但 codec 不认的 7 个**:`goal_updated` / `permission` / `retry` / `status` /
  `text_delta` / `thinking_delta` / `token_usage` —— 全部落到 default 臂,记一条 unknown 后**丢弃**。
- **codec 认但 projector 永不产出的 29 个**:`permission_request` / `system` / 全部 18 个
  `research_*` / `plan_steps_created` / `activity` / `result` / `run_status` 等。

### 根因是**换了一个生产者**,而这正是翻转做的事

- **master 上** codec 的唯一生产输入是 `DuyaAgent.streamChat` 的旧词汇事件:
  `agent-process-entry.ts` 的 `convertSSEToAgentMessage(event)` 周围判的正是
  `event.type === 'result' | 'tool_result' | 'done'`。**所以那 29 条「死臂」今天全是活的。**
- **翻转后** 两个入口都把 codec 当作 `legacyFrameCodec` 注入 `driveRunWithEngine`
  (`headless-run-host.ts:503`),其输入变成 `projectToLegacyFrame` 的输出。
  此时那 29 条才真的死,7 个类型才开始被丢。

**所以我原先写的「影响已上线的 worker entry」是错的** —— 在 master 上它是**潜伏**的,
是**翻转会把它变成活跃的**。严重性判断方向因此整个反过来,必须更正。

### 波及面比记录的更宽

1. `agent-process-entry.ts:3314` `turnEndReason = (agentMsg as { reason?: string }).reason`
   —— 与 `chat:done.reason` 是**同一个读取点**,一起失效。
2. `error` 臂同样错位,且更糟:projector 写 `data: { message, code }`,
   而 codec 读 `message: event.data as string` —— 交给 `chat:error.message` 的是一个**对象**,
   `code` 从顶层读,恒 `undefined`。
3. d2b 已在 `headless-run-host.ts` 的 `finalizedStopReason` 文档里**独立发现了 `done` 这一条**,
   并明确划为界外、不修。**那个判断是对的**(codec 与 projector 是共享面)。
   但它只覆盖 7 个丢失类型里最显眼的一个。

### 裁决:修,但**排在 d2c 之后、同 PR 内的独立 commit**

不在 d2c 期间修的理由是**顺序依赖,不是冲突**:在遗留循环删掉之前,
`agent-process-entry.ts` 仍可能有旧生产者路径,此时量出来的「死臂集合」不完整,
按不完整的集合去删会漏。现在修等于按一份会变的清单动一个共享面。

d2c 落地后可得三样今天拿不到的东西:① 旧生产者的调用点数(应为 0,可实测);
② 29 条臂里哪些**真**没有其它生产者;③ 「7 个类型被丢」是否已有守卫测试。
届时以**变异证明**收口:注入一个 `permission` 帧,确认它到达渲染层,再回退确认变红。

---

## 2026-10-07 — 新 P0-4:**「从 CLI 跑一次对话」今天没有任何可运行入口**

起因是回答「什么时候能接入 desktop 或 cli 跑起来」时,主 agent 亲手去跑了两条路,而不是读文档。

### 路 1:`AGENTS.md` 记录的那条命令 —— 实测不成立

`node packages/agent/dist/cli/index.js --task "say hi"` 直接崩在**加载期**:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '...\packages\plugin-core\dist\mcp\scope'
  imported from ...\packages\plugin-core\dist\mcp\provider-tool-name.js
```

**根因是实测的,不是推断**:所有 `@duya/*` 的 tsconfig 都是
`"module": "ESNext"` + **`"moduleResolution": "bundler"`**。`bundler` 解析模式允许并**原样发出
无扩展名的相对 specifier**,而 Node 的 ESM loader 要求完全限定。二者不兼容,
所以**任何 `packages/*/dist` 树都不能被 `node` 直接加载**。

**一个必须写下的反面结果**:主 agent 一度以为根因是
`packages/plugin-core/package.json` **缺 `"type": "module"`** —— 它确实是
`@duya/*` 里**唯一**没有这个字段的包(其余 ai / agent-core / agent-protocol / agent-runtime 全有)。
于是加上它重跑:**同一个 `ERR_MODULE_NOT_FOUND`,一字不差**。
**所以缺 `type` 是一个真实的打包不一致,但不是本故障的原因,不要当成修复去合。** 已回退,树干净。

真正的消费者是 esbuild(`build-agent-bundle.mjs` / `build-electron.mjs`),
`scripts/build-packages.mjs` 的文件头自己写明了这一点 ——
「The real consumers never run `tsc`」。**`AGENTS.md` 里那条 standalone CLI 命令是过期的。**

### 路 2:真正带 bundle 的 CLI —— 能跑,但**不是聊天入口**

`npm run build:cli-bundle` → `packages/cli/bundle/cli.cjs`(0.41 MB,exit 0),
`--help` 正常打印。它是 **DUYA desktop control plane**:
`status / plugin / session / doctor / skill / mcp / provider / channel / cron /
message / gateway / update / backup / security / voice / agent / hook`。
**没有 `--task`,没有 `--print`,不跑一轮对话。**

### 结论(这是对「什么时候能跑起来」的直接回答)

今天的状态是**两半都够不着**:

| 想要的 | 现状 |
| --- | --- |
| 用 CLI 跑一轮对话 | `packages/agent` 的 `--task` / REPL / `--print` 无可运行形态 |
| 用 CLI 操桌面 | `packages/cli/bundle/cli.cjs` 可运行,但要求**桌面已在运行** |

**所以 P0-1(`ToolRegistry` 卡住 `--task` 与 REPL)即使修好也不够** ——
修完仍然没有一条能启动的路径。这是**与翻转正交**的第二个阻塞,排在 P0-1 之后,
且它的正解不是一行 `package.json`(已实测排除),而是为 agent 聊天 CLI 补一个 bundle 入口
(形态上就是 `build:cli-bundle` 的同构做法)。

**桌面侧不受这条影响**:`electron:dev` 走 esbuild,今天可跑(见上,`typecheck:all` exit 0)。

## 2026-10-07 — S4c-d3 落地:子代理宿主走引擎;并切掉那条**早就存在**的环

### 落地内容(分支 `plan/610-final-flip`)

`DuyaAgent.streamChat` 的遗留循环删除后,子代理宿主(`SubagentTool`)是最后一个
还在驱动那个循环的生产方。本切片把它换成 `driveRunWithEngine`,即 worker 入口
与 `headless-run-host` 用的**同一个**驱动。`runAgent.ts` 的 400 行事件消费逻辑
一个字节没动,新的 `subagent-engine-run.ts` 只负责生产那一侧,`__tests__/subagent-engine-run.test.ts`
因此是有意义的对照。

### 循环不是翻转造出来的,是翻转把一个**已有的环**撑大了

`architecture:check` 报了 1 条 NEW:`[cycle] packages/agent/src/hooks/builtin.ts`,
`SCC size=21`。实测的 SCC 成员(用 `audit-modules.mjs` 同一套解析规则复算):

```
command-port -> goal-commands -> goal-tools -> goal-summarizer
  -> runAgent -> subagent-engine-run -> engine-run-driver
  -> run-composition -> command-port
```

**环数一直是 9,没有增加。** 变的是那条**已经存在**的 SCC 从 17 长到 21 —— 翻转把
`tool/SubagentTool` 的四个文件加了进去。判据把 `SCC size=N` 写进了指纹,所以
「同一个环,变大了」只可能以 NEW 的形式出现。

**因此正确的目标不是翻转新增的那条边。** 新模块到 `engine-run-driver` 的边
正是翻转本身,砍掉它等于撤销这次落地(前一位 worker 拒绝了这个处方,拒绝是对的)。
真正该切的是那条**前置就存在**的 `run-composition -> command-port -> goal-commands`。

### 为什么切在 `duyaAgent` 上,而不是别的注入点

逐个候选注入点都用同一套解析规则实测(每种都先移除端口的 import,再加入该处):

| 注入位置 | 含 `hooks/builtin.ts` 的 SCC 大小 |
| --- | --- |
| 什么都不做(现状) | 21 |
| 从 `command-port` 移除 import,交给 `run-composition` | 20 |
| 从 `command-port` 移除 import,交给 `subagent-engine-run` | 18 |
| 从 `command-port` 移除 import,交给 `runAgent` / `agent-process-entry` / `headless-run-host` | 17 |
| **从 `command-port` 移除 import,交给 `duyaAgent`** | **17** ✅ |

`duyaAgent` 之所以是对的位置,不是因为它排在表里,而是因为**它本来就 import 了
`goal-commands`**:遗留循环还在时,`streamChat` 在函数体里内联做过 `/goal` 派发。
循环删除后那两个 import 变成死引用,但边还在。把派发提升为类上的
`runGoalCommand`、让命令端口把它当注入的协作者接收,是**同一份动词表**换了个位置,
不是新增第二份实现。

冻结的 baseline 里那条指纹正是 `cycle / packages/agent/src/agent/DuyaAgent.ts /
SCC size=17`,所以落到 17 就是回到既有债务,**不需要重录 baseline**。

### 变异证明(两个方向都真的变红)

1. **端口不再派发 `/goal`**:把 `goalReply !== null` 改成 `goalReply.length < 0`。
   红,且失败信息是 `expected 1 to be +0` —— 那是**模型被调用的次数**,说明
   `/goal` 真的没被认领、直接发给了 provider(不是只改了注释)。
2. **环重新出现**:把 `import { handleGoalCommand, isGoalControlCommand }` 加回
   `command-port.ts`。`architecture:check` 回到 `SCC size=21` / exit 1,
   与修复前的数字逐字一致。

两次都回滚后 `git status` 干净,`architecture:check` exit 0。

### 结论

**`architecture:check` 回到 exit 0**(total 1054 / tolerated 1054),G7 未受影响
(`known: 0 new: 0 stale: 0`)。`npm run typecheck:all` exit 0。
`packages/agent/src/process` 49 文件 482 用例全绿,`tool/SubagentTool` 7 文件 62 用例全绿。
