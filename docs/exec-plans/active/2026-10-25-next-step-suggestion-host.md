# 下一步建议下沉到 worker/Host 并改为输入框 placeholder

状态：active · 负责人：mavis 会话 `mvs_c2c6b417aeed49c393c3b4fd4d079992` · 更新：2026-10-25
分支：`codex/next-step-suggestions` · worktree：`E:/Projects/duya/.claude/worktrees/next-step-suggestions` · base：`270ba528`（已合并 master `77bd7848`） · owner：mavis · PR：#496

## 目标与边界

用户能观察到的变化：

- 「下一步建议」不再是桌面端专属。**生成下沉到 worker**（与 session 标题生成同层），Desktop / Web / TUI 三端都能拿到。
- 呈现从「消息流底部 3 张卡片」改为「**输入框 placeholder 一条灰字建议**」；空输入按 Enter 采纳填入，不自动发送。
- 删掉桌面端手写的 provider/模型读取与 anthropic/openai/ollama 三套 fetch，改用 `@duya/ai` 的 AIClient。

不在本次范围：suggestion speculation（预跑建议 turn）；服务端推送（grok 的 `x.ai/follow_ups` 路线）；recap 能力。

关联：基线 master `270ba528`（PR #476）。外部参考：`claude-code-haha/src/services/PromptSuggestion/promptSuggestion.ts`（运行时内生成 + placeholder + 抑制规则）、`grok-build/.../acp_handler/follow_ups.rs`（服务端推送 chips）。

## 验收

- `npx vitest run <相关文件>`：协议 / data / host / ui / cli 相关用例通过；先记录基线失败再比较。
- `npm run typecheck:all` 与 `npm run architecture:check` 退出码 0。
- 真机：Desktop、Web、TUI 各跑一轮对话，turn 结束后输入框出现一条灰字建议，按 Enter 采纳填入。
- 旧卡片与旧生成通道消失：`git grep -n "nextSteps:request\|NextStepSuggestions\|next-step-service"` 无结果。

## 进度

- [x] S0 摸底：turn-review 同构链路 + UI/TUI 接入点
- [x] S1 protocol + data：DTO、store、migration id 60
- [x] S2 host：worker 生成 + db bridge 落库
- [x] S3 host/client-core：HTTP 路由 + http-client + HostApiBridge
- [x] S4 共享 UI：UiServices 端口 + 双路 client + hook + placeholder；Desktop preload/IPC；Web BFF
- [x] S5 TUI：composer 灰字提示 + 采纳预填
- [x] S6 删除旧路径 + 更新 ARCHITECTURE.md
- [x] S7 门禁 + commit + PR（PR #496）

## 发现与决策

- **desktop 的 protocol 子路径必须逐个写进 paths**：`apps/desktop/tsconfig.main.json` 用 `moduleResolution: node`，不认 package `exports`，所以 `@duya/agent-protocol/turn-suggestion` 不会解析到 `dist/turn-suggestion.d.ts`（TS2307）。该文件本来就把每个 protocol 子路径显式映射到 `dist/*.d.ts`，新增子路径必须补一行。
- **删除文件要在 slice census 里逐条登记退休**：`scripts/architecture/slice-census.txt` 是冻结基线，**不能**批量重录；文件删除会让 `slice-classification.test.ts` 的「recorded MINUS current」断言变红，正确做法是在该测试的 `RECORDED_LOSSES` 里逐路径登记 bucket 与原因。
- **超时必须传到 provider**：`AIClient.streamChat` 的 options 支持 `signal`，Anthropic 侧会把它交给 SDK 与 idle timeout。8 秒超时要真的掐掉请求，`AbortController` 的 signal 必须传进 `streamChat`，否则只是停止等待、请求仍在跑。
- **每个 turn 多一次 provider 请求**：预测建议是一次真实模型调用。eval 的 `providerRequestsWithin` 统计的是**这次运行对 provider 发出的全部请求**，不只是 agent turn 本身——首轮原本就是 2 次（turn + 标题生成），加上建议后是 3 次。这是产品成本的实际变化，所以两个 offline case 的天花板按实测各 +1（2→3、4→5），并在 `evals/agent/README.md` 里写清这个预算到底统计什么。
- **CI 门禁有三处会因本次改动变红，各有各的规定修法**：
  - `architecture:self-test`：`module-dependency` 实测 96 → 95（删掉的 `next-step-llm.ts` 里有一条 main → renderer 的依赖边），改 `architecture-policy.yaml` 的 `selfTest` 计数，**不动** baseline 指纹。
  - `h8-2-consumer-inventory`：worker 里新增了一处 `.streamChat(` 调用点，必须在 `NOT_TURN_ENTRIES` 登记一行（否则算成未分类的 turn 入口），并把行数断言从 9 改到 10。
  - `evals/agent/runner/run-suite`：见上一条。

- **生成放在 worker，不放 Host HTTP 层**：turn 后派生物已有同构先例——`title-generator.ts`（turn 后单发 LLM）与 `turn-review.ts`（turn 后 git diff）都在 `packages/host/src/worker-session/`，由 `worker-process-entry.ts` 在消息落库后 fire-and-forget 触发。模型客户端用 `agent.readModelClient()`（`worker-session-runtime.ts:188`），因此**不再需要 Electron provider store**，也不再需要自己拼 fetch。
- **落库而非只走事件**：`chat_turn_reviews` 先例表明三端一致读法 = 落库 + Host 路由。建议存 `chat_turn_suggestions`（main 库，migration id 60，现最大 id 59），worker 经 `sendDbRequest('turn-suggestion:save')` 写入（`worker-db-client.ts:465` 形状），Host db bridge 派发（`worker-db-bridge.ts:1187`），Desktop 侧还有一份 bridge（`apps/desktop/src/main/agents/db-bridge.ts:2342`）要同步加。
- **共享 UI 的双路范式**：`packages/ui/src/lib/ipc-client.ts` 用 `peekUiServices()` 分流——有则走 Host/Web，没有则 `window.electronAPI!`（例 `:539`、`:544`）。Desktop **没有**装配 `UiServices`（`apps/desktop/src/renderer/main.tsx` 只装 workspace-lifecycle），所以新能力必须保留 electronAPI 回落，否则 Desktop 直接失效。Web 有 `UiServices`（`apps/web/src/main.tsx:11`），但 BFF 是逐路由显式转发（`apps/web/src/server/web-bff.ts:146` 起），要新增 `/api/...` 路由。
- **呈现形态取 placeholder**：Claude Code 把建议放在输入框 placeholder（`PromptInput.tsx:2014`），不放在消息流里。共享 UI 的 placeholder 由 `MessageInput.tsx:189` 的 prop 决定，灰字靠 `RichTextInput.tsx:396` 的 `data-placeholder` 渲染（伪元素，不可点击）→ 采纳用 Enter，**不需要**改 RichTextInput。
- **采纳沿用 prefill 事件**：`dispatchPrefillChatInput`（`packages/ui/src/lib/prefill-chat-input-event.ts:31`）语义正是「外部注入文本 + 聚焦 + 可见可编辑 + 不自动发送」，唯一消费方是 `MessageInput.tsx:1111`。
- **TUI 没有 placeholder 概念**：composer 只画用户文本（`packages/cli/src/tui/composer-layout.ts:45`、`TUIApp.ts:1598`），灰字提示只在交互弹窗里有（`TUIApp.ts:2064`）。采纳可用 `recallIntoComposer`（`TUIApp.ts:929`）。
- **读取是短轮询，不是单次读**：worker 的预测在 turn 结束后才落库（多一次模型调用），所以客户端轮询到「属于本轮」的行为止；用 `createdAt >= turn 结束时刻 - 1.5s` 判定新鲜度，**空建议也是本轮的答案**（写空串），据此区分「本轮没有建议」和「还没写完」。
- **不做 suggestion speculation**：Claude Code 的预跑建议 turn 收益不确定、成本高，本轮不引入。
- **架构基线不动**：`architecture-check --write` 会往 `.architecture-baseline.json` 追加 328 条指纹（其中 251 条是 permitted），那是规则禁止的「加指纹掩盖」；门禁本身退出码 0，只提示 3 条因本次删除而失效的旧指纹，保持原样。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `270ba528` + 本次改动 | Windows 11 / Node 22 | `npx vitest run packages/ui/src/i18n packages/ui/src/hooks packages/ui/src/components/chat packages/cli/src/tui packages/host/tests packages/data/tests` | 0：405 passed / 1 skipped（406 文件） | `$env:TEMP\duya-test.log` |
| 同上 | 同上 | `npm run architecture:check` | 0：无新增边界违规（3 条旧指纹随删除失效，未重录） | 见「发现与决策」末条 |
| 同上 | 同上 | `npx tsc -p packages/ui/tsconfig.json --noEmit` | 0 | 共享渲染层类型通过 |
| `885e7ff7`（合并 master `77bd7848` 后） | 同上 | `npm run typecheck:all` 分段 | 0：protocol / client-core / core / workflow / runtime / web / electron gate / cli / web-app / voice / evals / eval:agent:core 全过 | electron gate 首次报 1 条新错误（desktop 缺 paths 映射），补映射后为 0 |
| 同上 | 同上 | `npx vitest run scripts/architecture packages/ui/src/i18n packages/ui/src/hooks packages/ui/src/components/chat packages/cli/src/tui packages/host/tests packages/data/tests` | 0：423 passed / 1 skipped（424 文件，4177 用例） | `$env:TEMP\duya-test-final.log` |
| 同上 | 同上 | `npm run architecture:check` | 0：无新增边界违规 | 3 条旧指纹失效，未重录 baseline |
| 同上 | 同上 | `npm run bundle:worker` | 0：worker bundle 重建，产物含 `turn-suggestion:save` 与 `/v1/local/turn-suggestions` | bundle 内符号名被压缩，按字面量与 metafile 输入集核对 |
| `badc8005`（PR #496 首轮 CI） | GitHub Actions / ubuntu-22.04 | `Test` workflow | 失败：3 处门禁红 | `architecture:self-test`（96 vs 95）、`h8-2-consumer-inventory`（未分类调用点 + 行数）、`evals/agent/runner/run-suite`（provider 请求 3 > 2） |
| 同上 | 本地 | `node scripts/architecture/architecture-check.mjs --self-test` | 0：every known violation is visible | 改 `architecture-policy.yaml` 的 `selfTest` 计数后 |
| 同上 | 本地 | `npx vitest run apps/desktop/src/main/__tests__/h8-2-consumer-inventory.test.ts` | 0：7 passed | 登记 `NOT_TURN_ENTRIES` 一行后 |
| 同上 | 本地 | `npm run eval:agent:smoke` | 0：20 checks 全过（改预算前 2 个 case 红） | 实测 3 / 5 次请求，与新天花板一致 |
| 同上 | 本地 | `npx vitest run`（全量） | 见下 | 首轮 CI 漏掉的是子集外的文件，本地必须跑全量 |

## 接续 / 结果

- 已实现：S0–S7 全部完成，代码在 `codex/next-step-suggestions`（PR #496）。
- 已验证：本地类型门禁、架构门禁、相关测试全部退出码 0；CI 第二轮 **5 个 job 全绿**（architecture / test scope / typecheck / test / build，run 40205690754，head `0f8c073d`）。真机三端对话未跑。
- PR：#496 `feat(agent): move the next-step suggestion into the worker`。
- 阻塞：无。
- 下一步：等 review；真机按「测试计划」逐端走一轮，确认 turn 结束后 placeholder 出现灰字建议、Enter 采纳后变白实字且不发送。
- 待定：生成方式（turn 后单独一次模型调用 / agent 工具调用 / 纯本地推导）已向用户征询，未答复前不改实现。
