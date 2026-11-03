# Prompt 缓存断点覆盖 Anthropic 兼容端点 + MCP 工具默认延迟加载

状态：active · 负责人：duya-session-2026-11-03-cache-mcp · 更新：2026-11-03
分支：codex/cache-mcp-defer · worktree：E:/Projects/duya/.claude/worktrees/cache-mcp-defer · base：a9c3897a · owner：duya-session-2026-11-03-cache-mcp

## 目标与边界

**用户可观察的变化**：同一个 MiniMax 端点上，duya 发送的请求带上 Anthropic 风格的 `cache_control` 断点，
工具定义不再每轮重新 prefill；MCP 工具默认不进请求的 `tools` 数组，改由 `tool_catalog` / `tool_invoke` 按需发现。

允许修改的路径：

- `packages/ai/src/utils/prompt-caching.ts`
- `packages/ai/src/api/anthropic-messages.ts`
- `packages/ai/test/prompt-caching.test.ts`
- `packages/host/src/worker-config/tool-exposure.ts`
- `packages/host/tests/worker-config/tool-exposure.test.ts`
- `docs/exec-plans/**`（本计划）

**本次不处理**：BashTool 输出截断（由其他 agent 负责）；`packages/agent/` 遗留层（AGENTS.md 声明正在退役，不新增实现）；
OpenAI 兼容路径的 `prompt_cache_key`（本次 provider 走 Anthropic 协议，未覆盖）。

关联：无上级计划。与同仓库其他 agent 并行工作，主检出 `E:/Projects/duya` 不动，成果只经本分支 PR 集成。

## 验收

```bash
# 1. 缓存断点：Anthropic 兼容端点拿到工具定义断点
cd packages/ai && npx vitest run test/prompt-caching.test.ts
node -e "const m=require('./dist/utils/prompt-caching.js');
console.log(m.checkCacheEligibility('minimax-cn','MiniMax-M3.1-Flash','https://api.minimaxi.com/anthropic'));
console.log(m.supportsToolDefinitionCache(
  m.checkCacheEligibility('minimax-cn','MiniMax-M3.1-Flash','https://api.minimaxi.com/anthropic')));"

# 2. MCP 默认延迟
cd packages/host && npx vitest run tests/worker-config/tool-exposure.test.ts

# 3. 门禁
cd <worktree-root> && npm run typecheck:all && npm run architecture:check
```

预期：`minimax-cn` → `eligible=true, nativeLayout=false, toolDefinitionCache=true`，`supportsToolDefinitionCache=true`；
MCP 默认 `exposure='search'`（deferred）；OpenRouter / Google 仍为 `toolDefinitionCache=false`。

基线失败：host 测试在未构建 dist 的检出报 `Cannot find package '@duya/data/data-paths'` /
`Failed to resolve entry for package "@duya/ai"`，属环境缺 dist，非本次改动引入，需先 `npm run build:packages`。

## 进度

- [x] 追查首 token 5-10s 的根因（同一 MiniMax 端点 A/B 实测）
- [x] 定位缓存断点失效点（`checkCacheEligibility` 对 minimax-cn/glm-cn 返回 ineligible）
- [x] 缓存修复 + 单元测试（29 通过）
- [x] 调研 Codex 的 MCP 延迟加载与缓存策略
- [x] MCP 工具默认改为 deferred（对齐 Codex `ToolSearchAlwaysDeferMcpTools`）
- [x] host 测试通过（57 tests：tool-exposure 13 + file-config 34 + mcp-catalog 1 + census 9）
- [x] `npm run architecture:check`（exit 0，无新增边界违规）
- [ ] `npm run typecheck:all`
- [ ] 提交 + PR

## 发现与决策

1. **缓存断点对 MiniMax 从未生效**：`checkCacheEligibility` 只认「`baseUrl` 含 `anthropic.com`」或「model 名含 `claude`」。
   `https://api.minimaxi.com/anthropic` 两者都不满足 → `eligible=false` → `applyCacheControl` /
   `applyCacheControlToSystem` / `applyCacheControlToTools` 全部空转，**duya 发给 MiniMax 的请求没有任何 cache_control 标记**。
   证据：`node -e` 直接执行 `packages/ai/dist/utils/prompt-caching.js`，改前 `eligible=false / maxBreakpoints=0`。

2. **判定改为「baseUrl 路径含 `/anthropic`」而非厂商名单**：改后 9/16 端点自动获得工具定义断点
   （anthropic / minimax / minimax-cn / glm / bailian / kimi / z-ai / deepseek-anthropic / bedrock），
   OpenRouter 与 Google 不受影响。规则认路径形状而非厂商名单，新增兼容端点自动受益。

3. **新增 `toolDefinitionCache` 字段，不复用 `nativeLayout`**：`nativeLayout` 描述的是**消息**线形状
   （原生 Anthropic 把 marker 放在 tool_result 消息上），工具**定义**上的 marker 是另一件事。
   MiniMax/GLM 接受后者，但前者未经证实——两者解耦避免 2013 风险。`supportsToolDefinitionCache()` 是唯一权威。

4. **实测收益**（同一端点 `https://api.minimaxi.com/anthropic/v1/messages`、同一 key、模型 MiniMax-M3.1-Flash）：
   - 83 工具无 cache_control：`in=71317, cache_read=188`（0.3% 命中），TTFT 4011/3859/8188ms
   - 83 工具加 cache_control：`in=1, cache_read=71504`（~100% 命中），TTFT 1470/1581/1548ms
   - 307k token 请求：8036ms → 1557ms（加断点后）
   工具定义是每轮请求最长且字节稳定的公共前缀，缓存收益即上述 4.2 万～7.2 万 token/轮。

5. **Codex 的 MCP 延迟加载机制**（`E:/cloned-projects/codex`）：
   `ToolExposure` 六态枚举 + `ToolExposureSurface`（`direct`/`deferred`/`code_mode`）+ 每个 MCP server 的
   `omit_tools_from` 配置 + `tool_search` 元工具（BM25 检索延迟工具元数据）。
   **deferred 工具的 schema 完全不进 `tools` 数组**（`build_model_visible_specs` → `is_directly_visible` →
   `exposure.is_direct()`），因此 tools 数组可在多轮间保持字节稳定。
   Codex 的两个显式保护：DIRECT 与 DEFERRED 互斥（`unreachable!`）；模型不支持 search tool 时必须回退全部 direct。

6. **duya 已有等价机制，只是默认关着**：`ToolExposure = 'eager'|'deferred'|'hidden'`、
   `tool_catalog` + `tool_invoke`（codex `tool_search` 的客户端等价物）、`shouldInjectMcpCatalog()` 注入系统提示、
   `tool-filter.ts:112` 的 deferred 可见性规则、`dispatcherFromRegistry.ts` 的 deferred 派发。
   差距只在默认值：`DEFAULTS.exposure = 'hint'` → eager → 83 个 MCP 工具全量带 schema 上线。
   Codex 的 `Feature::ToolSearchAlwaysDeferMcpTools` 是 `default_enabled: true`。

7. **duya 的延迟发现比 Codex 更安全**：duya 的 `tool_catalog`/`tool_invoke` 是普通工具（客户端目录），
   不依赖端点支持服务端 `tool_search`，因此不存在 Codex 的「模型不支持搜索 → 工具失明」缺口；
   MiniMax 这类端点同样可用。

8. **保留 `full`/`hint` 作为显式回退**：默认翻转为 `search` 是行为变更，
   `[tools] exposure = "full"` / `"hint"` 可恢复 eager MCP 工具，`DUYA_TOOLS_EXPOSURE` 环境变量同样可覆盖。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| a9c3897a + 工作树 dirty | Windows 11 / Node（工作树） | `npx tsc --noEmit -p packages/ai/tsconfig.json` | 0 | 无输出 |
| a9c3897a + 工作树 dirty | Windows 11 | `npx vitest run test/prompt-caching.test.ts`（工作树内） | 0 | 29 tests passed |
| a9c3897a + 工作树 dirty | Windows 11 | `node -e` 执行 `packages/ai/dist/utils/prompt-caching.js` 遍历 16 端点 | 0 | 9/16 端点 `toolDefCache=true` |
| a9c3897a + 工作树 dirty | Windows 11 | `npx vitest run`（host 4 个文件，未构建 dist） | 1 | `Cannot find package '@duya/data/data-paths'` 等环境缺 dist，非改动导致 |
| a9c3897a + 工作树 dirty | Windows 11 | `npm run build:packages` + `npm run build -w packages/host` + 拷贝 `src/worker-prompts/assets` → `dist/worker-prompts/assets` | 0 | host 构建通过（563 个 js）；资产拷贝后 census 测试可加载 |
| a9c3897a + 工作树 dirty | Windows 11 | `npx vitest run`（host 4 个测试文件） | 0 | 48 passed（首轮 census 1 失败：漏传 options，已修） |
| a9c3897a + 工作树 dirty | Windows 11 | `npx vitest run tests/worker-product-runtime/tool-surface-w0-census.test.ts` | 0 | 9 passed |
| a9c3897a + 工作树 dirty | Windows 11 | `npm run architecture:check` | 0 | 3188 项全部 tolerated，无新增违规 |

## 接续 / 结果

已实现：缓存断点覆盖 Anthropic 兼容端点（`packages/ai`）；MCP 工具默认 deferred（`packages/host`）。

未提交路径：以上 5 个源文件 + 本计划文档，均在 `codex/cache-mcp-defer` 工作树内，未提交。

副作用：默认 MCP 曝光由 eager 变 deferred —— 依赖 MCP 工具直连的既有行为会改为经 `tool_catalog`/`tool_invoke`；
若模型不主动检索，该 MCP 工具不会被调用。回退方式见「发现与决策」第 8 条。

阻塞：无。`npm run typecheck:all` 在工作树内运行中。

下一步：`npm run typecheck:all` 通过后提交 + 开 PR。
完成判据：typecheck 通过且 PR 创建成功。
