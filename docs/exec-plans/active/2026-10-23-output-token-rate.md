# TUI 显示模型输出速度（tok/s）

状态：active · 负责人：worker（tok/s 子任务） · 更新：2026-10-23
分支：`codex/tok-speed` · worktree：`.claude/worktrees/tok-speed` · base：`c81ed1690e63f84a9d98b5d725fffb0a4748dfdd` · owner：worker

## 目标与边界

TUI 在一次模型调用结束后显示该次调用的输出速度（`⚡ 63.0 tok/s`），数字来自 provider 真实上报的 output token 数与物理请求耗时，不做估算。

允许修改：`packages/ai`（测时长 + 纯函数）、`packages/agent-protocol`（契约字段）、`packages/agent-runtime`（模型帧携带）、`packages/host/src/run-engine-model.ts`（帧投影）、`packages/cli/src/tui/`（展示）。

本次不做：实时 BPE 估算与 250ms 节流（回合结束前无数字）；Desktop 侧渲染（共享函数先落在 `packages/ai`，Desktop 后续接入）；`packages/host` worker 生命周期。

## 验收

- `packages/ai` 单元测试：provider 流结束后 usage 带 `request_duration_ms`；纯函数对 0/负数/非有限值返回 `null`。
- `packages/agent-protocol` 契约测试：transcript `TokenUsage` 与事件 `TokenUsage` 都有时长字段，且分类表登记。
- `packages/cli` TUI 测试：footer 在有耗时与无耗时两种输入下分别渲染/不渲染 tok/s。
- `npm run typecheck:all` 与 `npm run architecture:check` 退出码均为 0。
- 真实链路：`npm run build:cli-dev` 后 `npm run dev:tui` 观察一次真实回合的 footer 输出。

## 进度

- [x] 确认 provider 调用边界与落点
- [x] 计划文档与 README 入链
- [x] `packages/ai`：物理请求时长 + 纯速率函数 + 单测
- [x] `packages/agent-protocol`：契约字段 + 分类登记
- [x] `packages/agent-runtime` / `packages/host`：帧携带时长
- [x] `packages/cli`：TUI 展示 + 单测
- [x] 门禁：typecheck:all、architecture:check
- [x] 真实 TUI 跑一次
- [x] PR（不合并）

## 发现与决策

- **物理请求边界在 `packages/ai`**：`createAIClient`（`packages/ai/src/index.ts:272`）按 `apiFormat` 懒加载 provider 客户端，`packages/host/src/worker-session-runtime.ts:986` 用它构造线上客户端，`worker-session-runtime.ts:181` 的 `readModelClient()` 把它交给 `composeLegacyRunSources` → `createClientModelPort`（`packages/host/src/worker-run-composition.ts:120`）。provider 的 `streamChat` 在流尾 yield `{ type: 'result', data: usage }`（`api/openai-completions.ts:1055`、`api/anthropic-messages.ts:2198`），因此在 `createLazyClient` 内层包一层即可对所有 provider 统一测时长，无需逐个改 provider。
- **分母含 TTFT**：时长从请求打开量到 `result` 事件产生，与 minimax-code 契约一致（用耗时本身，不从 chunk 时间戳反推吞吐）。
- **展示链路**：`@duya/ai` `result` → `packages/host/src/run-engine-model.ts:163` `toModelFrame` → `ModelFrame('usage')` → `packages/agent-runtime/src/engine/run-engine.ts:3398` `addUsage` → RunEvent `assistant.usage` → `packages/cli/src/tui/host-event-stream.ts:65` → TUI `token_usage` 帧 → `TUIApp` → footer。
- **纯函数放 `packages/ai`**：CLI 与 Desktop 共用同一实现；`packages/ai` 是 CLI 已声明依赖（`packages/cli/package.json:56`）。
- **Desktop 本次不接**：Desktop 渲染器读的是 worker 的 `chat:token_usage` 快照帧（11 字段），不是协议 `assistant.usage`，接上它需要另开一条 worker 通道改动。共享函数已落在 `packages/ai` 并从 barrel 导出，Desktop 后续直接复用。
- **worktree 下 `@duya/ai` 的值导入需要本检出先构建**：`packages/cli/node_modules` 是指向主检出的 junction，vitest 的 `WORKSPACE_SOURCE_ALIASES` 又没收录 `ai`，未构建时 `packages/cli/src/tui/slash/session-info.ts` 的 `@duya/ai/context` 在任何 worktree 里都加载失败（基线已有 4 个套件红）。本检出执行 `npm run build:packages` 后即恢复；这不是本次改动引入的，也不需要改仓库配置。


## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `c81ed169` clean | Windows / Node 24 | `npx vitest run packages/ai/test packages/agent-protocol/test packages/cli/src/tui/__tests__` | 1 —— 4 个套件加载失败（`@duya/ai/context` 解析到主检出 dist，被 vite fs.allow 拒绝）；其余 135 文件 / 1646 用例通过 | 基线失败，见上 |
| dirty（实现后） | Windows / Node 24 | `npx vitest run packages/ai/test packages/agent-protocol/test packages/host/tests/run-engine-model-usage.test.ts packages/agent-runtime/test/engine-publication.test.ts packages/cli/src/tui/__tests__/` | 0 —— 142 文件 / 1697 用例通过 | 相关套件全绿 |
| dirty（实现后） | Windows / Node 24 | `npm run architecture:check` | 0 —— `OK — no new boundary violations`（tolerated 2610 / baseline 2785） | 架构门禁 |
| dirty（实现后） | Windows / Node 24 | `npm run typecheck:all` | 0 —— 全部 workspace typecheck 通过 | 类型门禁 |
| dirty（实现后） | Windows / Node 24 | PTY 驱动真实 `packages/cli/bundle/cli.cjs tui`，发一条真实请求 | footer 出现 `↓37 Σ37 ⚡ 11.5 tok/s`（provider：minimax-cn / MiniMax-M3） | `docs-local/tui-pty.log` |

### 真实链路上的一个坑：worker bundle 可能是陈旧的

第一次真实 TUI 跑出来只有 `↓36 Σ36`，没有 tok/s。查下去发现 `packages/host/bundle/worker-entry.js`
里根本没有 `request_duration_ms`——它是在 `packages/ai/src/index.ts` 改动**之前**构建的。CLI bundle
（`cli.cjs`）是新的，worker bundle 是旧的，于是「测时长」那一环在真实链路里被整段跳过了。

重建 `npm run bundle:worker` 后字符串出现，真实 TUI 立刻显示出 `⚡ 11.5 tok/s`。

**判据**：产物是否含新代码，不能靠构建脚本跑过了没有，要靠**在产物里搜新标识符**。

## 接续 / 结果

已实现、已验证（门禁全绿 + 真实 TUI 跑通）。PR 见下方。

副作用已还原：`packages/host/bundle/*` 与 `packages/capabilities/src/ModuleTool/inline-content.ts` 均已
`git checkout --` 还原，未入库。

回收：未回收（PR 未合并）。
下一步：交给集成者 review；Desktop 侧接入是另开一条 worker 通道的活，不在本计划范围。

