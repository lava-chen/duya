# 00 — 合同

> 三角色定义、依赖方向、边界纪律。**本文件是唯一权威。**
> 其他阶段文件与本文件冲突时,以本文件为准。
>
> **管辖范围(2026-10-05 裁决):本文件是"进程与网络边界"的唯一权威,不是"层与依赖方向"的权威。**
> [600 的 `00-contracts.md`](../600-layered-architecture/00-contracts.md)同样自称"唯一权威",管的是层、
> 允许依赖、反向边、门禁 G1–G9,以及"模块该进 `apps/` 还是 `packages/`"。两份文件的关系现在写死:
>
> | 维度 | 权威 | 本文件是否管 |
> | --- | --- | --- |
> | 进程边界(控制平面是否独立成进程) | **本文件** | ✅ |
> | 网络边界(客户端契约、鉴权、runtime 注册、心跳) | **本文件** | ✅ |
> | 层、允许依赖、反向边、门禁 G1–G9 | [600](../600-layered-architecture/00-contracts.md) | ❌ |
> | 模块归属 `apps/` vs `packages/` | 600 §A.2b | ❌ |
>
> **不越界声明(双向):**
> - **本系列不发明分层,也不修改 600 的依赖禁令。** 本文件 `README.md` 已自陈"这条边界直接来自
>   600 的 CP / Runtime 分层 —— 601 不发明分层,只给它进程边界和网络边界"。
> - **600 不规定进程拓扑。** 600 合同 §A.4 早已写了这条原则:"Runtime 包可以在 worker 进程执行,
>   server 负责管理。**不要因为'它要跑在另一个进程'就把它挪进 host 包。**" 本系列正是把这条原则
>   用到了控制平面自身 —— 那是本系列的自由度,不是对 600 合同的修改。
>
> 出现分歧时的处理:**改本文件前先看 600 `00-contracts.md`,反之亦然。** 两边对同一件事各写一句
> 而不互引,就是下一次漂移的开始。本次裁决的另一半(600 侧)见 [600 合同抬头](../600-layered-architecture/00-contracts.md)。

## 0. 实测基线

全部在 `origin/master @ 46c36d9d` 测得,2026-10-05。文件数与匹配数都是
实测值,不是估计值。

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 6 个 CLI handler 在**加载期**硬 import `electron.app` | `handlers/backup.ts:17`、`extra.ts:24`、`extra2.ts:23`、`security.ts:19`、`status.ts:18`、`update.ts:20` |
| 2 | 同目录 6 个 handler 已是软 require + 兜底 | `config.ts:92`、`crons.ts:140`、`gateway.ts:58`、`mcps.ts:92`、`plugins.ts:174`、`skillWrite.ts:33` |
| 3 | 客户端 API 有 104 条路由,`/v1/*` | `cli-api-server.ts` **979 行**,`parts[0] ===` 匹配 104 |
| 4 | 鉴权在路由前强制 | `cli-api-server.ts:158` `checkBearer` |
| 5 | 绑定随机端口,仅本机 | `cli-api-server.ts:931` `listen(0, '127.0.0.1')` |
| 6 | 运行时发现文件 | `cli-api-server.ts:9` `userData/runtime/cli-api.json` |
| 7 | Agent Server 无真实 electron import | `agents/server/**` 24 个 `.ts`,仅 `router.ts:112,160` 两条**禁令注释** |
| 8 | Agent Server 的 DB 只走 `process.send` | `agents/server/index.ts:190-191`;`:195` 非子进程直接 reject |
| 9 | `agent-runtime` 零 electron import | `packages/agent-runtime/src/**` 匹配 0 |
| 10 | 已有独立鉴权 HTTP+SSE 服务器 | `http-sse-transport.ts:183`,bearer `:211-215`,origin `:219` |
| 11 | `boot.json` 已退役,真相是 config.toml | `config/boot-config.ts:5`;DB 目录 `:31` 仍依赖 `app.getPath` |
| 12 | `contracts/` 真 browser-safe 但很窄 | 3 文件;`git.ts` / `import.ts` 零 import |
| 13 | `packages/**` 禁止依赖 host | `architecture-policy.yaml:162-169` |

---

## 1. 三个角色

### 1.1 Control Plane(控制平面)

**拥有身份与记录,不执行。**

- 拥有:用户身份、Session、Project、Goal、Task、Run 的**记录**
- 拥有:调度决策、审批状态、唤醒条件、对外 API 的鉴权
- **不**拥有:工作区内容、工具凭据、LLM 会话、执行循环

**唯一实例**(或一个集群)。今天这个角色由 Electron main 兼任 ——
那是本系列要拆掉的东西。

判据一句话:**控制平面被杀掉,已存在的记录还在;正在跑的 run 丢失。**
反过来如果 run 能靠记录恢复,那么执行器就属于控制平面,划分错了。

### 1.2 Runtime(运行时)

**执行 run,持有工作区。**

- 拥有:工作区文件系统、工具凭据、shell / browser / computer-use 的实际能力
- 执行:RunEngine 循环、工具调用、流式输出
- 注册到控制平面,上报心跳
- **不**拥有:身份决策、跨节点调度、别的节点的记录

**每个注册节点恰好一个。** 三种形态共用同一个接口:

| 形态 | 宿主 | 用途 |
| --- | --- | --- |
| 本机 runtime | Electron 宿主 | 桌面使用 |
| 本机 runtime | CLI 宿主 | headless / CI |
| 远端 runtime | 用户电脑 | **远程监控** |

> **三种形态必须是同一个 runtime 实现。** 如果远端那套是第二种实现,
> 它就是一个待分裂的重复实现 —— 门禁 C1 拦它。

### 1.3 Client(客户端)

**呈现界面,发指令。不可信。**

- 只经由控制平面的 API 访问记录
- **不**执行 run、**不**碰工作区、**不**持有工具凭据
- 同一时刻可有多个,互不影响

四种形态:

| 形态 | 载体 | 备注 |
| --- | --- | --- |
| Electron renderer | 桌面应用 | 今天走 IPC,Phase B 收敛到 HTTP 契约 |
| CLI | `@duya/cli` | 今天已经是 HTTP 客户端 |
| `apps/web` | 浏览器 | 新建 |
| 小程序 | 微信小程序 | 裁剪契约,见 [03](03-remote-runtime.md) |

**客户端是唯一"数量无限"的角色。** 任何需要"只有桌面能做"的能力,
说明它被错放进了客户端。

---

## 2. 依赖方向(不可逆)

```text
Client ──HTTP/SSE(契约 DTO)──▶ Control Plane ◀──注册/心跳── Runtime
                                    │                          │
                                    └──禁止──▶ 工作区 / 凭据    └──▶ 工具能力
```

| 上层 | 可以依赖 | 禁止 |
| --- | --- | --- |
| Client | 契约 DTO(类型) | 控制平面内部实现、runtime、工作区 |
| Control Plane | 契约 DTO、repository port | **runtime 实现**、workspace、工具 |
| Runtime | core / protocol / 能力包 | control plane 的**决策逻辑**、其它 runtime |

**三条硬边:**

1. **控制平面不得 import runtime 实现。** 600 的分层已禁止
   (`00-contracts.md:19` "让下层回 import host 实现"),本系列不放宽。
2. **客户端不得绕过控制平面直连 runtime。** 唯一例外是本机同宿主,
   且那条路径必须收敛 —— 否则又变成两套形状(门禁 B2)。
3. **契约不得含实现类型。** 见 §3。

---

## 3. 契约纪律

客户端契约 **= browser-safe DTO**。判据已经存在且在跑:
`contracts-boundary.test.ts:59`(禁 electron / node 内建 / DOM / host)、
`:84`(只类型,无运行值)、`:102-129`(main、preload、renderer 三方都能引)。

本系列的要求是在此之上加两条:

1. **契约按角色分层,不按 UI 分层。** 小程序和浏览器共享同一个 DTO,
   小程序只是**允许读到的子集更小**。不允许为小程序另造一套形状。
2. **契约里的每一个字段都要有真实消费者。** 没有消费者的字段是负债,
   不是预留。

> 现有 `contracts/` 只有 `git.ts` / `import.ts` 两个词汇表,是真东西但很窄。
> **Phase B 的任务是把 HTTP 契约长成真正的客户端契约层,不是把 `contracts/`
> 改造成别的东西。**

---

## 4. 安全纪律

远程能力一旦成立,以下不是"以后加",是 Phase C 的准入条件:

| 项 | 要求 | 今天的状态 |
| --- | --- | --- |
| 绑定地址 | 默认 `127.0.0.1`,非本机必须显式开启 | ✅ 已是(`cli-api-server.ts:931`) |
| 传输 | 远程访问必须有 TLS 或等价隧道 | ❌ 无,明文 HTTP |
| 鉴权 | 每个客户端 / 每个 runtime 独立可撤销身份 | ⚠️ 客户端有 bearer(`:158`);runtime 无 |
| 授权 | 跨 runtime 读取必须被拒 | ❌ 未实现 |
| 凭据 | 工具凭据永不下发给客户端 | ✅ runtime 侧,须保持 |

**ZCode 的教训值得直接记住:** 它的 token 只保护 `/ws` 与 `/api/*`,
且**明文无 TLS**,假定走 SSH 隧道 / 反代
(`packages/server/src/http.ts:236-238`)。**照抄那个形态之前先决定你的暴露面。**

---

## 5. 放置规则

| 东西 | 放哪 | 判据 |
| --- | --- | --- |
| 控制平面 | `apps/server/` | app —— 没有包外消费者 |
| 浏览器客户端 | `apps/web/` | app |
| 客户端契约 | `apps/desktop/src/contracts/`(Phase B 后扩) | 三方共用,已被三方边界测试守住 |
| 共享 UI 组件 | `packages/ui/` | 有包外消费者 → 才进 `packages/` |
| runtime | `packages/agent-runtime/` | 已是,本系列不搬 |

**为什么控制平面不能进 `packages/`:** `architecture-policy.yaml:162-169`
禁止 `packages/**` 依赖 `apps/desktop/**`,而控制平面必须触达
`apps/desktop/src/main/cli/handlers/**`。这条边一旦建立就是违规。

**为什么 `apps/server` / `apps/web` 不撞门禁:** 二者都在
`architecture-policy.yaml` 的所有 declared root 之外,而
`architecture-check.mjs:186-187` 对未分类目标默认放行。
**这不是"门禁没覆盖到"的漏洞 —— 放行是策略,加 root 才是决定,得走评审。**

---

## 6. 阶段与判定

| 阶段 | 门禁 | 通过判据 |
| --- | --- | --- |
| A | A1 / A2 / A3 | `duya serve` 在无 Electron 环境启动,104 路由远端可达 |
| B | B1 / B2 | renderer 与 CLI 调同一契约,能力 N 无双形状 |
| C | C1 / C2 | 远端 runtime 可注册 / 被监控;越权被拒 |

**每条门禁合入前必须做变异证明。** 详见 [README §7](README.md#7-门禁每条都要能变红)。

---

## 7. 与 600 的边界

600 拥有分层;601 拥有**进程边界与网络边界**。

| 问题 | 归属 |
| --- | --- |
| core 能不能有 IO | 600 |
| Session 身份解耦 | 600 |
| RunEngine 归属 | 600 |
| **控制平面跑在哪个进程** | **601** |
| **谁能当客户端** | **601** |
| **runtime 能否在远端** | **601** |

**601 不得重做 600 的分层裁决,也不得为了 web 端放宽 600 的依赖禁令。**
若实现中发现某条 600 边界挡住了 601 的正当需求,
**那是 600 的裁决要改,不是 601 绕过它** —— 走评审,不留后门。
