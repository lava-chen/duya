# 02 — Phase B:单一客户端契约

> **Electron renderer 和 CLI 调用同一份契约。**
> 能力 N 不再存在"IPC 一套形状、HTTP 另一套形状"。

## 0. 问题

今天同一批能力有**两个客户端、两套形状**:

| 客户端 | 通道 | 形状由谁定 |
| --- | --- | --- |
| Electron renderer | IPC(`ipcMain.handle` / preload 转发) | `electron/preload.ts` |
| CLI | localhost HTTP(`/v1/*`) | `cli-api-server.ts` |

**这违反 [00 §1.3](00-contracts.md#13-client客户端) 的"客户端可互换"。**
renderer 能做的事 CLI 做不到,反之亦然 —— 每加一个能力就要在两条路上各做一次。

### 0.1 好消息:契约层已经存在而且是真东西

```
apps/desktop/src/contracts/git.ts
apps/desktop/src/contracts/import.ts
apps/desktop/src/contracts/__tests__/contracts-boundary.test.ts
```

- 两个 DTO 文件**零 import**
- `contracts-boundary.test.ts:59` 禁 electron / node 内建 / DOM / host
- `:84` 只允许类型,不允许运行值
- `:102-129` 要求 **main、preload、renderer 三方都能引**

**`:102-129` 已经把 renderer 纳进来了** —— 也就是说三方共用的边界测试
**今天就在跑**,只是 HTTP 契约还没长进去。

> **Phase B 是把 `contracts/` 从"git/import 词汇表"长成"真正的客户端契约层",
> 不是改造它,也不是绕过它。**

---

## 1. 前置:为什么 B 必须等 600

600 正在把 Control Plane 变成真实分层(README §6.1)。
**在 RunEngine 与 CP 边界落地之前统一契约,等于把两个还没稳定的形状焊死** ——
之后每改一次结构,客户端契约就要跟着改一次。

因此:

| Phase A | 可以与 600 并行 |
| --- | --- |
| **Phase B** | **必须等 600 的 CP 成形** |
| **Phase C** | 必须等 B |

**不要为了"早点出 web"跳过这个前置。** 契约层的返工成本随客户端数量增长 ——
现在只有一个 renderer,以后会有四个。

---

## 2. 唯一 next action

1. **B1** — 写门禁 B1 / B2,确认现状下**B2 是红的**
2. **B2** — 盘点能力清单,标出每个能力当前有几套形状
3. **B3** — 定义 HTTP 契约 DTO 规则(不是逐个字段,是规则)
4. **B4** — 让 renderer 走 HTTP 契约,IPC 收敛为薄转发
5. **B5** — 逐条能力收敛,每条切断旧形状

---

## 3. 盘点先行(B2)

**先数清楚,再动手。** 不要凭印象说"应该有两三处重复"。

对每条能力记录:

| 列 | 内容 |
| --- | --- |
| 能力 | 如 `sessions.list` |
| IPC 形状 | 存在 / 不存在 |
| HTTP 形状 | 存在 / 不存在 |
| 契约 DTO | 存在 / 不存在 |
| 收敛后 live owner | 谁 |

> **纪律:盘点数字必须带 scope。** 例如
> "`grep -c "ipcMain.handle" electron/` 得 47,其中 31 条有对应 HTTP 路由"。
> **裸数字不接受** —— 脱离 scope 的数字不可判读。

**预期结论(需实测替换):** 大部分能力两边都有,且形状不同;
少部分只有一边。**这个实测结果决定 B 的工作量,先出数字再排期。**

---

## 4. 契约规则(B3)

不是逐字段设计,是**规则**:

1. **按角色分层,不按 UI 分层。** DTO 来自"客户端需要什么",
   不来自"Electron 长什么样"或"小程序屏幕多窄"。
2. **零实现类型。** 禁 electron / node 内建 / Buffer / DOM
   (判据已存在:`contracts-boundary.test.ts:59`)。
3. **每个字段有真实消费者。** 没消费者的字段删掉,不留"预留"。
4. **同一实体只有一套字段名。** 不允许 `sessionId` 与 `session_id` 并存。
5. **错误也是契约。** 错误形状与成功形状同等对待 ——
   客户端要能程序化区分错误类型,不能解析 message 字符串。

---

## 5. IPC 的归宿

**IPC 不删除,降级为薄转发。**

理由:preload 的 IPC 是 renderer 与 main 之间的**宿主机制**(安全上下文、
`contextBridge`),它本身没问题。问题是**业务形状**住在 IPC 上。

收敛后:

```text
今天:  业务形状 ──▶ IPC 契约 ──▶ main 内部实现
                    ▲
              业务形状住在这里

之后:  业务形状 ──▶ contracts/ DTO ──▶ 实现
              ▲            ▲
         IPC 薄转发    HTTP/SSE
```

**判据:同一份 DTO 被 IPC 转发和 HTTP 路由共同使用。**
若两条路各自定义 DTO,B2 门禁仍然是红的。

---

## 6. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| **B1** 契约 browser-safe | 客户端契约零 electron / node 内建 / DOM 类型 | 往契约里加一个 `Buffer` |
| **B2** 客户端形状唯一 | 同一能力不存在 IPC 与 HTTP 两套 DTO | 保留一处 IPC 专用形状 |

### 6.1 B1 扩展现有边界测试

`contracts-boundary.test.ts:59,:84,:102-129` 已经是这个门禁。
**Phase B 只需让它覆盖新契约文件**,不新造门禁脚本。

> 复用已验证的门禁,而不是写一个新的。600 的 S0 之所以可信,
> 是因为每条规则都做过变异证明;新脚本默认不可信,要重新证明。

### 6.2 B2 必须是**计数**门禁,且两侧来源不同

B2 断言的是"**能力 N 的 DTO 定义处数量 == 1**"。
两侧来源必须不同:

- **声明侧**:`contracts/` 里的实体清单
- **实测侧**:IPC 导出 + HTTP 路由的 DTO 引用扫描

> **拒绝恒等式断言。** 拿"扫描出的条数"比"扫描出的条数"永远通过 ——
> 600 的 `LEGACY_RETIREMENT` 测试就犯过这个错(拿 `measured.length` 比
> `measured.length`,声明 7 实测 3 也照样绿)。**这是同一个仓库第三次
> 出现"守卫报告事实却不检查任何东西"。**

---

## 7. 本阶段明确不做

| 不做 | 理由 |
| --- | --- |
| 造传输无关的 channel 抽象 | 见 §8,先不做 |
| 删 preload / `contextBridge` | 宿主机制,与业务形状无关(§5) |
| 改 `contracts-boundary.test.ts` 的判据 | 它是对的,只需扩覆盖面 |
| 动 600 的分层裁决 | 601 不放宽 600 的依赖禁令 |
| 为小程序裁剪一套 DTO | [00 §3](00-contracts.md#3-契约纪律):小程序读**子集**,不另造形状 |

---

## 8. 传输:先不抽象

**明确建议:Phase B 不造传输无关的 channel 层。**

ZCode 在这一点上比 duya 走得远:它的 `SocketProtocol` / `ChannelServer` /
`ChannelClient` + `hello` 握手 + `connectionId` 订阅路由
(`packages/rpc/src`、`zcodeAgentConnectionScope.ts:196-201`)让
Electron 走 MessagePort、浏览器走 WebSocket 复用同一套 channel API。
**这是很强的抽象,但它解决的是 duya 现在还没有的问题。**

duya 现状:

| 通道 | 状态 |
| --- | --- |
| IPC | Electron 内部,MessagePort 类 |
| HTTP + SSE | **已有**:`http-sse-transport.ts:183`,带 bearer(`:211-215`)+ origin allowlist(`:219`) |
| WebSocket | 无 |

**SSE 足够先出一个能用的 web 端。** 造 channel 抽象的收益要到
"多个客户端 × 多种传输 × 双向流"同时成立时才兑现。

> **判据:当第三个客户端出现、且它需要双向流时再抽象。**
> 提前抽象的代价是:一个没有真实消费者驱动的抽象会一直漂移,
> 直到它开始反过来限制真实需求。

---

## 9. 完成标志

1. **B1 绿**(扩展后的既有边界测试),做过变异证明
2. **B2 绿**:盘点表里每条能力的 live owner 都是 1,**且数字带 scope**
3. renderer 与 CLI **调用同一份 DTO** —— 有**真实调用**证据,
   不是"两条路都存在"
4. `apps/web` 作为**第三个客户端**接上同一契约,不需要任何专属后门
5. 收敛过程中**没有删掉任何 renderer 能力**
   —— 收敛不是功能削减,少一条就是回归

第 5 条是防"以收敛之名砍功能"的。**对拍:收敛前后 renderer 可用能力集合必须相等。**
