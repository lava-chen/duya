# 02 — 切片 A0:客户端与运行时轴(一个核心如何同时驱动 CLI / Web / Desktop)

> **本文件即 A0 切片的契约。** A 线按"执行归属"排序,但**包结构本身**能不能同时服务
> 三个客户端,是一件独立的事,必须在动 S5(六包迁移)之前定死。
> 本文给出实测基线、判定,并给出最小可行的最优结构。

## 0. 结论

**600 §3 的六包划分不算错,但它是"按领域"分的,没有"运行时"这一轴,
所以它无法回答"能不能同时驱动 CLI / Web / Desktop"这个问题。**
而答案目前是**不能**,原因不在六包本身:

| 缺口 | 实测 |
| --- | --- |
| **`apps/web` 根本不存在** | `apps/` 下只有 `desktop`(1512 个 ts/tsx) |
| **共享 UI 没有可寻址的入口** | `conductor` 102 个文件 0 个 Node 内建(已同构),但 `exports` 只有 `.` 和 `./ipc`,**没有 `./renderer` 子路径** |
| **renderer 已经在拖 Node 进来** | `plugin-types.ts` / `useContextUsage.ts` 从 `@duya/plugin-core`、`@duya/ai` import **值**(zod schema、函数),而这两个包分别有 5 个和 1 个文件碰 `node:fs` / `node:net` / `node:crypto` |

第三条是关键:桌面 renderer 今天能跑,只是因为 **Electron 的 renderer 带 Node**。
把同样的代码搬进浏览器就会炸。**所以"能不能有 Web"目前不是一个未做的新功能,
而是一个被现有耦合卡住的既有事实。**

## 1. 运行时轴:四个上下文,不是三个客户端

"同时驱动三端"只有一个自洽的读法:**一个 Node 控制平面,三个薄客户端**。
不是三个运行时各加载一遍同一批包 —— 只要某个包碰 FS/SQLite/进程/子进程,这条路就不成立。

| 上下文 | 运行时 | 能加载什么 |
| --- | --- | --- |
| CLI | Node | 全部 Node |
| Desktop `main` | Node + Electron | 全部 Node + electron |
| Desktop `renderer` | Chromium(**没有** FS/子进程) | 仅浏览器安全子集 |
| Web | 浏览器 | 仅浏览器安全子集 |

于是设计要回答的是两个不同的问题,600 §3 把它们混成了一个:

1. **控制平面里放什么** —— 600 §3 的 `capabilities` / `connectors` / `memory` / `tooling` / `data`(全部 Node-only)。**这一半 600 是对的。**
2. **客户端之间共享什么** —— 协议类型 + 共享 UI + 浏览器安全的模型元数据。**这一半 600 只有一个 `ui`,而且它今天没有可寻址的入口。**

## 2. 建议的分层

不新增领域包,只把运行时能力显式化。**分层是"能不能被浏览器加载"的判据,不是目录美学。**

| 层 | 运行时 | 装什么 | 今天的状态 |
| --- | --- | --- | --- |
| **L0 协议** | 任意 | 类型、事件、线上格式 | `@duya/agent-protocol`(32 文件 / 0 Node)✅ 已同构 |
| **L1 纯计算** | 任意 | 无 IO 的核心计算 | `@duya/agent-core`(5 文件 / 0 Node)✅ 已同构 |
| **L2 客户端共享** | 浏览器安全 | 共享 UI 组件、zod schema、模型元数据 | **❌ 不存在**(最接近的是 `conductor`,但没有子路径) |
| **L3 宿主** | Node-only | `capabilities` / `connectors` / `memory` / `tooling` / `data` | 尚未建包(600 §3) |

**L3 由谁执行:控制平面。** 客户端只**触发**,不执行 —— 这条必须在
`capabilities` 的合同里写死,否则 web 端会去想要"本地 Browser / ComputerUse"而那是不可能的。
Desktop main 与 CLI **进程内**加载 L3(不绕 HTTP),Web 走 HTTP。**同一个 L3 驱动两端,第三个走线上。**

## 3. 三处必须先拆的耦合

### 3.1 `@duya/ai` 差一个文件

95 个文件里只有 `api/bedrock-converse.ts` 碰 `node:crypto`(算签��)。
把它挪走或把 `crypto` 变成注入的依赖,`@duya/ai` 立刻 100% 浏览器安全,
而 renderer 现在就想用它的 `findModelById` / `resolveContextWindow` / `computeContextEstimate`。
**这是投入产出比最高的一处。**

### 3.2 `@duya/plugin-core` 必须二分为 schema 与 loader

浏览器要的是**类型与 schema**(`WorkflowTemplateSchema`、`PluginTrustLevel`、provider tool 策略),
不要的是**加载器**(`mcp/resolve`、`plugins/loader/capability-discovery`、
`security/path-validator`、`marketplace/source-parse` —— 这 4 个碰 `node:fs` / `node:net`)。

拆成:

- `@duya/plugin-schema` —— 类型 + zod,**同构**,renderer 与 web 消费它
- `@duya/plugin-core` —— 加载器,**Node-only**,留在控制平面

renderer 现在那 8 处 `plugin-core` import 全部改指 schema,浏览器即可成立。

### 3.3 `conductor` 要有 `./renderer` 子路径

`conductor` 已经 0 个 Node 内建 —— **它已经是同构的,只是没法被浏览器 import**。
`exports` 补上 `./renderer` 并让它指向浏览器安全的产物,共享 UI 的载体立刻存在。
**这一处是纯增量:不需要迁代码,只需要让已有代码可寻址。**

## 4. 让"能驱动 Web"成为可证明的断言

现在没有任何机制能证明某个包是浏览器安全的 —— 它取决于**入口的 import 闭包**,
不是取决于包本身。所以:

> **门禁 G10:从浏览器入口出发的 import 闭包,不得含 Node 内建。**

- 入口:未来的 `apps/web/src/main.tsx` 与 `apps/desktop/src/renderer/`。
- 闭包:沿**值 import**展开(与 `import-graph.mjs` 同一套解析,复用而不是重写)。
- 判定:闭包里出现 `node:fs|path|os|child_process|net|crypto|sqlite|worker_threads|...` 即红。
- **必须能变红**:把 `security/path-validator.ts` 挂到 renderer 的 import 链上,确认它红。

这条门禁的价值在于:它把"我们支持 Web"从一句产品愿望变成**每 PR 都在检查的事实**。
没有它,下一次有人从 renderer import 一个 loader,不会有任何东西变红。

## 5. 这对 610 切片表的影响

| 原切片 | 变化 |
| --- | --- |
| **A5**(六包迁移) | 之前只迁 L3。新增前置:**先做 §3 的三处拆分**,否则迁出来的 `capabilities` 会被 web 侧误当可用 |
| **B2**(控制平面倒置) | 不变,但 §1 的"CLI/main 进程内、Web 走 HTTP"必须写进合同 |
| 新增 **A0** | §3 的三处拆分 + G10 门禁。**可与 A1 并行**,不依赖执行归属改造 |
| **B1** | 不变(仍是 6 个 handler 的 Electron 依赖) |
| **C1**(602) | 无关 |

> **A0 是本系列里唯一"不做架构改造也能做"的一片**,产出是让 Web 从"被耦合卡住"
> 变成"差一个 `apps/web` 骨架"。建议与 A1 并行启动。

## 6. 明确不做

- 不为了让 Web 成立而把 Node 侧包 polyfill 成浏览器可用 —— 那等于把 `node:fs` 拖进浏览器包。
- 不做"三端各加载一遍同一批包"的方案 —— 碰 FS/进程/SQLite 的包无解。
- 不在 L2 里放任何编排逻辑。**L2 是呈现,不是控制。**
