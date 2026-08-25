# Plan 444: Token Accounting 升级 — pi 标准 Usage 结构 + 缓存浪费扫描器

> **Status**: T1/T2/T3 完成（2026-08-24，commits 75a08eee / 2b10e1b6 / f813e191）；UI 交互验证待 Playwright MCP
> **Priority**: P0
> **Created**: 2026-08-24
> **Source**: [token-accounting.md](../../references/harness-comparison/token-accounting.md)（harness 对比结论）
> **Reference impl**: `pi@b6557f43e` `packages/coding-agent/src/core/cache-stats.ts`

## Problem

对照五个 harness 的 token 计量实现（见 token-accounting.md），duya 有两处核心差距：

1. `packages/ai/src/utils/usage.ts` 的 `NormalizedUsage` 缺 `reasoning` 与
   `cacheWrite1h` 分量；"provider 未上报"被折叠成 0 而非 undefined；
   cost 不随消息内嵌，dashboard 每次反查价目表。
2. 完全没有缓存**浪费**量化：现有
   `packages/agent/src/observability/cache-monitor.ts` 只算单轮命中率，
   回答不了「这个会话因缓存失效多花了 $X」。pi 的 cache-stats 扫描器是
   五个 harness 中唯一能量化该值的实现。

## Tasks

### T1 Usage 结构对齐 pi 标准（P0）

- [x] `UsageLike` 增加 Anthropic `cache_creation.ephemeral_5m/1h_input_tokens`
      解析 → `cacheWrite1h`（1h TTL 写价 2 倍，混列必错账）；顺带修复
      `output` 提取链 `??` 不穿透的潜在 bug（只有 output_tokens 的 provider
      才能取到值），改用 asFiniteNumber 链
- [x] `UsageLike` 增加 OpenAI `completion_tokens_details.reasoning_tokens`
      等别名解析 → `reasoning?: number`（undefined = provider 未上报；
      约定 reasoning ⊆ output，不是独立加项）
- [x] 保持既有四桶 input/output/cacheRead/cacheWrite 语义不变（0 默认），
      仅新增字段为 optional —— 向后兼容

### T2 缓存浪费扫描器移植（P0）

移植 pi cache-stats 四个缺一不可的细节：

- [x] 纯函数模块 `electron/ipc/cache-waste.ts`：
      1024 token 噪声底 / sticky reportedCache / 差价成本
      （paidPerToken 从消息自身 buckets+pricing 反推）/ compaction 重置基线、
      模型切换不豁免 / CACHE_TTL_MS=5min 归因
- [x] 单测 `electron/ipc/__tests__/cache-waste.test.ts` 覆盖上述边界
- [x] 接线 `usage-aggregator.ts`：SessionUsageFacts 增加带时序的 usage 序列
      （pricing 无关、可缓存），聚合阶段按 session 计算 CacheHealth，
      DTO 加 `cacheHealth` 字段（totals + per-session）

### T3 设置页「缓存健康」面板（P1）

- [x] UsageDashboard 摘要网格增加缓存浪费卡片：浪费成本、miss 次数、
      TTL 归因提示（`src/components/usage/UsageSummaryGrid.tsx` + i18n）
- [ ] Playwright MCP 验证（本会话无 MCP 工具；typecheck + vite build 已过）

## Decisions

- 扫描器放主进程而非 agent core：输入是 rollout MessageRow（seq 有序、含
  compaction 标记 msg_type='compact_checkpoint'），与 dashboard 同源同缓存。
- duya 的 MessageRow 无 per-message model/provider 列（session 级），v1 的
  modelChanged 恒 false；per-message cost 不内嵌，差价在聚合期由 pricing lookup
  计算。若将来行级 model 落库再对齐 pi 全语义。

## Verification

- `npx vitest run electron/ipc/__tests__/cache-waste.test.ts electron/ipc/__tests__/usage-aggregator.test.ts packages/ai`
- `npm run typecheck:all`
