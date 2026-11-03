# TUI 文件编辑流式 diff UI

状态：active · 负责人：当前会话 · 更新：2026-11-03
分支：`worktree-tui-streaming-file-diff` · worktree：`E:\Projects\duya\.claude\worktrees\tui-streaming-file-diff` · base：`96121161`（origin/master） · owner：当前会话

## 目标与边界

用户在 CLI TUI 里编辑或创建文件时，看到一个**好看直观**的 diff 视图，并且在文件还在生成时**流式刷新**。

用户已拍板两个方向：

1. 视觉：对齐 codex 的带底色 diff —— 增删行整行背景填充、行号槽专用底色、context 行无底色、文件头 `path (+N -M)`、行号列、`+`/`-` 符号列、`⋮` 分隔 hunk。
2. 范围：允许改到 runtime/protocol 全链路，不限于 TUI 一层。

允许改：`packages/agent-protocol/`（新增 diff 契约）、`packages/capabilities/`（三个工具产出结构化 diff）、`packages/client-core/`（surface metadata + 流式参数助手）、`packages/agent-runtime/src/project/legacy-sse-projector.ts`（转发 metadata）、`packages/cli/src/tui/`（渲染器、主题、block 模型、投影）、`packages/ui/src/lib/streaming-tool-input.ts`（改为 re-export）。

本次不做：语法高亮（`packages/cli` 零高亮依赖，v1 只按 diff 语义配色）；`/diff` slash 命令改造；desktop 端 `apply_patch` 渲染器缺口；合并 `packages/ui` 里两份重复的 `generateDiffString` 逆解析器；新建 `packages/file-diff` 包。

关联：只读对照 `E:\cloned-projects\codex`（不引入依赖、不 vendor）。codex 的 TUI **也没有**流式 apply_patch —— 它在 `chatwidget/protocol.rs:396` 把 core 发出的 `FileChangePatchUpdated` 丢掉了；本计划走的是另一条路（直接消费 `tool.arguments_delta`），desktop 端 plan 461 已经把这条路走通。

## 验收

- `npm run typecheck:all` 通过。
- `npm run architecture:check` 输出与 base 逐行一致（`module-dependency` 保持 95，不得加指纹）。
- 相关测试从检出根跑：`node node_modules/vitest/vitest.mjs run packages/capabilities packages/agent-protocol packages/cli/src/tui`。
- 真机：`npm run build:cli-dev && npm run dev:tui`。**只能人工敲** —— TUI 不能用管道驱动（ink 粘贴语义会把命令当普通消息发走）。

## 进度

- [x] S0 调研与方案定稿（codex / duya / 桌面端三路对照；架构落点核实）
- [x] S1 契约 + 生产端结构化 diff
- [x] S2 metadata 透传链路
- [x] S3 终态 diff 渲染（codex 版式 + 背景色 token）
- [x] S4 流式预览
- [ ] 门禁与 PR

## 发现与决策

- **流式链路是活的，CLI 只是没接。** 协议事件是 `tool.arguments_delta`（`packages/agent-protocol/src/events/payloads.ts:489-492`，ephemeral，delta 是原始 JSON 片段），runtime 在 `packages/agent-runtime/src/engine/run-engine.ts:1338-1356` 真实发出，Host SSE live 通道送到 CLI 的 `packages/cli/src/chat.ts:1736-1751`。CLI 丢在 `packages/cli/src/tui/host-event-stream.ts` 与 `run-session-view.ts` 两处；但 `packages/client-core/src/surface/surface-model.ts:849-855` 的 `SurfaceModel` **已经在累积**（`tool.argumentText += event.delta`），`chat.ts:1748` 已经调过 —— 数据已到 TUI 边界，只需读 snapshot。
- **`packages/cli/src/tui/blocks.ts:918` 的 `case 'tool_use_delta'` 是死代码**：全仓唯一 producer 在 `packages/agent-runtime/src/project/legacy-sse-projector.ts:84`，走桌面 legacy SSE，不通 CLI。形状本就是为这个留的，复活它不改 frame 词汇。
- **census 测试的理由是错的**：`packages/cli/src/tui/__tests__/host-event-projection-coverage.test.ts:110-112` 称「`tool.call_preview` 送完整参数所以丢 delta 无损失」，而 `payloads.ts:443-449` 明写 preview 的 arguments 是 best-effort 非权威。S4 加 arm 后该测试会红，须同片改写理由。
- **架构落点被 policy 锁死**：`capabilities`（managed:true 零容忍）不得依赖 `client-core`；`client-core`（managed:true, `requires:[agent-protocol]`）**加纯 TS 文件 = 零新跨模块边**；`legacy-cli` 已声明依赖 `client-core` 与 `agent-protocol`。⇒ 共享纯函数放 `client-core`，diff 生成放 `capabilities`（已有 `diff@^8.0.4`），**CLI 不新增任何依赖，也不改 `architecture-policy.yaml`**。
- **共享纯函数放 client-core 而不是新建包**：`packages/ui/src/lib/streaming-tool-input.ts` 的 `extractPartialToolFields` / `countContentLines` / `computeLineChangeStat` 已是完整实现（宽松 JSON 前缀扫描，处理 `\uXXXX` 与半截转义；公共前后缀裁剪算 +增/−删）。新建 `packages/file-diff` 要改 policy（新 module id + 两条 requires 边），v1 不值；等第二个生产端出现再抽。
- **默认是 inline 模式，scrollback 冻结是默认路径上的真问题**：`packages/cli/src/tui/preferences.ts:116` `displayMode: 'inline'`。inline 模式不构造 blessed Screen（`TUIApp.ts:403-411`），在终端普通 scrollback 里渲染 ⇒ `terminal/surface.ts:17-23`「committed row 永不反悔」成立。全屏模式走备用缓冲（`screen/own/surface.ts:16-17`）无 scrollback，风险不存在。⇒ 流式块必须限高。
- **限高的数学**：live area 是文档末 `liveRows` 行，`liveWindow` 只提交前缀。流式块位于文档尾部 `[P, P+H)`（工具调用生成期间其后无内容，R=0），它被提交 ⟺ `liveStart > P` ⟺ `H + R > liveRows`。⇒ **不变式 `H ≤ liveRows` ⇒ 没有任何 provisional 行进入 scrollback**。`H` 含段间距、工具行与摘要行三行固定开销，所以内容行取 `min(12, liveRows - 3)`；`liveRows` 未知时只画摘要行；`liveRows < 3` 时整块不画预览。实现时先按 `liveRows - 1` 写，被 `tui-file-diff-stream.test.ts` 的「整块不超过 liveRows」断言抓出少算的两行。
- **统一 diff 走结构化行而非文本**：文本会让每个消费者重新解析 git 的 hunk 语法并丢掉行号；结构化行是纯映射。行号由生产端算一次。
- **不能让 TUI 自己算 diff**：write 覆盖写时 TUI 拿不到旧内容；edit 的 `old_string` 只是片段不是全文。生产端在 execute 时同时持有 pre-image 与 post-image。
- **流式期画「模型正在写什么」，不画 diff**：算 diff 需要旧全文，且部分 `new_string` 的行数随流式增长跳变，视觉抖动。write → partial content 的完整行按新增绿显示；edit → `new_string` 已完整的行按新增绿显示，不画删除行；apply_patch → patch 里已完整收到的 hunk 的 `+`/`-` 行（Codex patch 格式本身含 diff 行）。行号未知时显示 `·`，**列几何不变**，完成时不回流。
- **diff 体不走 `toolResultLines: 5`**：那会把 200 行 diff 砍成 5 行。改用独立预算，头尾截断 + `… N lines hidden …`。
- **折叠态仍显示文件头与 `(+N -M)`**：`showToolResults` 默认 false（`preferences.ts:123`），折叠时只剩摘要才不至于看不出改了文件。
- **无 truecolor**：`packages/cli/src/tui/core/color.ts` 只有 named SGR 与 xterm-256；`theme.ts:14-24` 记录 hex 被量化到 16 色因而否决。codex 自己的 256 降级值直接抄（dark 22/52、light 194/224）。
- **`-bg` 标签不需要改解析器**：plan 611 W1.1 已为 composer 底色支持（`core/tags.ts` 的 `slotFor`、`screen/own/markup.ts` 的 background 分支、`markdown/inline.ts` 的 `tagBodyFor(style.bg,'bg')`，blessed 原生也支持）；新 token 只是新增 `-bg` body。
- **delta 是合并块且可能有空洞**：`packages/agent-runtime/src/events/coalesce.ts:709` 合并相邻 delta；legacy worker stdout 背压下**直接丢弃** delta（`packages/host/src/worker-transport.ts:137-142`）。⇒ 累积器必须容忍空洞，重连会丢 ephemeral ⇒ 最终 `tool.call_started` 必须能干净覆盖流式态。
- **worktree 缺构建产物**：新检出没有 `packages/plugin-core/dist` 等产物，会让 `@duya/plugin-core/mcp/core/alias` 解析失败、10 个测试文件假红。构建 `packages/plugin-core` 与 `packages/agent-protocol` 后恢复。
- **`WriteTool.extractWritePaths` 读错字段**：读 `input.path`，而 schema 字段是 `file_path` ⇒ 每次写都报未知路径，编排器无法给同文件写入排序。S1 顺带修。
- **`*.test.ts` 已不被 gitignore**：`.gitignore:89-92` 明确"Unit tests are tracked like any other source"，新测试文件正常入库，不需要 `git add -f`。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `96121161` + S1 未提交 | Windows 11 / Node | `vitest run packages/capabilities packages/agent-protocol` | 0 —— 69 文件 / 779 例全绿 | build plugin-core 后复跑 |
| `96121161` + S1 未提交 | 同上 | `npm run architecture:check` | 0 —— `module-dependency 95` 与 base 一致，"OK — no new boundary violations" | 基线失败先记录：worktree 缺 `packages/plugin-core/dist` 导致 10 文件假红，非本次改动 |
| `96121161` + S1–S4 全部未提交 | 同上 | `vitest run packages/cli/src/tui packages/capabilities packages/agent-protocol` | 1 —— 179 文件 / 2172 例，唯一失败是 `presets.test.ts` 的 POSIX 权限位（基线，Windows 恒失败），新增 23 例全绿 | 2170 passed / 1 expected fail |
| `96121161` + S1–S4 全部未提交 | 同上 | `npm run typecheck:all` | 0 —— electron gate "no new type errors (178 known across 101 key(s))" | 附注：该 gate 报 10 个 baseline key 缩小/消失，属基线漂移，非本次新增 |
| `96121161` + S1–S4 全部未提交 | 同上 | `npm run architecture:check` | 0 —— `module-dependency 95` 不变，"OK — no new boundary violations" | 附注：报 18 个 baseline 指纹不再触发（债务缩小），未新增指纹 |

基线失败（改动前记录，与本次无关）：`packages/cli/src/tui/slash/__tests__/project-host.test.ts` 缺 `@duya/plugin-core/apps/declarations`（worktree 缺 dist）；`packages/cli/src/tui/slash/__tests__/presets.test.ts` 的 POSIX 权限位断言在 Windows 恒失败（mode 54 = 0o66）。

## 接续 / 结果

- 分支 `worktree-tui-streaming-file-diff`，worktree `E:\Projects\duya\.claude\worktrees\tui-streaming-file-diff`，base `96121161`。
- S1–S4 已实现未提交，待分片提交并开 PR。
- 切片按 3 个 commit 交付（原计划 4 片）：S3 与 S4 共用 `transcript-view.ts` / `blocks.ts` / `host-event-stream.ts` 的相邻 hunk（同一 import 行、同一 `nodeBody` 分支），拆成两片需要逐 hunk 手术且中间态不可编译，评审收益为零。3 个 commit = 契约与生产端 / 元数据与共享助手 / TUI 渲染与流式。
- 真机验收未做：`npm run build:cli-dev && npm run dev:tui` 只能人工敲（TUI 不能用管道驱动）。人工检查点见「验收」。
- 外部副作用：无。阻塞：无。
- 下一步：提交 3 个 commit → 开 PR → 人工真机验收。
