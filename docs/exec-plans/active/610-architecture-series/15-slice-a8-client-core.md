# 15 — 切片 A8:客户端轴(`client-core` 层与反向依赖门禁)

Date: 2026-10-16. Parent: [610 README](./README.md).
状态:契约已定,未开工。与 [611 TUI foundation](../611-tui-foundation-slice.md) 对齐边界。

---

## 0. 结论

**本片不是新提案。** 2026-10-16 评审的「统一 Agent 平台」目标架构,
逐条对照后**约八成已在 610 里裁决过**(见 §1),包括几处本片曾准备重新发明的东西:
`@duya/ui` 已经是 `packages/conductor/renderer`,浏览器安全门禁 G10 已经在跑。

本片只补**三处 610 没有裁决的空洞**,其中一处是硬阻塞:

| # | 空洞 | 性质 |
| --- | --- | --- |
| **A8.1** | `SurfaceModel` 住在 `agent-runtime`(执行引擎所在包),客户端状态层尚不存在 | ✅ **已完成**(PR #270,`943225cf`);落点 = 新建 `packages/client-core`,详见 §3.1 |
| **A8.2** | `client-core` 层在 A0 的 L0–L3 里不存在,边界未定义 | 定义缺失 |
| **A8.3** | 客户端轴**没有反向依赖门禁**,G10 只覆盖浏览器入口 | 守卫缺失 |

**A8 的关键路径顺序:先平移,再接线。** 反过来做会先把一条错误的依赖边固化,再拆。

---

## 1. 已裁决 vs 本片新增

> 纪律:**先证明它已被裁决,再决定是否需要新裁决。**
> 610 的 [00-contracts §0](./02-headless-control-plane/00-contracts.md)
> 自称「进程与网络边界的唯一权威」,重叠时以它为准。

| 目标架构组件 | 610 已有裁决 | 状态 |
| --- | --- | --- |
| Client 不可信、只发指令、不碰工作区 | `00-contracts` §1.3 | ✅ 已裁决 |
| Host = Control Plane(拥有记录,不执行) | §1.1 | ✅ 已裁决 |
| `agent-runtime` 唯一执行体系;三种宿主形态必须同一实现 | §1.2 + 门禁 C1 | ✅ 已裁决 |
| 能力不靠 `isElectron` 判断 | §1.3「任何需要『只有桌面能做』的能力,说明它被错放进了客户端」 | ⚠️ 原则已有,**机制缺** |
| `apps/web` 存在 | §5 放置规则 | ✅ 已裁决(601 推翻了 600 的「本系列不建」) |
| 客户端契约 = browser-safe DTO | §3;判据 `contracts-boundary.test.ts` | ✅ 已落地 |
| 共享 React UI | §5「有包外消费者 → 才进 `packages/`」+ A0 §3.3 | ✅ **已落地为 `packages/conductor/renderer`** |
| 浏览器安全可证明 | A0 §4 门禁 G10 | ✅ **已在跑** |
| Transport 适配器抽象 | [02-client-unification](./02-headless-control-plane/02-client-unification.md) §8 | ⛔ **明确推迟**,判据见 §4 |
| `SurfaceModel` 的归属 | 无 | ❌ **本片 A8.1** |
| `client-core` 层定义 | A0 L0–L3 无此层 | ❌ **本片 A8.2** |
| 客户端轴反向依赖门禁 | `00-contracts` §2 硬边只约束 Control Plane | ❌ **本片 A8.3** |

### 1.1 两条要特别记住的已有裁决

**`@duya/ui` 不新建。** `packages/conductor/package.json` 的 `exports` 已含
`./renderer` 与 `./renderer/*`,指向 `src/renderer/**`,且 `src` 下 **0** 个 Node 内建命中。
本片的工作是**给它加第二个消费者**,不是从 Desktop 搬一份出来。

**传输抽象是被明确推迟过的,不是没想过。** `02-client-unification` §8 的原话:
「Phase B 不造传输无关的 channel 层」,判据是「当第三个客户端出现、且它需要双向流时再抽象」。
本片不得绕过这条裁决(见 §4)。

---

## 1.5 A8.1 的验收实测(2026-10-16,合并后)

PR #270 落地后逐条核对,**7 条口径全中**:

| 判据 | 实测 |
| --- | --- |
| `packages/client-core` 建立,`surface-model.ts` 移入 | ✅ 1176 行 |
| `import` 命中 **1** 且为 `import type` | ✅ 值 import **0** |
| Node 内建 / React 引用 | ✅ **0 / 0** |
| 依赖 | ✅ 只有 `@duya/agent-protocol` |
| tsconfig 与 `agent-core` 同形 | ✅ |
| `architecture-policy.yaml` | ✅ `managed: true` / `requires: [agent-protocol]` / `publicEntrypoints` / `owner: client` |
| 过渡 re-export | ✅ `agent-runtime/src/index.ts` |
| `typecheck:client-core` 串进 `typecheck:all` | ✅ |

### 1.5.1 合并时带的两个缺口(已修)

**缺口一:`client-core` 是一个零测试的包。**
被测对象搬走了,1061 行 `surface-conformance.test.ts` 留在 `agent-runtime/test/`,
靠过渡 re-export 访问 `SurfaceModel`。**从门禁视角看,拥有这个模型的包完全未被覆盖。**

修法不是复制 helper(450 行的用例表复制一遍,下次改 fixture 又要改两处),而是**拆**:

| 位置 | 内容 | 行数 |
| --- | --- | --- |
| `packages/client-core/src/testing/index.ts` | **纯** fixture:`envelope` / `startedModel` / `RUN_ID` / `SESSION_ID` / `BASE_TS` | 56 |
| `packages/client-core/test/surface-model.test.ts` | 模型全部用例 + `CONFORMANCE_CASES` 表 | 67 tests |
| `packages/agent-runtime/test/surface-conformance.test.ts` | **只留** legacy 投影用例 | 6 tests |

**`CONFORMANCE_CASES` 不能进 `/testing` 子路径。** 它带 `expect()` 闭包,
而 `@duya/agent-protocol/testing` 这个先例是**纯 fixture、不 import vitest**——
把断言闭包放进可发布子路径,编译后的 `dist` 会反向依赖只装在 devDeps 的 vitest。
所以断言归测试文件,只有纯构造器进子路径。

**缺口二:`legacy-projection.ts` 留在 `agent-runtime`。**
裁决是「TUI 不走 legacy 重放路径」——`LEGACY_MAPPED_EVENT_TYPES` /
`replayOntoSurface` / `projectToLegacyFrame` 全在 `@duya/agent-runtime`,
**TUI 一旦 import 它们就违反 §3.1 判据 4**。legacy 词汇表迟早要删,
搬它只是把一个要死的东西换个地方放。**该约束写进 §6 的接线验收,不留成口头默契。**

拆分后:`67 + 6 = 73`,与拆分前的 73 条 conformance **逐条一致,零丢失**。
(此前记忆里的「86」是 73 conformance + 13 blessed view,不是 86 条 conformance。)

> **这套拆分不是空转的证据**:中途我把 `SESSION_ID` 从导入里误删了一次,
> `run.started` 那条**立刻转红**(`ReferenceError: SESSION_ID is not defined`)。
> 一个断言不了任何东西的套件不会这样。

### 1.5.2 拆分连带改到的两处(别漏)

- `vitest.config.ts` 的 `WORKSPACE_SOURCE_ALIASES` 加 `'client-core'`,
  否则 `@duya/client-core/testing` 会走 `node_modules` 去要 `dist`。
- `vitest.config.ts` 的 **`include` 是逐包白名单**,必须加
  `'packages/client-core/test/**/*.test.ts'`。
  **不加以 `check-test-coverage` 会正确地报「一个没人跑的测试」。**
  该数组由正则读取引号字符串且**不剥注释**——注释里一个撇号就会静默吞掉后面的 glob。

## 2. 实测基线(2026-10-16,`master @ c3a1ed41`)

> 每个数字都带 scope。复现命令写在旁边;**不要抄行号,抄命令**——
> 本系列已有两次「把门禁输出抄成行号 = 用更权威的伪装重新引入同一个错误」的记录。

| # | 事实 | 复现 |
| --- | --- | --- |
| 1 | `surface-model.ts` **1054 行**;`import` 命中 **1** 个,且是 `import type` from `@duya/agent-protocol`;**运行时依赖 0** | 见 §2.1 |
| 2 | 它住在 `packages/agent-runtime/src/surface/`,而同包 `src/index.ts` **同时导出 `RunEngineImpl`** | `rg "RunEngineImpl" packages/agent-runtime/src/index.ts` |
| 3 | 它唯一的生产消费者是 `packages/agent/src/cli/ui/index.ts` | `rg "surface" packages apps --glob '!**/dist/**'` |
| 4 | `packages/agent` **尚未退役**:`agent-retirement-gate.mjs` 仍报若干 `blocking`(build-tooling / active-config 的 source-or-dist-path) | `node scripts/architecture/agent-retirement-gate.mjs` |
| 5 | G10 入口 = `apps/desktop/src/renderer` + `apps/web/src/main.tsx`(后者**本树不存在**,报 absent 而非静默跳过) | `node scripts/architecture/browser-closure-gate.mjs` → `PASS 0/863 Node built-ins` |
| 6 | **G10 不覆盖 `packages/cli`** —— `BROWSER_ENTRIES` 里没有 CLI/TUI | 同上,读 `browser-closure-gate.mjs` 的 `BROWSER_ENTRIES` |
| 7 | TUI 侧存在**第二套**事件→视图模型:`blocks.ts` 的 `TranscriptModel` + `host-event-stream.ts` 的 `projectHostEvent()`,产出 `LegacyFrame` | `rg "class TranscriptModel\|projectHostEvent" packages/cli/src/tui` |
| 8 | Desktop 侧存在**第三套**:`stream-session-manager.ts` **5033 行**,其中 `electronAPI` **16** 处、`window.` **12** 处 | `rg -c "electronAPI\|window\."` |
| 9 | 611 已在 TUI 侧建了 identity/sequence 投影边界,**但仍投影到 `LegacyFrame` 词汇** | [611 §Reference findings and scope boundary](../611-tui-foundation-slice.md) |
| 10 | `agent-protocol` 是 `managed: true` + `requires: []` 的**真叶子**,`forbiddenDependencies` 明确禁 `agent-core` / `agent-runtime` / `electron` / `src` | `architecture-policy.yaml` `modules:` 与 `forbiddenDependencies:` 段 |
| 11 | **`layers:` 块把 `cli` 归在 `host` 层** —— 所以「只能向下依赖」**不构成**对 `cli → agent-runtime` 的约束 | `architecture-policy.yaml` `layers:` 段 |
| 12 | `agent-protocol/src/transcript/index.ts` 是**纯 re-export barrel**(4 条 `export {}` / `export *`,0 条声明)—— 协议侧的 transcript 只有词汇,没有计算 | 见 §2.1 |
| 13 | `agent-core` **37 文件 / 0 Node 内建**,且**已在 G10 已验证的 renderer 闭包内**(`apps/desktop/src/renderer/lib/ipc-client.ts` 引用它) | 见 §2.1 |
| 14 | `agent-core` 里的 `message/message-projectors.ts`(634 行)、`modes/run-lifecycle-tracker.ts`(378 行)、`wake/epoch.ts`(80 行)投影的是 **agent 域**(`AgentMessage`、自主 run 生命周期、turn 取代),**不是客户端状态** | 见 §2.1 |

### 2.1 事实 1 / 12 / 13 / 14 的复现命令

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('packages/agent-runtime/src/surface/surface-model.ts','utf8');\
const m=s.match(/^import[\s\S]*?from\s+'[^']+';/gm)||[];console.log('imports:',m.length);m.forEach(x=>console.log(' ',x.replace(/\s+/g,' ')))"

# 事实 12:协议侧 transcript 是纯 barrel
node -e "const fs=require('fs');const s=fs.readFileSync('packages/agent-protocol/src/transcript/index.ts','utf8');\
console.log('declarations:',(s.match(/^export (function|class|const|type|interface) /gm)||[]).length,\
're-exports:',(s.match(/^export (\\{|\\*)/gm)||[]).length)"

# 事实 13:agent-core 的 Node 内建数
node -e "const fs=require('fs'),p=require('path');let n=0,h=0;\
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);\
if(e.isDirectory())w(f);else if(/\.tsx?$/.test(e.name)){n++;if(/from '(node:|fs|path|os|net|crypto|child_process|worker_threads|sqlite)/.test(fs.readFileSync(f,'utf8')))h++;}}})('packages/agent-core/src');\
console.log('agent-core files',n,'node-builtin files',h)"

node scripts/architecture/browser-closure-gate.mjs   # 事实 13 的闭包证据
```

**口径警告(三次都栽在数法上):**

- 数 import 必须用能吃跨行 `import {...} from '...'` 的正则。数法甲「只数 `^import ` 开头」会漏掉多行 import。
- 数 export 必须**分别数声明与 re-export**。只匹配 `^export (function|class|const|type|interface)` 会把
  `export { ... }` 整桶漏掉,于是 122 行的 barrel 看起来像「0 个导出」。
  **空匹配不等于不存在**——本片第一版就差点据此断言协议侧没有计算逻辑。
- 数 Node 内建必须**去注释**且 `node:` 与裸名都算。

---

## 3. 三处裁决

### 3.1 A8.1 — `SurfaceModel` 平移(硬阻塞,先于一切接线)

**问题.** 目标分层要求 `client-core` 在 `agent-runtime` 之上。而 `SurfaceModel` 现在住在
`agent-runtime`,与执行引擎本体同包。**一旦 `packages/cli` 为 TUI 接入它,就建出
「客户端 → 执行引擎」的依赖边**,CLI bundle 还会把 `@duya/agent-core` / `@duya/plugin-core` 一起拖进去。

**为什么现在修几乎免费.** 实测事实 1:该文件**零运行时依赖**,只有一条 `import type`。
所以这是一次 `git mv` + 改导出路径,**不需要重构**。今天不搬,等 TUI 接上之后再搬,
成本会从「移动文件」变成「先拆依赖、再移动、再修 bundle」。

**裁决.**

1. **新建 `packages/client-core`,把 `surface-model.ts` 与 `legacy-projection.ts` 直接移进去。**
   `client-core` 从第一天起就只有 `@duya/agent-protocol` 一个依赖,**零 Node / 零 React**。
2. `client-runtime` 一侧**保留过渡期 re-export**,给 `packages/agent/src/cli/ui/` 两条 import
   (`index.ts` 与 `surface-view.ts`)一条不立刻断的路径;A7 落地时删除。
3. **`architecture-policy.yaml` 必须同时加 `client-core` 模块声明**
   (`id` / `roots` / `managed: true` / `requires: [agent-protocol]` / `publicEntrypoints` / `owner`)。
   **不加就是造一个门禁管不到的区**——见 §2 事实 10。
4. **判据:`packages/cli` 与 `conductor/renderer` 的 import 闭包不得出现 `@duya/agent-runtime`。**
   这条由 A8.3 的门禁强制。**注意不能用层规则兜底**:`layers:` 块把 `cli` 归在 `host` 层,
   所以「只能向下依赖」对这条边**不构成约束**(见 §2 事实 11)。

> **风险:** 若 A7(退役 `packages/agent`)先于 A8.1 落地,唯一消费者消失,
> `SurfaceModel` 会变成「有测试、零生产消费者」——那正是它今天已经半只脚站着的状态。
> **A8.1 与 A7 必须同分支可见,不能一个合完隔几天再合另一个。**

### 3.2 A8.2 — `client-core` 层:定义与边界

**问题.** A0 §2 的 L0–L3 里没有「客户端状态机」这一层。A0 §6 有一条禁令:
「**不在 L2 里放任何编排逻辑。L2 是呈现,不是控制。**」而 `client-core` 按定义就含
Session Store / Run Control / 审批状态。**不做裁决,它会滑进 L2,或者变成没人认领的黑洞。**

**裁决:新增 L1.5(客户端状态层),位于 L1 纯计算与 L2 客户端共享之间。**

| 层 | 装什么 | 运行时 |
| --- | --- | --- |
| L0 协议 | 类型、事件、线上格式(`agent-protocol`) | 任意 |
| L1 纯计算 | 无 IO 核心计算(`agent-core`) | 任意 |
| **L1.5 客户端状态(新)** | **事件归并、会话快照、重放缺口检测、审批挂起** | **任意,且零 Node / 零 React** |
| L2 客户端共享 | 共享 UI、schema、模型元数据(`conductor/renderer`) | 浏览器安全 |
| L3 宿主 | `capabilities` / `connectors` / `memory` / `tooling` / `data` | Node-only |

**A0 §6 禁令的可执行替身.** 「不放编排逻辑」无法直接门禁。换成一条能测的:

> **G11 判据:`client-core` 不得产生任何 Host 未发出的状态转移。**
> 它的每一次状态变更都必须能指回一条具体的 `RunEventEnvelope`,或一次显式的用户/客户端动作。
> **它不决定「下一步发生什么」,只决定「已经发生的事如何呈现」。**

这条同时解决了两个问题:它禁止 `client-core` 长出本地状态机/重试/调度,
又**允许**它做去重、缺口检测和快照——那些都可追溯到具体事件。

**重放不归 `client-core`.** `agent-protocol/src/replay.ts` 已是 Host 权威协议
(`RunEpoch` / `ReplayCursor` / `ReplayWindow` / `replayWindow()` / `refuseForeignCursor()`),
`resume.ts` 有 `ResumeSupport` / `isReplayable` / `TOOL_LIFECYCLE_EVENTS`。
**浏览器刷新后要续上,只能从 Host 取**——客户端本地事件日志对 Web 结构性无用,而这正是 Web 上线时
第一个被撞上的场景。`client-core` 只做:apply + 去重 + **缺口时请求窗口** + 拒绝码降级。

**能力协商要补客户端侧.** 现有机制只有 `RuntimeCapabilities`(Host 侧)与
`CapabilityRequirement`(调用方声明需求)。**没有「客户端能呈现什么」的声明**,
于是 Host 会推送客户端无法呈现的事件。本片只记为待查项,不裁决——裁决需要先确认
`capabilities.ts` / `envelope.ts` / `run.ts` 里是否已有等价物(**本片未验证**)。

### 3.3 A8.3 — 门禁 G11:客户端轴反向依赖

**问题.** G10 是**浏览器闭包**门禁,入口只有 `apps/desktop/src/renderer` + `apps/web`(实测事实 5、6)。
TUI/CLI 是 Node 客户端,**本来就不该是浏览器入口**——G10 不覆盖它是设计使然,不是缺陷。
**但这意味着「客户端 → 执行引擎」这条边今天没有任何守卫。**
下一次有人为了让 TUI 拿到 `SurfaceModel` 而 import `@duya/agent-runtime`,不会有任何东西变红。

**裁决.**

- **G11-1(层向):** `packages/cli` 与 `conductor/renderer` 的 **import 闭包不得包含
  `@duya/agent-runtime`**。这是 A8.1 裁决 4 的强制手段。
- **G11-2(形状唯一,复用 B2):** 同一能力不得存在多套事件词汇。
  今天已存在 **3 套**(`SurfaceModel` / `LegacyFrame` / `stream-session-manager` 的回调汤,实测事实 1、7、8)。
  A8 完成后目标是 **1 套**,且 `LegacyFrame` 仅作为 TUI 的**渲染中间态**存在,不再是第二套解析器。

**G11 复用既有机制,不新造门禁脚本。** 与 `02-client-unification` §6.1 同一条纪律:
600 的 S0 之所以可信,是因为每条规则都做过变异证明;新脚本默认不可信。
G11 挂在 `boundary-gates.ts` / `browser-closure-gate.ts` 已有的 import 解析
(`import-graph.mjs`)上,不自写闭包展开。

**G11 必须能变红(双向证明)。**

| 方向 | 注入 | 期望 |
| --- | --- | --- |
| 正向 | 从 `packages/cli` 拉一条 `@duya/agent-runtime` 的 **值** import | 红 |
| 反向 | 同一条改成 **`import type`** | 绿(类型 import 被编译器擦除,到不了 bundle) |
| 防空转 | live tree 断言 `walked > 0` | 绿且计数非零 |

> 反向那一条**不能省**。省掉它,门禁会退化成「任何 import 都红」,于是第一次有人写
> `import type` 就会被无关地拦下,然后有人去改门禁。**反向证明是防止守卫变成噪音的那一步。**

---

## 4. 明确不做

| 不做 | 理由 |
| --- | --- |
| **造 `Transport Adapters` 抽象层** | `02-client-unification` §8 已明确推迟,判据是「第三个客户端出现且需要双向流」。本片不得绕过 |
| **从 Desktop「提取」React 共享层** | `conductor/renderer` 已存在且 0 Node 内建。Web 还不存在时提取 = **单消费者提取**,没有信息判断缝在哪,只会把 Desktop 的历史形状搬进一个叫「共享」的包里。等第二个消费者出现再动 |
| 造 Web 端骨架 | 属 B2 线(控制平面倒置),不是本片 |
| 造 Relay / 远程中继 | `03-remote-runtime.md` + 门禁 C1/C2 的范围 |
| 改 `contracts-boundary.test.ts` 的判据 | 它是对的,只需扩覆盖面(同 `02-client-unification` §7) |
| 动 600 的分层裁决 | 若发现某条 600 边界挡住正当需求,那是 600 要改,不是绕过——走评审 |
| 让 `client-core` 拥有事件日志 | 见 §3.2「重放不归 `client-core`」 |

---

---

## 5. 门禁与验收


| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| **G11-1** | 客户端轴闭包不含 `@duya/agent-runtime` | 三方向,见 §3.3 表 |
| **G11-2** | 事件词汇数 == 1,`LegacyFrame` 仅作渲染中间态 | 保留一处 IPC/HTTP 专用形状(**拒绝恒等式断言**) |
| 既有 **G10** | 浏览器闭包 0 Node 内建 | 已在跑,`FAIL 2/790 → PASS 0/789` |
| 既有 `architecture:check` | 无新增 | baseline 数字**必须与改动前同树对比**,不得整批重录 |

> **G11-2 两侧来源必须不同**:声明侧是「本片声明的唯一词汇」,实测侧是 import 图扫描。
> 拿「扫描出的条数」比「扫描出的条数」永远通过——`600` 的 `LEGACY_RETIREMENT` 测试犯过这个错,
> 本仓库已第三次出现「守卫报告事实却不检查任何东西」。**这类门禁默认不可信,直到做过变异。**

### 5.1 完成标志

1. `SurfaceModel` 已在 `packages/client-core`,`agent-runtime` 只剩过渡 re-export,
   且 `architecture-policy.yaml` 有对应的 `managed: true` 模块声明
2. **TUI 生产路径经 611 建的投影边界驱动 `SurfaceModel`**——不是「模型有测试」
3. G11-1/G11-2 双向变异证明通过,且 `walked > 0`
4. `typecheck:all` exit 0;`architecture:check` 无新增
5. **真终端里跑过**(`611` 已立的验收纪律:模型有测试 ≠ 终端里跑过)
6. **A7 退役 `packages/agent` 时,`SurfaceModel` 的消费者已迁走**

---

## 6. 唯一 next action 与执行顺序

> 本系列纪律:一片一个入口动作,做完才有下一句。写成清单会让人同时开工四片,四片都半途。

**唯一 next action:定义 `HostCapabilities` 契约——与 `agent-protocol/src/capabilities.ts`
里的 `RuntimeCapabilities` 平级,覆盖盘点列出的 12 类宿主能力。**

**为什么是它而不是 UI 包:** `RuntimeCapabilities` 描述的是「runtime 在一次 run 里能做什么」,
**不是 UI 宿主能力表**。B 类那 100 个文件需要的、会话持久化(~150 refs)、设置 KV(~48)、
fs(~24)、语音(~20)、项目注册表(~20)、目录对话框(~16)、provider CRUD(~14)、
OS shell(~13)、日志导出(13)、git(10)、端口发现(8)、视觉开关(6),
**在协议层零表述**。没有它,「这个组件能不能进 Web」就只能逐点 feature detection,
永远补不完,`@duya/ui` 的抽取缝也定不下来。

做完才有下一句:

1. **`HostCapabilities` 契约**(见上)+ 客户端侧自述(§3.2 的待查项)
2. **G11-0 改成预算门禁**。当前形态下它**永远转不绿**:`BROWSER_ENTRIES` 里
   `apps/desktop/src/renderer` 自己就是入口,而桌面 renderer 必须调 preload 全局。
   实测推论:搬完 A 类分子 **115 一个不变**(只有分母降)→ **A 类搬运对门禁零进展**;
   B 类全转 port → 下界 **15**;那 15 个永不归零。
   **真会下降的指标是 `preloadFiles <= 115`(下界 15)**,不是 `PASS`。
   详见 [16 UI 盘点](./16-a8-ui-census.md) §「真验收标准」。
3. **TUI 经 611 的投影边界接 `SurfaceModel`**;`blocks.ts` 的 `TranscriptModel`
   降级为它的一个 view。接线验收里必须含「TUI 闭包不含 `@duya/agent-runtime`」。
4. **`@duya/ui` 第一批 = A 类**。盘点实测 A 类 658 个文件自身零引用,
   其中 90 个传递闭包被污染。**只搬传递闭包也干净的那批**,第一批给出具体文件名清单。
5. **B 类逐块转 client port**,每转一块预算数字降一档。
6. Desktop 切换 `stream-session-manager.ts`——**此时它才是第二个消费者,拆分才有依据**。
7. `apps/web` 上线。

> **A 类搬完 G11-0 不会变绿,这不是失败。** 变绿在这个门禁的设计下不存在。
> 拿它当 promise 会得到两个坏结果:要么有人去改门禁让它绿,要么搬完无法验收。

### 6.1 与其他切片的关系

| 关系 | 说明 |
| --- | --- |
| 依赖 **A0** | 复用 G10 与 `conductor/renderer`。A0 已完成 |
| **不依赖** A1–A7 | 关键路径 `A1→A7` **不变**。A8 与 A5 可并行 |
| **依赖 A7** | A7 退役 `packages/agent` 时,A8.1 必须已落地(§3.1 风险条) |
| 对齐 **611** | 611「implemented, review pending」。**本片不得改它的 admission controller / composer / 布局**,只替换投影边界**背后**的词汇 |
| 补 **B2** | `B2` 管「控制平面倒置」,本片管「客户端状态层」,两者不重叠 |

---

## 7. 放弃条件

任一条成立时**停下并重新裁决**,不要继续往下做:

1. **A8.1 的平移不再是纯移动**(实测发现 `surface-model.ts` 出现了运行时 import,
   或它的 `import type` 面已大于实测的 1 条)——说明它已经不是叶子模块,
   A8.2 的分层前提失效,回 A0 §3 重估
2. **A8.3 的门禁在 live tree 上 `walked == 0`**——门禁没检查任何东西,
   此时它给出的任何绿都是空的(同 G10 要求 `walked > 0` 的理由)
3. **A8.2 落地时发现 `client-core` 需要自己发事件才能正确渲染**——那说明它不是 Host 的镜像,
   而是第二个控制平面。**停下来重新裁决分层,不要继续往下堆状态**
4. **611 的 review 结论要求改动投影边界本身**——A8.3 与 A8.2 的接线点会移位,重新对齐后再动
