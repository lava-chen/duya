# Plan 585: 事件流性能债 —— ephemeral 序列空间、delta 合并、背压粒度

> **Status**: 未开始（本文件只做设计记录，三个阶段都还没有代码落地）
> **Priority**: P1（P2 有独立性能收益但不阻塞任何发布）
> **Created**: 2026-10-01
> **Related**: [ARCHITECTURE.md](../../../ARCHITECTURE.md)（HTTP+SSE 三层分离）、`packages/agent-protocol/src/envelope.ts`（`SEQ_CONTRACT`）、`electron/agents/server/router.ts`（SSE 写入与背压）、`electron/agents/server/checkpoint-batcher.ts`（仓库里已有的时间窗 + 批量模式）

---

## Problem

`@duya/agent-protocol` 已经把事件的持久化语义做成了机器可读字段
（`durability`: durable 22 / volatile 11 / ephemeral 5），但**传输层和序列空间
还停留在"每个事件一视同仁"的状态**。三处具体问题，全部已核实到行号。

### P1 — ephemeral 事件在吃 durable 的序列空间

`SEQ_CONTRACT`（`envelope.ts:131-143`）规定 `seq` 是 per-run、严格 +1、无空洞，
并由 runtime 铸造。但 `router.ts:1474` 走的是 `seqNum++`，**没有任何按
durability 分类的分支** —— 于是协议自己定义为
"counted in metrics, never retained" 的 delta 也在消耗唯一的权威排序号。

量级（token 级流式速率估算）：

| | 10 分钟一次回答 |
|---|---|
| `assistant.text_delta` | ~60,000 |
| 同期 durable 事件（`text_block` / `tool.*` / `turn.*`） | ~200 |

即 **99.7% 的 seq 是噪声**。直接后果：`RuntimeCapabilities.events.oldestAvailableSeq`
与 `latestSeq` 描述的 resume 窗口几乎全是 delta，按 seq 切窗切不出有用边界。

协议立场本身也是矛盾的：一边声明 progress 事件"绝不能被归约成权威状态"，
一边让它们占用唯一那个权威排序号的命名空间。

**注意**：这一项和 `envelope.ts:14-35` 记录的那个已存在的 bug（`seq` 每个 POST
重置为 0）是**两个独立问题**。修 P1 不等于修那个,反过来也一样。

### P2 — ephemeral delta 没有合并窗

每个 token 级 delta 走完整链路：worker emit → `JSON.stringify` → SSE frame →
`res.write` → IPC → renderer。协议语义上合并**零损失**：三个高频 ephemeral 事件
（`text_delta` / `thinking_delta` / `arguments_delta`）在 durable 侧都有兜底
（`text_block` / `thinking_block` / `tool.call_started`）。

`checkpoint-batcher.ts` 已经证明本仓库接受"时间窗 + 批量"这个模式
（`BATCH_INTERVAL_MS` + `MAX_BATCH_SIZE` 双阈值 + flush 失败重入队），
只是没有用在 delta 上。这是照抄而非发明。

### P3 — 背压粒度过粗，连带拖累 durable 事件

`router.ts:1192-1264` 的 `sseWrite` 策略：`res.write()` 返回 false 就
`child.stdout.pause()`，drain 后 resume。也就是**渲染端一慢，整个 worker 的产出全停
—— 包括 durable 事件**。

这是 P2 的直接后果，也是 P2 值得做的真正理由：`tool.call_started` 是
"dispatch 之前必须落账本的权威意图"（`payloads.ts:420-442`），它被一个纯 UI 提示的
delta 洪峰堵住，是账本正确性问题，不只是慢。

---

## 明确不做

以下三项在讨论中被评估并否决，记录理由以免重复讨论：

- **CBOR 编码**（pi-protocol 的路线）。传输是 HTTP+SSE + Electron IPC，
  换 CBOR 要重写全部 adapter，收益不抵成本。
- **严格解码**（pi-protocol 的 `additionalProperties: false`）。4 个独立部署的
  host + 子进程运行时，版本各自漂移，严格解码在这里是崩溃制造机。
  见 `codecs.ts:4-19` 已记录的判断。
- **收敛 38 个事件到更少**。渲染模型不同；砍到 pi 的 4 个会把副作用账本和
  resume 一起砍掉。

---

## Phases

### Phase 1 — P2 delta 合并窗（先做，收益最大且不依赖 P1）

- [ ] 在 `electron/agents/server/` 抽出 `ephemeral-batcher.ts`，形状对齐
      `checkpoint-batcher.ts`（时间窗 + 容量双阈值 + flush 失败重入队）
- [ ] 合并粒度：同一 `sessionId` + 同一 `type` 的 delta 拼成一个帧；
      `text_delta` 与 `thinking_delta` 不互相合并（渲染层要分别挂载）
- [ ] 合并只作用于 `durability === 'ephemeral'` 的事件，
      由 `EVENT_REGISTRY` 判定而不是硬编码类型名
- [ ] 合并后的帧仍占**一个** seq（天然缓解 P1，但不依赖 P1 完成）
- [ ] 测试：合并窗口内的 durable 事件必须**先于**被合并的 delta 写出

### Phase 2 — P3 背压粒度（依赖 Phase 1）

- [ ] `sseWrite` 触发的 `child.stdout.pause()` 改为只暂停 ephemeral 产出，
      durable 事件继续排空
- [ ] 若做不到按类型暂停，退而求其次：durable 事件走独立的高优先队列，
      背压时不丢
- [ ] 验证：慢渲染端下 `tool.call_started` 的发出延迟不随 delta 速率上升

### Phase 3 — P1 ephemeral 独立序列空间（最后做，风险最高）

- [ ] 先定契约再动代码。三个候选：
      (a) ephemeral 不参与 run seq，改用独立的 ephemeral 计数器；
      (b) run seq 保持单一，但契约显式声明"durable 子序列在 seq 上有洞"，
          并让 `oldestAvailableSeq` / `latestSeq` 改为按 durable 事件定义；
      (c) 不改，只把 P2 的合并做到位，接受 seq 空间被压缩
- [ ] 改契约会牵动 `Last-Event-ID` 恢复路径与已有 replay 存储，
      必须单独立项，不与 Phase 1/2 同批
- [ ] 若选 (a)：`toEnvelope` 需要能铸造无 seq 的 ephemeral 信封，
      `isValidSeq` / `eventKey` 都要跟着改

---

## 验收

- [ ] `npm run typecheck:all` 通过
- [ ] 协议包 drift test 全绿（当前基线：20 文件 / 356 用例）
- [ ] 一次 10 分钟回答的 SSE 帧数下降 ≥ 90%（P2 生效的直接指标）
- [ ] 慢渲染端压测下 durable 事件无丢失（`tool.call_started` 计数与
      worker 侧发出计数一致）
- [ ] `Last-Event-ID` 断线重连在 Phase 1/2 之后行为不变
