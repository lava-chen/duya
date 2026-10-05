# 610 — 架构收口系列

> **把 600(分层落地)、601(控制平面倒置)、602(持久层)合并成一条可执行的主线。**
> 本文件是这三者的**唯一状态源**。600/601/602 各自的 README 保留为契约与推导过程,
> 但"现在做到哪、下一步做什么"只在这里回答,且只回答一次。

## 0. 为什么需要这一份

三份计划各自声明了**一个**"唯一 next action",而它们之间没有共同的编号空间:

| 计划 | 编号空间 | 声明的 next action | 文档在哪 |
| --- | --- | --- | --- |
| 600 | `S0`–`S7` | S2 循环迁出 | **只在 `docs/600-plan-archive` 分支上** |
| 601 | `A` / `B` / `C` | 写门禁 A1 并证明它现在红 | master |
| 602 | `Phase 0`–`3` | 写探针 `sqlite-compat-probe.mjs` | master |

三个后果,都是实测出来的,不是推演:

1. **`docs/exec-plans/README.md` 与 601 §8.2 里那句「600 的 11 份计划文档不在任何分支上」是错的。**
   它们在 `docs/600-plan-archive` 上,一直好好的。**一条关于"资料是否存在"的假事实,
   在索引里被引用了三轮计划。** 本系列把 600 文档落回 master,就是为了消灭这个单点。
2. **三份计划互相看不见对方的顺序约束。** 600 的 S6 被 602 的 Phase 2 卡住,
   而 601 声称 Phase B/C 要等 600 的分层 —— 但没有任何一处列出三者合起来后的**全局**顺序。
3. **602 的立论前提已经不成立**(见 §3),但它对 S6 的阻塞仍然编码在 600 的阶段表里。

---

## 1. 实测基线(2026-10-05,`origin/master @ 0967b2ee`)

所有数字都带 scope,都是本次现测,不是从对话记忆或旧工作树抄的。

| 断言 | 实测值 | 怎么测的 |
| --- | --- | --- |
| 分层门禁 | `932/932` tolerated,`architecture:self-test` OK | `npm run architecture:check` / `architecture:self-test` |
| 边界门禁单测 | **4 条红**(`boundary-gates.test.ts` G4/G7) | `npx vitest run scripts/architecture/boundary-gates.test.ts` |
| 切片分类 | **1 条红**(`compaction-seam.test.ts` 未分类) | `npx vitest run scripts/architecture/slice-classification.test.ts` |
| S2 引擎已落地 | `run-engine-model.ts` 36 KB + `run-engine-ports.ts` 27 KB 在 master | 文件实测 |
| S2 循环**未**迁出 | `DuyaAgent.ts` **255 KB**,仍在 `packages/agent/src/agent/` | 文件实测 |
| S1a 接缝 | `run-routing.ts` **不在 master**,在 PR #214 | 文件实测 |
| S5 六个新包 | `capabilities/connectors/memory/tooling/data/ui` **六个都不存在** | 目录实测 |
| better-sqlite3 | **N-API 插件**,非 V8-ABI;同一 prebuild 跨 Node/Electron 通用 | `package.json` + 双 runtime 实跑 |
| 600 计划文档 | 在 `docs/600-plan-archive`(1 ahead / 0 behind) | `git ls-tree` |

### 1.1 真正的瓶颈:门禁 G7 指错了方向

`boundary-gates.test.ts` 里 G7 的两条红**不是"S2 还没做完所以红"**,是**门禁本身坏了**。
`reachability catches the loop behind the adapter` 是用合成 fixture 测检测器自身的用例,它也红。

直接调用检测器得到的实况:

```
输入:fixture 的 entry.ts -> adapter.ts -> packages/agent/src/agent/DuyaAgent.ts
可达闭包: 含有 DuyaAgent.ts(确实可达)
findWorkerLoopReach() 的 finding:
    packages/agent/src/process/agent-process-entry.ts   <-- 入口自己
    via packages/agent/src/tool/MessageSessionTool/MessageSessionTool.ts
```

两件事同时成立:

- **`isTurnLoopModule` 认不出真正的循环**(`DuyaAgent.ts` 可达却不是 finding);
- **它反而认出了 `agent-process-entry.ts`**,而那正是门禁要保护的那个入口。

于是 S2 的完成定义挂在 G7 上,等于挂在一个**指错方向的判据**上:
G7 既不能证明循环迁出了,也会把入口报成违规。这个状态下继续堆 S2 的代码,产出的"完成"不可信。

---

## 2. 唯一 Next action

> **A1 — 修 `isTurnLoopModule`,让 G7 能真正识别 turn loop 且不误报 worker 入口。**

选它的理由不是它最简单,而是**其余每一片的验收都依赖它的可信度**:

- S2 完成的定义是 G7 转绿;G7 现在指错方向,这一定义不成立。
- 它无前置,改动面小,可变异证明。
- 本系列自己在 §4 立了"门禁必须能变红也必须能变绿"的规矩,第一片就得先让自己合规。

**完成标志(全部可复跑):**

```bash
npx vitest run scripts/architecture/                 # 4+1 现有红全部转绿
npm run architecture:check                          # 932/932 tolerated,无新增
npm run architecture:self-test                      # OK
```

**必须做的变异证明:** 造一个"真循环藏在三层 adapter 后面"的 fixture,确认 G7 变红;
撤掉后确认恢复绿。只证明"当前 fixture 变绿"不算数。

---

## 3. 对三份输入计划的更正

### 3.1 三份计划已收成本系列的三章

**2026-10-05 起,600 / 601 / 602 不再是独立计划。** 它们此前各有编号空间
(`S0–S7` / `A–C` / `Phase 0–3`)、各声明一个"唯一 next action"、且互不引用对方的顺序约束。
那不是三份计划,是**三个互相不知情的真相源** —— 索引里并排列了三行,
任何人读索引都会拿到三个互相矛盾的"下一步"。

现在的结构:

```
docs/exec-plans/active/610-architecture-series/
  README.md                        ← 唯一入口,唯一 next action
  01-layered-architecture/         ← 原 600,11 份。README §4 已冻结为历史契约
  02-headless-control-plane/       ← 原 601,6 份
  03-sqlite-driver/                ← 原 602,4 份
  10-slice-a1-g7-loop-detection.md
  11-slice-a0-client-runtime-axis.md
  90-execution-log.md
```

章节内的相对链接全部保持有效(同目录兄弟文件互相引用),跨章引用已逐条重写并**实测零断链**。

`docs/600-plan-archive` 分支保留,不再是任何东西的"唯一存在处"。

### 3.2 602 退出关键路径,S6 解封

600 原文有一条「S6 排在 602 Phase 2 之后」,理由是:602 Phase 2 要把 **177 个文件**
改成从兼容层 import(纯机械),而 S6 要改同一批文件的业务逻辑(语义),
机械在前语义在后,S6 改的每行才不会被 602 再动一次。

**该约束的唯一目的就是这个。** 而 602 的前提已被实测推翻:

| 602 的前提 | 实测 |
| --- | --- |
| `better-sqlite3` 是 V8-ABI 原生模块 | **它是 N-API 插件**(依赖 `node-addon-api`) |
| Node 与 Electron 需要两份不同的 `.node` | 同一个 `prebuilds/win32-x64.node` 在 Node 24.16.0(ABI 137)与 Electron 44.2.0(ABI 149)下**都加载成功**,SQLite 3.53.4 |
| 需要 `ensure-sqlite-abi.mjs` 来回换二进制 | `lib/binding.js` 先读 `prebuilds/`,而 `build/Release` 在标准 `npm ci` 后**根本不存在** |

**结论:602 剩下的价值只是"删掉一个原生依赖",不再是"逃出 ABI 牢笼"。**
约束失去了存在理由,**S6 不再被 602 阻塞**。600 README 已就地标注撤销。

602 本身**不取消**,降级为可选旁支 C1(见 §5)。它是"值得做",不是"挡着别人"。

### 3.3 索引里的过期论断

`docs/exec-plans/README.md` 表格里「587 — **唯一架构重构入口:G0.1**」一句已过期。
600 的门禁 S0 与 S2 栈都已合并,该入口说法连同"600 文档不在任何分支上"一并更正。

---

## 4. 本系列自己的门禁规矩

从 587/600 一路踩下来的,写在这里对本系列生效:

1. **门禁数字必须带 scope**,格式 `<通过>/<总数> in <scope>`。裸数字不可判读。
2. **每条门禁必须做变异证明**:制造它要防的那种回归 → 确认变红 → 完全回退 → 确认树干净。
   没做变异证明的门禁**不算存在**。
3. **拒绝恒等式断言**。断言里出现 `a === a` 形状的比较(拿测量值比测量值)就是红旗。
4. **绿不得等于"没检查到"**。`ok=0 bad=0` 往往意味着没检查到任何东西,不是全部通过。
5. **门禁必须能变红也必须能变绿**。只会红的门禁挡不住绕过;只会绿的门禁没有意义。
   G7 现在违反的是第 5 条的后半段(它红,但红在错误的文件上)。

---

## 5. 切片表

`A` 线是主线(执行归属),`B` 线是控制平面倒置,`C` 线是可选旁支。

| 切片 | 内容 | 前置 | 门禁 / 验收 |
| --- | --- | --- | --- |
| **A1** | 修 `isTurnLoopModule`,G7 双向可信 | — | `scripts/architecture/` 全绿 + 变异证明 |
| **A0** | **客户端运行时轴**:`@duya/ai` 去掉 `node:crypto`、`@duya/plugin-core` 二分为 schema/loader、`conductor` 开 `./renderer` 子路径 + 门禁 **G10** | 无(可与 A1 并行) | 从浏览器入口出发的 import 闭包不含 Node 内建;须能变红 |
| **A2** | 合 PR #214(S1a 接缝 + S3 背压) | — | `architecture:check` 无新增;`packages/agent-runtime` 632/632 |
| **A3** | S2 循环迁出:`ToolExecutionPipeline` 出 `DuyaAgent.ts` 闭包 | A1, A2 | **G7 在 live tree 上转绿**,且 finding 指向迁出后的真实归属 |
| **A4** | S4 同引擎接 CLI / eval | A3 | 多轮、工具报错、取消、存储拒绝、worker 退出、慢消费者 |
| **A5** | S5 六包逐切片迁移(L3 宿主) | A4, **A0** | 每迁一块切断旧依赖并验证真实消费者 |
| **A6** | S6 Session data contract | A5(**不再等 602**) | 回填 / 恢复 / 兼容证据齐备后才删旧关系 |
| **A7** | S7 facade 退役 | A6 | `packages/agent` 消费者归零后删除 |
| **B1** | 601-A 门禁:6 个 handler 的模块加载期 Electron 依赖 | 无(可与 A 线并行) | 门禁 A1 先证明现在是红的 |
| **B2** | 601-B 控制平面倒置成纯 Node 进程 | A5, B1, **A0** | Electron / CLI / Web / 小程序全部降级为它的客户端;CLI 与 main 进程内加载 L3,Web 走 HTTP |
| **B3** | 601-C agent runtime 注册到远端 | B2 | — |
| **C1** | 602 Phase 0 探针(可选) | 无 | 9 项能力边界;`close()` 语义与回滚路径任一不过就停下 |

**关键路径:A1 → A2 → A3 → A4 → A5 → A6 → A7。**
**A0 是唯一不做架构改造也能做的一片**,产出是让 Web 从"被耦合卡住"变成"差一个 `apps/web` 骨架",
建议与 A1 并行启动 —— 见 [02 客户端与运行时轴](11-slice-a0-client-runtime-axis.md)。
B 线在 B1 之后才与 A5 交汇;C 线全程可并行且不阻塞任何人。

### 5.1 每片的唯一 next action

> 上表只有名字与依赖,**这张表才回答"从哪下手"**。
> 一片只有一个入口动作,做完才有下一句 —— 写成清单会让人同时开工四片,四片都半途。

| 片 | 唯一 next action | 完成标志 |
| --- | --- | --- |
| **A1** | ✅ **已合并**(PR #219 / `908b5baf`)。原 open 项已答:新增 finding 是**真违规**,不是 `ports.ts` 过读(实测该文件只满足 1/3 子句,两处正则命中都在注释里) | `mutation-proof-a1.mjs` **5/5**;`architecture:check` 无新增 |
| **A0** | ✅ §3.1 + §3.3 + 门禁 **G10** 已落。§3.2 plugin-core 二分**未做**:实测它对 renderer 闭包贡献 21 文件、**0** Node 内建,barrel 已排除真正碰 Node 的三个模块 —— 是独立切片不是本片尾巴 | 浏览器入口闭包 **0/789** Node 内建;G10 变异证明 `FAIL 2/790` → 回退 `PASS 0/789` |
| **A2** | ✅ **已合并**(PR #222 / `a046cdf6`)。顺带修掉 #214 的 `TS2393` 重复 `publish` | `935/935 tolerated`(baseline 930 未动);`644/652 in packages/agent-runtime` 与 master 同一失败集;`typecheck:all` exit 0 |
| **A3** | **判据已重定义**(见 [执行日志](90-execution-log.md))。原描述"把 `ToolExecutionPipeline` 移出闭包"**已证明做不成**:三个探针显示搬去 `packages/agent` 或 `agent-runtime` 都让 G7 从 1 变 2。G7 现按**深度 0/1** 判定。**下一步:切断 `agent-process-entry.ts:76` 那条直接边** | G7 depth-1 finding 转绿;`mutation-proof-a1.mjs` 仍 5/5 |
| **A4** | 按 `04-runtime-owns-execution.md` §Step 4 逐场景做,**从"工具报错"起**(最易复现) | 6 场景逐个可复跑;每场景一条测试 |
| **A5** | 先迁 `data`(纯 I/O、无业务决策),再 `capabilities`,最后 `memory` | 每迁一块:旧依赖归零 + 真实消费者仍绿 |
| **A6** | 先产出回填/恢复脚本,再改 schema | 三份证据齐备才删旧关系 |
| **A7** | `packages/agent` 消费者归零检查 | `architecture:check` 的 module-dependency 降到预期值 |
| **B1** | ✅ 门禁(静态 A1a + 行为 A1b)已红→绿,6 个 handler 已改软 require。**A1b-full 仍红且故意保留**:45 个层外模块仍硬 import electron(`window-manager` / `ipc/*` / `boot-config` / `db/connection` 等),已逐次打印在门禁输出里 | 图层内 `GREEN`;变异证明双向;层外清单是**下一步的输入**,不是已完成 |
| **B2** | 先把控制平面搬成独立进程,**不改客户端** | Electron main 不再拥有控制平面;CLI 与 main 进程内加载 L3 |
| **B3** | 远端注册表 + 认证 | — |
| **C1** | 写探针,两个 runtime 各跑一次 | 9 项能力边界;`close()` 与回滚路径任一不过就停 |

**A0 与 A1 都会改 `scripts/architecture/`** —— 两者并行会冲突。
**约定:先合 A1,再动 A0 的 G10。** A0 的 `conductor` 子路径部分不碰门禁,可先行。

### 5.2 放弃条件

没有放弃条件的计划序列会无限膨胀。以下任一条成立时,**停下并重新裁决**,不要继续往下做:

| # | 触发条件 | 为什么该停 |
| --- | --- | --- |
| 1 | **A3 连做两片仍不能把 G7 弄绿** | 说明"循环"这个目标本身定义错了(可能是 S2 的 `run-engine-model.ts` 已经是循环,那 G7 的判据该改而不是代码该搬) |
| 2 | **A5 迁完一个包,门禁新增违规 > 3 条** | 迁移方式有问题,不是包有问题。继续迁只会放大 |
| 3 | **任何一片无法做变异证明** | 该片不算完成(§4 第 2 条)。做不出变异证明的守卫等于没有守卫 |
| 4 | **A2 合并 #214 后 `architecture:check` 新增 > 5 条** | PR #214 混了 S1a + S3 两件事,需要拆开重做 |
| 5 | **连续两片的关键路径净变更 < 20 行** | 说明在做重构姿势而不是推进,应该回到"哪条边界还红"这个问题 |

> 第 5 条是刻意的粗糙判据。**它的作用不是精确,而是阻止"看起来一直在忙"的假进度。**

---

## 6. 边界

- 本系列**不改** 600/601/602 的目标架构裁决,只重排顺序、更正被实测推翻的前提。
- 本系列**不取消** 602,只把它移出关键路径。
- 本系列**不接管** `packages/agent-runtime` 等已完成切片的历史记录,那些在各自执行日志里。
- 本系列自己也要遵守 §4;若某片做不到变异证明,**该片不完成**。

---

## 7. 本系列的全部文件

**这就是架构工作的全部。`docs/exec-plans/active/` 下另有 587,其合同已被第 01 章接管,不再单独排期。**

| 文件 | 作用 |
| --- | --- |
| [01-layered-architecture/](./01-layered-architecture/README.md) | 分层落地契约(原 600,11 份)。§4 已冻结为历史契约 |
| [02-headless-control-plane/](./02-headless-control-plane/README.md) | 控制平面倒置(原 601,6 份)= B 线 |
| [03-sqlite-driver/](./03-sqlite-driver/README.md) | SQLite 驱动(原 602,4 份)= C 线可选旁支,前提已更正见其 §0 |
| [10-slice-a1-g7-loop-detection.md](./10-slice-a1-g7-loop-detection.md) | 切片 A1 契约 —— **当前唯一 next action** |
| [11-slice-a0-client-runtime-axis.md](./11-slice-a0-client-runtime-axis.md) | 切片 A0 契约 —— 客户端运行时轴 |
| [90-execution-log.md](./90-execution-log.md) | 执行日志与未决项 |
