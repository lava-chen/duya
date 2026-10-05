# 01 — Phase A:脱离 Electron

> **让 104 条路由跑在没有 Electron、没有桌面环境的机器上。**
> 本阶段**不新增抽象、不改架构**,只拆掉两个 Electron 硬依赖。

## 0. 为什么 Phase A 值得先做

104 条路由 + bearer 鉴权 + 运行时发现文件**已经存在**
([00 §0](00-contracts.md#0-实测基线) 第 3-6 条)。一个可部署的控制平面
需要的骨架已经齐了,只差:

1. 6 个 handler 在**模块加载期**硬 import `electron.app`
2. `boot-config.ts` 的数据库目录靠 `app.getPath('userData')`

**这两项加起来是替换,不是设计。** 同一目录里已有 6 个正确写法可抄
([00 §0](00-contracts.md#0-实测基线) 第 2 条)。

**风险等级:低。** 没有新概念,没有新文件,没有跨层改动。

---

## 1. 唯一 next action

按顺序做,每步一个提交:

1. **A1** — 写门禁 A1(见 [§3](#3-门禁)),确认它**现在是红的**
2. **A2** — 6 个 handler 改成软 require
3. **A3** — `boot-config.ts` 脱离 `app.getPath`
4. **A4** — `agent-server-lifecycle.ts` 抽成宿主无关
5. **A5** — `duya serve` 入口 + 落地证据

> **纪律:门禁先写,且先证明它红。** 见 [§6](#6-变异证明怎么做)。

---

## 2. 工作项

### 2.1 A2 — 6 个 handler 改成软 require

**现状**(硬 import,加载期就炸):

```
handlers/backup.ts:17    handlers/extra.ts:24     handlers/extra2.ts:23
handlers/security.ts:19  handlers/status.ts:18    handlers/update.ts:20
```

**目标写法**:与 `handlers/config.ts:92` 一致 —— `require` 包在 try/catch,
拿不到 `app` 时回落到 `~/.duya`。

```ts
// Pattern reference: handlers/config.ts:92
let appPath: string | undefined;
try {
  const { app } = require('electron');
  appPath = app.getPath('userData');
} catch {
  appPath = path.join(os.homedir(), '.duya');
}
```

**必须复用已有的环境变量覆盖** `DUYA_CLI_USER_DATA_DIR`
(`handlers/plugins.ts:170`)。这是既有的无桌面运行入口,**不要另造一个。**

**逐项确认这 6 个各自需要 `app` 做什么**,不要照抄 —— 有的可能只要
`getPath`,有的可能碰 `getVersion`。凡是需要 `app` 独有能力的
(`dialog`、`safeStorage`、窗口),**那个能力在无桌面环境就没有对应物**,
必须显式返回"不支持",不能静默降级。

> `status.ts` 额外拉了 `db/connection.ts:13`(自身也硬 import `app`)。
> 这一条是 A3 的真正入口 —— 见 §2.2。

### 2.2 A3 — `boot-config.ts` 脱离 `app.getPath`

```
config/boot-config.ts:15      import { app } from 'electron';
config/boot-config.ts:31      path.join(app.getPath('userData'), 'databases')
config/boot-config.ts:51-52   legacy 迁移路径同样依赖
```

**真相来源不是 `boot.json`。** `boot-config.ts:5` 明确:
"boot.json is gone (plan 334, decision 6)",路径现在在
`~/.duya/config.toml` 的 `[storage].database_path`。
**而 sessions / attachments 早就用 `os.homedir()/.duya` 了。**

所以 A3 是把**数据库目录也归到同一条已存在的无桌面路径规则**,
而不是发明新规则。legacy 迁移(:51-52)同样要回落。

**`db/connection.ts:13` 的 `import { app }`** 与 boot-config 是同一个
问题,一起改。

### 2.3 A4 — Agent Server 抽成宿主无关

**这一项比预想的简单得多,而且预想的方案是错的。**

先说**不要做什么**:不要为 Agent Server 造新的 DB 通道。
`agents/server/index.ts:195` 那句
`reject(new Error('process.send not available — not running as child_process'))`
看起来像"必须换通道",但它只在**没有父进程**时才触发。

> **只要控制平面把 Agent Server 作为子进程拉起来,`process.send` 那条
> DB 通道原样成立。** headless 控制平面本身就是一个真实的父进程。

真正的宿主耦合只有两行:

```
apps/desktop/src/main/agents/agent-server-lifecycle.ts:119   command = process.execPath;
apps/desktop/src/main/agents/agent-server-lifecycle.ts:121   env.ELECTRON_RUN_AS_NODE = '1';
```

- **`:119`** 在纯 Node 下 `process.execPath` **本来就是 node 可执行文件** ——
  正是我们要的
- **`:121`** `ELECTRON_RUN_AS_NODE` 在 node 下无害,但应由宿主决定是否设置
  (`:85` 的注释也要一起改,否则下一个人会按注释得出错误结论)

**做法:把"用什么可执行文件 + 什么 env"变成宿主传入的参数。**
Electron 宿主传 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`,
headless 宿主传 `process.execPath` + 不设该变量。

> **A4 是本阶段唯一的接口改动。** 做完它,Electron 与 headless 共用
> **同一个** Agent Server 启动路径 —— 这正是[00 §1.2](00-contracts.md#12-runtime运行时)
> 要求的"三种形态共用同一个 runtime 实现"的第一步。

### 2.4 A5 — `duya serve` 入口

在 `apps/server/` 建 headless 控制平面,提供 `serve` 入口。

- 复用 `cli-api-server.ts` 的路由与鉴权,**不重写**
- 绑定地址:默认 `127.0.0.1`;非本机必须**显式开启**,并按
  [00 §4](00-contracts.md#4-安全纪律) 处理 TLS / 隧道
- 运行时发现文件沿用 `{port, token, pid}` 形状
  (`cli-api-server.ts:9`),**但路径不能在 `userData` 下** —— 那是 Electron 概念
- 静态托管 `apps/web/dist` 走 ZCode 那个单端口模式
  (`packages/server/src/http.ts:399-416`:同进程托管 API + 静态资源,
  未命中回退 `index.html`)

---

## 3. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| **A1** 控制面可脱离 Electron 加载 | 见 §3.1 | 加回一个 `import { app } from 'electron'` |
| **A2** 数据库路径不需 Electron | 无 Electron 时能解析出 DB 绝对路径 | 删掉 `~/.duya` 兜底分支 |
| **A3** Agent Server 启动路径宿主无关 | 同一启动函数在两种宿主下都成立 | 把 `ELECTRON_RUN_AS_NODE` 写死回去 |

### 3.1 A1 必须是行为门禁,不能只有静态检查

**静态名字扫描不够。** 600 的 G4 就是这么失效的:它扫 `DuyaAgent` **名称**,
识别不了中间函数绕回旧循环(600 `README.md` §5.1「已知盲区」表的 **G4** 行,
600 计划文档目前未跟踪,行号会漂,故此处按小节引用)。
**同一个仓库已经为这个模式付过一次学费。**

所以 A1 分两层,**两层都要**:

**A1a — 静态,可达性闭包。**
从 server 入口走 value-import 闭包,闭包内**不得**出现
`import ... from 'electron'` 的**静态** import 形式。
- 今天:红,6 个文件
- 变异:在任一 handler 加 `import { app } from 'electron'` → 变红

**A1b — 行为,真加载。**
子进程里让 `require('electron')` **抛异常**,然后真去加载完整 handler 图,
断言它加载成功。
- 子进程内 patch `Module._load`(或等价的解析钩子),命中 `'electron'` 即抛
- 硬 import 的模块在**求值期**就会抛 —— 正是今天的行为
- 软 require 的 6 个 handler 会走进自己的 catch,应当正常加载
- 变异:把任一 handler 改回硬 import → 变红

> **A1b 是唯一能证明"真的能脱离 Electron 跑"的门禁。**
> A1a 只是它的快速前置。**只有 A1a 变绿而 A1b 没写,视为 A1 未完成。**

### 3.2 拒绝恒等式断言

断言里出现 `a === a` 形状的比较就是红旗 —— 拿测量值比测量值、
拿自己比自己,永远通过。**比较的两个量必须来自不同来源:**
声明 vs 实测、预期 vs 真实输出。

A1b 的正确形态是"**真的把模块图 load 起来了**"或"**真的抛了**",
不是"扫描结果条数 == 扫描结果条数"。

---

## 4. 文件所有权(与 600 无冲突)

| 本阶段动 | 600 动 |
| --- | --- |
| `apps/desktop/src/main/cli/handlers/**`(6 个文件) | agent 循环、Session schema |
| `apps/desktop/src/main/config/boot-config.ts`、`db/connection.ts` | RunEngine 端口 |
| `apps/desktop/src/main/agents/agent-server-lifecycle.ts`(宿主参数) | `packages/agent-runtime/**` 内部 |
| `apps/server/**`(新建) | — |

**没有一行重叠。** 这是 Phase A 能与 600 并行的依据
([README §6.1](README.md#61-为什么-a-不必等-600))。

---

## 5. 本阶段明确不做

| 不做 | 理由 |
| --- | --- |
| 统一 renderer 的 IPC 契约 | 那是 Phase B;600 未落地的形状不能提前焊死 |
| 改 `cli-api-server.ts` 的 104 条路由语义 | 路由是资产,不是债 |
| 造 Agent Server 的新 DB 通道 | `process.send` 在有父进程时成立(§2.3) |
| 放行跨 runtime 访问 | 那是 Phase C 的 C2,且需要授权模型 |
| 让 600 的任何门禁变绿 | 门禁是事实报告,不是待办清单 |
| 建 `apps/web` 的完整 UI | Phase A 只要求能托管静态产物 |

---

## 6. 变异证明怎么做

600 的纪律([README §7](README.md#7-门禁每条都要能变红)):

1. 制造该门禁要防的那种回归
2. 确认**它变红**
3. **完全回退**
4. 确认工作树干净

**A1b 的具体步骤:**

```bash
# 1. 在任一 handler 临时加回硬 import
# 2. 跑 A1b → 必须红
# 3. 撤掉
# 4. 跑 A1b → 必须绿,且 git status 干净
```

**跳过这一步的门禁不算存在。** 600 的教训:587 的门禁"报告事实却不检查
任何东西",比红测试更危险 —— 它让后续切片相信某性质已被守住。

---

## 7. 完成标志

> 按 600 的教训:**"文件改完了"不是落实。**

Phase A 完成 = 同时满足:

1. **A1a + A1b 都绿**,且各自做过变异证明
2. `duya serve` 在**没有 Electron、没有桌面环境**的机器上启动成功
3. **104 条路由从远端实际调用过至少一条真实路径**
   —— 不是"路由表列出来了",是**真有一次远端请求拿到正确响应**
4. 数据库指向显式配置的路径,**不是** `app.getPath` 的隐式结果
5. Agent Server 在 headless 下起来并**真的执行了一个 run**
6. Electron 桌面路径**没有因此变坏** —— 原路径仍能启动

第 3 条和第 5 条是行为证据。**缺任何一条,Phase A 就是"改造完成"而不是"能力可用"。**
