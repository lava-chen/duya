# 90 — 执行日志

> 每轮追加。**数字必须带 scope**(格式 `<通过>/<总数> in <scope>`)。
> 裸数字不接受 —— 脱离 scope 的数字不可判读。

---

## 2026-10-05 — 计划撰写轮

### 本轮性质

**纯计划文档。** 未改任何生产代码,未运行 `typecheck` / `npm test` / build,
未执行任何门禁(门禁还没写),未 commit 生产代码。

### 事实基线:`origin/master @ 46c36d9d`

所有引用均在此 SHA 上实测。**本轮特意没有用本地工作树。**

**为什么不用:** 本地 `master` 落后 `origin/master` 30 个 commit
(本地 `135901bf`,`git rev-list --left-right --count origin/master...HEAD`
= `30  5`)。S0 门禁代码尚未落地,若在本地树上分析,
会得出"G1–G9 无任何可执行实现"的错误结论。

> **这个坑差点写进计划。** 探查报告实测
> `scripts/architecture/boundary-gates.mjs` 不存在、`findReverseEdges` 等函数
> 只出现在 markdown 里 —— **在本地树上这是事实**。
> 复核发现该文件在 `origin/master` 上存在(4 个文件齐全:
> `.mjs` / `.ts` / `.test.ts` / `-baseline.json`),`46c36d9d` 正是
> origin/master 的 tip。
>
> **教训:探查报告的"不存在"结论必须问"在哪棵树上不存在"。**
> 同一仓库里 `vacuous-guard-tells` 记的"守卫报告事实却不检查任何东西"
> 是同一类错误的另一面 —— **这次是反的:树是旧的,不是守卫是假的。**

### 实测清单(全部 `46c36d9d`)

| # | 断言 | 实测方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 6 个 CLI handler 硬 import `electron.app` | `Select-String "from 'electron'"` over `handlers/*.ts` | `backup.ts:17` `extra.ts:24` `extra2.ts:23` `security.ts:19` `status.ts:18` `update.ts:20` |
| 2 | 同目录 6 个 handler 已软 require | 同上,`require('electron')` 形态 | `config.ts:92` `crons.ts:140` `gateway.ts:58` `mcps.ts:92` `plugins.ts:174` `skillWrite.ts:33` |
| 3 | 客户端 API 路由数 | `parts[0] ===` 匹配计数 | **104**,文件 **979** 行 |
| 4 | 鉴权在路由前 | 读 `cli-api-server.ts:158` | `checkBearer` |
| 5 | 绑定 | 读 `:931` | `listen(0, '127.0.0.1')` |
| 6 | `agents/server/**` 无 electron | 递归 Select-String | 24 个 `.ts`,**真实 import 0**;命中 2 条是 `router.ts:112,160` 的**禁令注释** |
| 7 | `agent-runtime` 无 electron | 递归 Select-String | **0** |
| 8 | Agent Server 的 DB 通道 | 读 `index.ts:190-195` | 只走 `process.send`;`:195` 非子进程直接 reject |
| 9 | Agent Server 启动的宿主耦合 | 读 `agent-server-lifecycle.ts:119,121` | `process.execPath` + `ELECTRON_RUN_AS_NODE='1'` |
| 10 | `boot.json` 是否还在 | 读 `config/boot-config.ts:5` | **已退役**(plan 334),真相是 config.toml `[storage].database_path` |
| 11 | `contracts/` 现状 | 目录列举 | 3 文件;`git.ts` / `import.ts` 零 import |
| 12 | 门禁是否真实存在 | `git ls-tree origin/master -- scripts/architecture/` | **存在** 4 文件 |
| 13 | `packages/**` 禁令 | 读 `architecture-policy.yaml:162-169` | 禁 `electron/**`、`src/**`、`apps/desktop/**` |

### 本轮推翻的一个中间结论

初判(来自探查报告):"Agent Server 的 DB 只走 `process.send`,这是
**唯一一处结构性改动**,需要新通道。"

**复核后推翻。** `index.ts:195` 的 reject 只在**没有父进程**时触发。
headless 控制平面本身就是真实父进程,把它作为子进程拉起
(`agent-server-lifecycle.ts:119` 在纯 Node 下 `process.execPath` 就是 node),
`process.send` 通道**原样成立**。

> **A4 因此从"造新通道"降级为"抽两个宿主参数"。**
> 这是本轮最有价值的一次修正 —— 它把一个看起来很大的结构改动
> 变成一个 2 行的接口改动。
>
> **教训:读到一个"必须换掉 X"的报错时,先问"X 在什么条件下不成立"。**
> 条件不成立的话,不需要换。

### 自检抓到的一个真错误:`Measure-Object -Line` 把空行算成 0

计划写完后,把**每一个 `path:line` 引用**拿去和真实文件对账,抓到:

```
OUT-OF-RANGE  cli-api-server.ts : 931  (real file has 841 lines)
```

`:931` 是 `server!.listen(0, '127.0.0.1', ...)`,**它确实存在**(Select-String 找到)。
矛盾点在于:同一个文件我既量出 841 行,又找到 931 行的内容。

**根因:`Get-Content | Measure-Object -Line` 把空行计为 0 行。**

| 度量方式 | 结果 |
| --- | --- |
| `(Get-Content $f).Count` | **979** |
| `Get-Content $f \| Measure-Object -Line` | **841** |
| 差值 | 138 = 该文件的空行数 |

**我把这个错数字写进了三份文件**(README §3.6、00-contracts §0、90 本表),已全部更正为 979。

> **教训:量行数不要用 `Measure-Object -Line`。** 用 `(Get-Content $f).Count`。
>
> **这是"报告绿却不检查任何东西"的变种 —— 一个看起来是实测的数字,
> 实际来自一个有已知缺陷的度量。** 危险之处在于它**不像**编造的数字:
> 它确实来自一次真实执行,只是执行方式是错的。
>
> 判据:**当两个独立测量互相矛盾时,不要挑一个顺眼的相信,
> 去查为什么矛盾。** 本例的矛盾(841 < 931)正是发现度量缺陷的信号 ——
> **差异本身是线索,不该被解释掉。**
>
> 这也是本次自检的全部价值:对账 33 条引用命中,抓到 1 个真错误。
> 若不做对账,这个 841 会跟着计划进 PR,然后被人引用成"实测基线"。

### 外部事实核实(带来源)

| 断言 | 来源 |
| --- | --- |
| 微信小程序无原生 `EventSource`;`wx.request` 不暴露流 | [稀土掘客](https://juejin.cn/post/7656681358269710379)、[CSDN 问答](https://ask.csdn.net/questions/8229869) |
| `wx.connectSocket` 是官方推荐实时方案 | 同上 |
| `enableChunked` 模拟 SSE 被普遍标注不推荐 | [CSDN](https://blog.csdn.net/m0_53956340/article/details/150845428) |
| 长期存在 → 需 polyfill | [miniprogram-fetch-stream](https://github.com/baoxingzeng/miniprogram-fetch-stream) |

**这条核实改变了 Phase B 的一个决定。** [02 §8](02-client-unification.md#8-传输先不抽象)
原写"SSE 足够,暂不抽象传输层";小程序无 SSE,意味着 **Phase C 必须上 WebSocket**,
恰好触发 02 §8 自己写的触发条件。原则没变,时点被平台事实提前了。

### 本轮的陷阱:工作树陷阱(又一次)

本地共享检出有 9 项未提交改动,其中
`scripts/architecture/layer-purity.ts` 与 `layer-purity.test.ts`
与 `origin/master` 的同名文件**双向都有差异**(工作树 vs 上游:
`+155/-101` 与 `+382/-2`)。**硬合并必然冲突。**

按用户决策:**在 worktree 里基于 `origin/master` 写,共享检出零改动。**
worktree:`.claude/worktrees/601-headless-control-plane`,分支
`docs/601-headless-control-plane`,base `origin/master @ 46c36d9d`。

> 符合 `AGENTS.md` 的 Worktree → PR 流程:"An isolated session must not
> edit the shared checkout."
> 本轮是纯文档任务,不需要 `node_modules`、不需要 tsc/vitest,
> 因此 **worktree 的 junction 坑未触及**。

### 未决

| # | 问题 | 归属 |
| --- | --- | --- |
| 1 | ~~**600 的 11 份计划文档不在任何分支上。**~~ **已解决 —— 这条结论是错的。** 文档一直在 `docs/600-plan-archive`(1 ahead / 0 behind),并已于 2026-10-05 随 PR #218 落回 master 的 `active/600-layered-architecture/`。当时只查了 `origin/*` 与工作区,没查本地分支 | **已关闭**,见 [610 §3.1](../610-architecture-series/README.md) |
| 2 | Agent Server 真实路由数未数清。只确认了 `router.ts` 的顶层 `parts[0]` 谓词,子 handler 内路由未统计。**6 是下限不是总数** | Phase A 开工前补 |
| 3 | 6 个硬 import handler 各自需要 `app` 做什么未逐项确认(可能只需 `getPath`,可能碰 `getVersion`/`dialog`) | Phase A §2.1 |
| 4 | 客户端 bearer 单进程共享(`cli-api-server.ts:158`)在多节点下不可沿用 | Phase C §2.2 |
| 5 | **控制平面被断开时,已在跑的 run 如何处理**(中止?继续?孤儿?)| Phase C,必须**实现前**定 |
| 6 | 104 条路由中 IPC 与 HTTP 的实际重叠数未盘点 | Phase B §3,决定工作量 |

### 门禁实测

**本轮无。** G1–G9 由 600 S0 提供(已合并),本系列自己的 8 条门禁
(A1/A2/A3/B1/B2/C1/C2)在本轮**尚未写**,状态见
[README §7](README.md#7-门禁每条都要能变红)全部"待做"。

> **按 600 的纪律,门禁合入前必须变异证明。**
> 本系列门禁中,A1 最关键 —— 它精确对应今天真实存在的缺陷,
> 且现在就是红的。B2 有一条明确的反面教材:
> 600 的 `LEGACY_RETIREMENT` 测试拿 `measured.length` 比 `measured.length`,
> 声明 7 实测 3 也永远通过。**比较的两侧必须来自不同来源。**

### 下一步

[01 §1](01-headless-control-plane.md#1-唯一-next-action) 第 1 项:
**写门禁 A1,并证明它现在是红的。**
