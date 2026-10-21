# Plan: Context Ring 单一估算器重构（对齐 pi）

> **Status**: Code complete (2026-08-24); Electron manual verification pending
> **Priority**: P0
> **Created**: 2026-08-24
> **Related**: [315-agent-message-domain-framework](./315-agent-message-domain-framework.md), [422-compaction-strategy-consolidation](../completed/422-compaction-strategy-consolidation.md)

---

## 问题

ContextUsageRing 的"上下文大小"目前由 **4 条代码路径**产出，互相打架导致圆环波动、thinking/工具轮次不准：

1. **worker 增量 tracker 状态机**（agent-process-entry.ts 模块级 `liveBaseContext / liveBaseMessageCount / hasLiveBase / liveBoundaryPending / liveBaseCompacted` + `computeLiveUsedFromTracker`）：boundary 假设（result 后恰好推一条 assistant）、append-only invariant、压缩重置等特判多，每条都有反例。
2. **renderer 内联尾部估算**（useContextUsage.ts trailing 循环）：只读 `.text`，漏 thinking / tool_use.input / tool_result.content，与 worker 的强估算器数字不一致 → live/scan 切换时跳变。
3. **persisted scan 分支**：last_call 回退逻辑与上面两条并存。
4. **压缩后 stale 锚点**：被保留消息上的旧 usage 反映压缩前的大上下文，被误当新锚点。

## 方案（pi 对齐）

参考 `E:\cloned-projects\pi\packages\ai\src\utils\estimate.ts` 与 `agent-session.ts:getContextUsage`：

- **一个纯函数** `computeContextEstimate(messages)`：倒扫最后一个有效 usage 锚点（compact boundary 之后），`used = normalize(input)+output(+cache)`，trailing = 其后所有消息逐块估算；无锚点 → 全量估算 + systemPrefix。无状态，每次发射从头算。
- **usage 上消息**（pi parity）：DuyaAgent 推 assistant 消息时附上本轮 `result` 的 usage（`result` 恒在 `done` 之前 yield，两个 adapter 已确认）。锚点查找不再需要 boundary 标志位。
- **压缩语义**：最近一次压缩后无新有效 usage → 显示 `?`（不猜）。renderer 的 hasData 三态收敛为 `anchored`。
- **单一估算器**：block-aware 提取器下沉到 `@duya/ai`，worker（compaction）与 renderer 共用一份；renderer 内联弱版删除。
- **累计统计（↑↓R/W/$）保持现有单遍求和**，不动。

## Implementation Plan

### Task 1: @duya/ai 共享纯函数模块

- [x] Step 1: 新建 `packages/ai/src/utils/context-estimate.ts`：`normalizeInputTokens` + `estimateContentBlocksTokens`（text/thinking/tool_use.input/tool_result 递归/image 下限）+ `computeContextEstimate(messages, opts?)`
- [x] Step 2: 从 `packages/ai/src/index.ts` 导出
- [x] Step 3: 单测（锚点选择 / last_call 优先 / compact-boundary 守卫 / thinking+tool_use 覆盖 / 无锚点前缀 / aborted-error 无效化）

### Task 2: tokenBudget 委托共享提取器

- [x] Step 1: `packages/agent/src/compact/tokenBudget.ts` 的 `contentBlockText` 改为委托 `@duya/ai` 实现（CJK 比例不变）
- [x] Step 2: 跑 compaction 相关既有测试确认无回归

### Task 3: DuyaAgent 给 assistant 消息附 usage

- [x] Step 1: 流循环内捕获 `result` 的 usage（局部变量），在 `done` 推送 assistant 时写入 `usage:` 字段（类型已存在，`@duya/ai/types.ts:359`）

### Task 4: worker 删增量 tracker

- [x] Step 1: 删 `liveBaseContext/liveBaseMessageCount/hasLiveBase/liveBoundaryPending/liveBaseCompacted/computeLiveUsedFromTracker`
- [x] Step 2: `emitLiveUsage` 改为调 `computeContextEstimate(agent.getMessages(), { systemPrefix })` + 累计 totals；帧加 `anchored`
- [x] Step 3: seeding 只保留累计 totals 部分；所有旧调用点（turn 开始/result/tool_result/压缩/next-turn 清理）改走新实现
- [x] Step 4: 压缩完成路径发 `anchored:false` 帧（renderer 显示 ? 直到下个 result）

### Task 5: renderer 收敛为哑组件

- [x] Step 1: store `WorkerUsageSnapshot/LiveContextUsage` 加 `anchored` 透传
- [x] Step 2: `useContextUsage` 重写：live 帧 → 直接 finalize；bootstrap → 同一共享纯函数扫 persisted messages；删内联尾部估算与三分支装配
- [x] Step 3: `ContextUsageRing` 未锚定时显示 `?`

### Task 6: 验证

- [x] Step 1: 更新/替换 `live-context-usage-tracker.test.ts` → emission 语义测试
- [x] Step 2: `stream-session-manager.test.ts` 透传用例更新
- [x] Step 3: `npx vitest run` 全量 + `npm run typecheck:all`
- [ ] Step 4: Electron 手动实测：普通轮次 / thinking / 工具密集轮 / 手动压缩 后圆环单调不回跳

## Verification Checklist

- [ ] thinking 轮次：trailing 计入 thinking 块，圆环不低估
- [ ] 工具轮次：tool_use.input 与 tool_result 计入，result rebase 不再出现大幅回跳
- [ ] 手动压缩后：圆环立即显示 `?`，首个 result 后恢复真实值
- [ ] 打开历史 session：bootstrap 数字与 worker 首帧一致（同一函数）
