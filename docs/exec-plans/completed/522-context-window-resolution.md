# Plan 522: 上下文窗口解析对齐(圆环 vs 压缩预算)

> **Status**: ✅ 完成(2026-09-11)
> **Priority**: P0
> **Created**: 2026-09-11
> **Companion**: [517-compaction-loop-fix-and-ui-progress](./517-compaction-loop-fix-and-ui-progress.md)(R1 仅做三层 audit log + 手动 `model_context` override)、[422-compaction-strategy-consolidation](./422-compaction-strategy-consolidation.md)
> **Source evidence**: 2026-09-11 dev 库直读(`duya-core.db` sessions / `duya-main.db` `provider_model_capabilities`)、`context-ring.log` 会话 `36466187-488`(deepseek-flash,used≈173K / msgs≈304)、`~/.duya/config.toml` 实测

---

## 1. 症状

圆环显示"1M 上下文"(用量约 17%),但 auto-compaction 在约 20% 就触发,仿佛窗口是 200K。

## 2. 根因:两条解析路径分叉

| | 圆环 | 压缩预算 |
|---|---|---|
| 取值 | `provider:getModelCapability` → `ProviderStore.resolveRuntimeCapability`(config marker > DB override > `@duya/ai` 内置基线) | `runtimeConfig.modelCapabilities.contextWindow`,否则 `DEFAULT_CONTEXT_WINDOW = 200_000` |
| 结果 | 命中内置基线 → 1M | runtimeConfig 未带 capability → 200K |

阈值 = `maxTokens − 16384`;200K 预算下为 **183,616 = 1M 的 17.5%**,与"20% 触发"吻合。

**为什么 runtimeConfig 拿不到 capability**:普通聊天链路里渲染层构造的 `providerConfig` 只有 `{apiKey, baseURL, model, provider, authStyle}`(`src/lib/stream-session-manager.ts`),`src/` 全局 grep 不到 `runtimeConfig`;agent-server 原样转发(`electron/agents/server/router.ts`),worker 得到 `config.runtimeConfig === undefined`。另一条会带 runtimeConfig 的路径 `agent:reinit-provider` 用的是 DB-only 的 `catalogStore.getOverrides`,deepseek 无 override 行 → 同样 undefined。唯一解析正确的 `agent:getProviderConfig` 在渲染层无调用方。

实测:deepseek 无 `[options].model_context` 表项;`provider_model_capabilities` 397 行中无 deepseek 行。

## 3. 修复

1. **agent 侧目录兜底** — 新增纯函数 `resolveCompactionContextWindow`(`packages/agent/src/compact/contextWindow.ts`):`runtime capability → @duya/ai catalog → 200K`。`DuyaAgent` 构造函数与 streamChat 模型切换两处统一走它;仅当两层都 miss 时才 warn(保留 plan 517 R1 的可观测性)。
2. **Electron 侧统一解析** — `getActiveProviderRuntimeConfig` / `getProviderRuntimeConfig`(`electron/services/providers/provider-store.ts`)在调用方未传 capability 时改用 `resolveRuntimeCapability`(三层合并),取代 DB-only 的 `getOverrides`。

## 4. 验证

- `packages/agent/src/compact/__tests__/contextWindow.test.ts`(5 例):capability 优先 / catalog 兜底 / 非正值忽略 / 两层都 miss → 200K / 无 modelId → 200K。
- `electron/services/providers/__tests__/provider-store.test.ts` 新增 2 例:无 DB 行时 runtime config 带 catalog 窗口(1_000_000);显式 capability 仍优先。
- `npx vitest run <两个文件>` 38 例全绿;`npm run typecheck:agent` 通过。

## 5. 决策与遗留

- 选择"agent 侧目录兜底"作为最小、且覆盖全部入口(聊天 / reinit / bot / CLI)的修复,不引入新 HTTP 协议字段。
- **跨会话依赖**:报告中的模型 id `deepseek-flash` 属另一会话在 primary 未提交的 catalog 变更(把 `deepseek-v4-flash` 暴露为 `deepseek-flash`)。本次测试用 `claude-sonnet-5`(HEAD 已有的 1M 条目)以免耦合该变更;两处合并后该 id 在圆环与压缩预算两侧都为 1M。
- 遗留:`src/` 侧仍未把 runtimeConfig 透传给 agent(本次由 agent 侧兜底覆盖);`electron/**` 被根 `tsconfig.json` `exclude`,不在 `typecheck:all` 门禁内。`npx tsc -p electron` 在 HEAD 上即报 `src/lib/stream-session-manager.ts` / `src/types/slash-command.ts` 的既有错误(本改动未触碰这些文件);本次改动文件无新增错误。
