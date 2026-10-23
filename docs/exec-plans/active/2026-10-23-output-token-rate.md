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
| `9991a0db` | Windows / Node 24 | `npm run bundle:verify` | 0 —— `FRESH 0/922` | worker bundle 重建后新鲜 |
| `1fb0b9c9` | Windows / Node 24 | `npx vitest run apps/desktop/src/main/__tests__/logger-write-stream-error.test.ts apps/desktop/src/main/cli/handlers/crons.test.ts` | 0（2 files / 10 tests） | cherry-pick 的 desktop logger 修复 |

### 两个 CI 红灯的成因（都不是本次改动引入的）

1. **`architecture` 红在 `bundle:verify`**：本次改了 `packages/ai/src/index.ts`，它在
   `worker-metafile.json` 的输入列表里，而那个列表对应的 bundle commit 早于本次改动 →
   门禁判 `stale`。修法就是门禁自己写的那句：**重建 worker bundle 并在同一个改动里提交**
   （`chore(host): rebuild the worker bundle for the request duration`）。
   这个门禁比的是 **git 历史**而不是字节——因为 esbuild 的 minify 输出不可复现，比字节会永远红。

2. **`test` 红在 `apps/desktop/src/main/cli/handlers/crons.test.ts`**：症状是「用例全过但 job 红」，
   唯一错误是 `Uncaught Exception: ENOENT ... /tmp/duya-cron-test-*/logs/app.log`。
   本次改了 `packages/host/src/run-engine-model.ts`，CI 的 affected 集合因此把 `apps/desktop`
   的测试拉了进来；那个测试的 `afterEach` 删临时数据根时 desktop logger 的写流还开着，
   而 `Logger extends EventEmitter` 且全仓无人注册 `error` 监听器 → Node 语义下抛成未捕获异常。
   修复在**别的分支**上（`codex/tui-multi-host` / PR #397，`e269c53e`），master 上还没有，
   所以只能 cherry-pick 过来（`fix(desktop): stop a logger write failure from crashing the process`）。
   两个文件，与本次改动完全不相干。#397 合并后集成者可以丢掉其中一份。

### 真实链路上的一个坑：worker bundle 可能是陈旧的

第一次真实 TUI 跑出来只有 `↓36 Σ36`，没有 tok/s。查下去发现 `packages/host/bundle/worker-entry.js`
里根本没有 `request_duration_ms`——它是在 `packages/ai/src/index.ts` 改动**之前**构建的。CLI bundle
（`cli.cjs`）是新的，worker bundle 是旧的，于是「测时长」那一环在真实链路里被整段跳过了。

重建 `npm run bundle:worker` 后字符串出现，真实 TUI 立刻显示出 `⚡ 11.5 tok/s`。

**判据**：产物是否含新代码，不能靠构建脚本跑过了没有，要靠**在产物里搜新标识符**。

## 接续 / 结果

已实现、已验证（门禁全绿 + 真实 TUI 跑通）。

PR：https://github.com/lava-chen/duya/pull/396（draft，未合并）

提交序列：`5b421d4b`（协议契约）→ `77a9bcd2`（ai 测时长 + 纯函数）→ `1cf89eab`（runtime/host 帧）
→ `edc7112b`（CLI 展示）→ `4e2b15e0`（计划文档）→ `a82d6bc8`（PR 链接）→
`9991a0db`（重建 worker bundle）→ `1fb0b9c9`（cherry-pick desktop logger 修复）。

副作用已还原：`packages/capabilities/src/ModuleTool/inline-content.ts` 已 `git checkout --` 还原。
`packages/host/bundle/*` 是**入库产物**，本次按门禁要求重建并提交，不算副作用。

回收：未回收（PR 未合并）。
下一步：交给集成者 review；Desktop 侧接入是另开一条 worker 通道的活，不在本计划范围。

