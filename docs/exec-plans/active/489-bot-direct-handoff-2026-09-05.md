# 489 交接提示词 — BotDirectChat 数据流 + 最小卡族（2026-09-05 会话产出）

> 用途：把 2026-09-05 这轮会话的**已落地成果 + 剩余任务**打包成可直接交给下一个 agent 的提示词。
> 用法：把 §1 的提示词整段贴给新会话，§2–§5 作为它随时可查的事实底座（含精确文件行号）。

---

## 1. 交接提示词（整段复制给新 agent）

```
你接手 duya 仓库（E:/Projects/duya）的 bot 聊天（BotDirectChatView）剩余工作。
2026-09-05 上一位 agent 已把「数据层 SendMessage-only 隔离」和「最小卡片渲染」做完，
但未提交、未做 Electron 真机验证。请按 docs/exec-plans/active/489-bot-direct-handoff-2026-09-05.md
的 T1→T7 顺序推进，先读该文档 §2（已落地清单）和 §3（仓库坑位），再动手。

硬性要求：
1. 开工前先跑 `npx tsc --noEmit`（根，覆盖 src + electron + packages）确认基线绿；
   `packages/agent` 的测试必须用 `npx vitest run --config tests/vitest.config.ts <file>`
   或 `npm run test:run -w @duya/agent`，裸 vitest 会爬到仓库根配置而报找不到 test-setup.ts。
2. 每完成一项任务就地跑对应测试 + `npx tsc --noEmit`，再进入下一项。
3. 不要动 src/**/*.js 与 packages/*/dist —— 全是陈旧编译产物（vite resolve 顺序 .tsx 优先，
   改了不生效且会误导后续排查）。
4. 不要用 `git stash`（本沙箱曾因此丢过 .git 元数据）。要对比基线请用 worktree + 绝对路径。
5. UI 改动按 AGENTS.md 门禁用 Playwright 验证；本仓库已有 13 处与本次改动无关的既有红灯
   （markdown 预处理 / PermissionPrompt / MessageInput），判定基线时先确认它们不是你引入的。
```

---

## 2. 已落地清单（本轮会话，全部未提交）

### 2.1 UI：bot 聊天气泡宽度（已按 grok 截图对齐）
- `src/styles/bot.css`：去掉转写列与 composer 外壳的 `max-width: 690px`，改为跟随面板全宽。
- 保留气泡本体三级限制：`.bot-message-action { width: fit-content; max-width: min(88%, 640px) }`（bot.css:643）、`.bot-chat-bubble` 兜底同值（bot.css:201）。短消息贴合内容成小胶囊、长消息封顶换行。
- 同步更新 `BotDirectChatView.tsx` 与 `bot.css` 的头注释（原 690px 描述已过时）。

### 2.2 P0.3：bot-direct 数据源切换（核心）
- 现状澄清：主进程投影 `db:message:botDirectGetTranscript`（`electron/ipc/db-handlers.ts:427`，`source ∈ {send_message, user}`）、hook `src/components/chat/bot/use-bot-direct-transcript.ts`（加载 + SSE 双侧过滤，8/8 单测）早已有，**但 live 的 `BotDirectChatView.tsx` 之前没接**（只有遗留 `.js` 编译产物接了）。
- 已修复：`BotDirectChatView.tsx:198-205` 接 hook；用 `mergeInFlightOptimisticMessages`（conversation-store 导出的纯函数）把「worker 回合末才落盘」的乐观用户气泡合并进来，避免发送瞬间气泡消失；IPC 未接线（jsdom / web）时回退 props 保证测试可用。
- `src/App.tsx:285` 的 `message:new` 映射补上被丢弃的 `source` 字段。
- 结论：**用户消息不需要过滤**（source='user' 天然可见，worker 回合结束落盘 + `loadThreadMessages` 重载渲染）；**agent 侧必须由数据层过滤**，现在过滤发生在主进程，UI 不再"假装过滤"。

### 2.3 P2.2 最小卡族（新增）
- `SendMessageTool` 的 5 种 type 之前只有 text 能显示，且**卡片载荷根本没落盘**——`ipcMessageToNewEvent` 的 metadata 白名单只放行 4 个 key，url/widget/secret/bcId/images 全被丢。
- 已打通往返链路：
  | 层 | 落点 | 内容 |
  |---|---|---|
  | 工具 | `packages/agent/src/tool/SendMessageTool/SendMessageTool.ts:321-445` | 卡片载荷统一收进 `metadata.sendMessage`（text 的 images 同理） |
  | 写侧白名单 | `electron/ipc/core-db-adapters.ts:368` | 新增 `'sendMessage'` key |
  | 读侧列 | `electron/ipc/core-db-adapters.ts:98`（MessageRow）+ `:644` | 新列 `send_message_meta`（JSON 字符串） |
  | wire | `src/lib/ipc-client.ts`（DbMessage + 自有 `Message` 接口 + `dbMessageToMessage`） | `sendMessageMeta` 解析 |
  | 映射 | `src/stores/conversation-store.ts:464`、`src/App.tsx:286`、`use-bot-direct-transcript.ts:73` | 三处都透传 `sendMessageMeta` |
  | 类型 | `src/types/message.ts:3`（MsgType 扩 4 个 kind）、`:18`（`SendMessageCardMeta`） | — |
  | 渲染 | `src/components/chat/BotSendCard.tsx`（新）、`BotDirectChatView.tsx:138`（分派）、`:153`（卡片行）、`:342`（render 分派） | attachment 芯片 / widget 选项按钮（点击 = onSend）/ cursor-agent 徽章 / secret-request 描述 / text 图片条 |
  | 样式 | `src/styles/bot.css:1350+` | `.bot-send-card__*`，颜色继承 assistant 气泡 token |
- 测试：`src/components/chat/__tests__/BotSendCard.test.tsx`（5 项）、`electron/ipc/__tests__/send-message-meta-roundtrip.test.ts`（3 项，纯函数不碰 better-sqlite3）全绿。
- 顺手修：`packages/conductor/.../CanvasThumbnail.tsx` 的 `vbW/vbH` const→let（TS2588，只有根 `tsc --noEmit` 扫得出）。

### 2.4 澄清：registry 已注册 bot，无需修
`packages/agent/src/prompts/registry.ts:22` 早有 `PromptsRegistry.register('bot', botConfig)`；`botConfig.test.ts` 6/6 全绿（此前"红"是跑法错误，见 §3.2）。

### 2.5 未提交改动清单（2026-09-05 13:10 git status 快照）
```
 M electron/ipc/core-db-adapters.ts             ← P2.2 卡片往返
 M packages/agent/src/tool/SendMessageTool/SendMessageTool.ts  ← P2.2 载荷嵌套
 M src/App.tsx                                  ← source / sendMessageMeta 映射
 M src/components/chat/BotComposer.tsx          ← 并行改动（model preference）
 M src/components/chat/BotDirectChatView.tsx    ← P0.3 + P2.2 分派
 M src/components/chat/bot/use-bot-direct-transcript.ts
 M src/lib/ipc-client.ts                        ← wire 字段
 M src/stores/conversation-store.ts
 M src/styles/bot.css                           ← 气泡宽度 + 卡片样式
 M src/types/message.ts
 M src/components/layout/CreateBotDialog.tsx    ← 并行改动（非本轮）
 M src/components/layout/EditBotDialog.tsx      ← 并行改动（非本轮）
 M src/i18n/en.ts / src/i18n/zh.ts              ← 并行改动（非本轮）
 M src/lib/__tests__/agent-profile-ipc.test.ts  ← 并行改动（非本轮）
?? electron/ipc/__tests__/send-message-meta-roundtrip.test.ts
?? src/components/chat/BotSendCard.tsx
?? src/components/chat/__tests__/BotSendCard.test.tsx
?? src/components/chat/bot/__tests__/model-preference.test.ts
?? src/components/chat/bot/model-preference.ts
?? docs/exec-plans/active/489-bot-direct-handoff-2026-09-05.md
```
注意：仓库存在并行编辑（bot 对话框 / i18n / agent-profile-ipc），T1 提交前请重新 `git status` 并**按主题拆分 commit**，不要把他人改动混进来。

---

## 3. 仓库坑位（必读）

1. **`.js`/`.tsx` 双胞胎**：`src/` 下大量 `X.js` 是陈旧编译产物。vite `resolve.extensions` 顺序为 `.mjs/.mts/.ts/.tsx/.js/.jsx/.json`（`vite.config.ts:16`），live 代码永远是 `.ts/.tsx`。排查"线上行为"只看 ts 源文件。
2. **vitest 配置**：仓库根 `vitest.config.ts:30` 用 `setupFiles: ['./test-setup.ts']`；`packages/agent` 的自有配置在 `tests/vitest.config.ts:7`（`./tests/helpers/setup.ts`）。在 `packages/agent` 里裸跑 `npx vitest` 会爬到根配置 → `Cannot find module .../test-setup.ts`。必须带 `--config tests/vitest.config.ts`。
3. **better-sqlite3 EBUSY**：DUYA.exe 运行时会锁 DB，`electron/db/**`、`electron/ipc/__tests__/core-db-adapters-source.test.ts` 等集成测试会跳过/失败。**纯适配器测试照 `core-db-adapters-source-pure.test.ts` 的写法**（只 import 适配器模块，不碰 sqlite）。
4. **safe-delete shim**：`npm run typecheck:all` 的 agent `clean` 步骤（rmSync tsconfig.tsbuildinfo）会被沙箱删除拦截 shim 卡住 → 用 `npx tsc --noEmit`（根）或 `npm run typecheck -w @duya/agent` 绕开。
5. **根 tsc 覆盖面比单包大**：`npm run -w @duya/conductor typecheck` 曾漏掉 CanvasThumbnail 的 TS2588，根 `tsc --noEmit` 才报。改完请跑根级别。
6. **不要用 `git stash`**：本仓库历史上 `git stash push` 触发过一轮 .git 元数据删除（refs/packed-refs 丢失）。要对比基线用 `git worktree add`（Windows 绝对路径）。
7. **既有红灯（与本次无关）**：`npx vitest run src/components/chat` 有 13 处失败——`markdown-bold-math` / `markdown-heading`（数学与标题预处理启发式）、`PermissionPrompt.test.tsx:301/446/472`（AskUserQuestion 的 "Submit" 文案与展开态）、`src/components/chat/__tests__/MessageInput.test.tsx` + `MessageInputPaste.test.tsx`（plan-task/goal chip、AttachmentBar、paste 解析）。**判定基线时先确认这些不是你引入的**（它们不 import 本次改动的文件）。

---

## 4. 剩余任务 T1→T7

### T1 — 提交当前 WIP（阻塞后续一切）
- 目标：把 §2.5 的改动落成 1–3 个原子 commit（建议：① bot 气泡宽度 ② P0.3 数据源切换 ③ P2.2 最小卡族 + 卡片往返链路）。
- 提交信息用 Conventional Commits（英文，仓库规范），例如 `fix(chat): serve bot-direct transcript from the source-filtered projection`。
- 验收：`git status` 干净；`npx tsc --noEmit` 绿；`npx vitest run src/components/chat/BotDirectChatView.test.tsx src/components/chat/__tests__/BotSendCard.test.tsx src/components/chat/bot/__tests__/use-bot-direct-transcript.test.ts src/stores/__tests__/conversation-store.mergeInFlight.test.ts electron/ipc/__tests__/send-message-meta-roundtrip.test.ts` 全绿。

### T2 — Electron 真机验证 + Playwright 冒烟（AGENTS.md UI 门禁）
- 目标：验证 ① 气泡宽度观感 ② 重启/切会话后 bot 的 scratchpad/thinking/tool_use 不再渲染 ③ 5 种卡片真机渲染。
- 方法：`npm run electron:dev`，对一个 bot 发消息，并在 bot 侧触发 `SendMessage({type:'widget'|'attachment'|'secret-request'|'cursor-agent'})`；重启应用、切换会话再切回，确认只显示 user + send_message 行。
- 验收：截图归档（建议 `output/`）；DB 直查确认同一会话里 `source='scratchpad'` 与 `source='send_message'` 行同时存在而 UI 只有后者。

### T3 — P0.2 配套侧表（plan 489 P0.2 剩余）
- 目标：建 4 张表 + 0050 迁移：`message_attachments`（已存在，核对）/ `widget_response_pending` / `cursor_cloud_agent_run` / `host_pending_secret`。
- 落点参考：plan 489 第 189-204 行（P0.2 章节）。
- 验收：迁移脚本跑通老库；`SendMessageTool-full.test.ts` 覆盖 5 种 type 的 validate/execute/round-trip。

### T4 — 完整交互卡族（P2.2 收尾）
- secret-request：卡内掩码输入 → 写 connector credential store → 删除 host-pending-secret → resume bot run（当前只有静态描述卡，无输入）。
- cursor-agent：拉真实运行状态（当前只显示截断 bcId）。
- widget：选项点击后写 `widget_response_pending` 并回写"已选"态（当前只发一条用户消息）。
- 验收：对应卡片各有单测；真机走通一次各自闭环。

### T5 — 群聊 / Room 语义（依赖 plan 478）
- 4 张 bot 专用卡：BotDirectCard / RoomRoundMark / RoomPassNote / BotBroadcastCard（仓库里 0 行）。
- 验收：3 人讨论按回合渲染、@mention、pass 静默态可显示。

### T6 — P2.3 / P2.5 / P2.6 / P3（483 承接项）
- P2.3：P0.3 落好后 bot-direct 视图底层不再有 tool/thinking，此项实际含义变为"顶部跳转到 workspace 最近运行"（以 P3.1 的 Activity tab 为锚点）。
- P2.5 卡宿主闭环：未答补问 / secret 回写 / 权限卡过期清场 / reactToMessage / @mention 展开（plan 489 第 271-280 行）。
- P2.6 生命周期：删除 successor、kickstart onboarding 三分支、avatar 即时反映。
- P3.1/P3.2：Bot 资料卡五 tab、Bots/群组设置。

### T7 — 文档回写 + 既有红灯 triage
- 把 P0.3（已接）、P2.2（最小版）在 `docs/exec-plans/active/489-*.md` 里勾选，并补记"卡片载荷走 metadata.sendMessage → send_message_meta"这条数据契约；同步更新 483/491 的 Phase 状态。
- triage §3.7 的 13 处既有红灯：确认与本次无关后，另开 plan 或 tech-debt 条目（`docs/exec-plans/tech-debt-tracker.md`）。

---

## 5. 常用命令速查

```bash
# 类型检查（根，覆盖 src + electron + packages；绕过 safe-delete shim）
cd E:/Projects/duya && npx tsc --noEmit

# renderer 测试（jsdom，仓库根配置）
cd E:/Projects/duya && npx vitest run <file-or-dir>

# agent 包测试（必须带自己的 config）
cd E:/Projects/duya/packages/agent && npx vitest run --config tests/vitest.config.ts <file>

# 本轮改动相关的验收集合
npx vitest run src/components/chat/BotDirectChatView.test.tsx \
  src/components/chat/__tests__/BotSendCard.test.tsx \
  src/components/chat/bot/__tests__/use-bot-direct-transcript.test.ts \
  src/stores/__tests__/conversation-store.mergeInFlight.test.ts \
  electron/ipc/__tests__/send-message-meta-roundtrip.test.ts
```

---

## 6. 关键设计决策（不要改动，除非有明确理由）

1. **过滤必须在数据层**：bot 的 scratchpad/thinking/tool_use 一律不离开主进程（`db:message:botDirectGetTranscript` 的 source allowlist）。UI 层只做渲染，不做过滤兜底。
2. **用户消息不过滤**：source='user' 天然可见；乐观气泡 `persist:false` 只管渲染，落盘由 worker 回合末写入，用 `mergeInFlightOptimisticMessages`（role+content+时间窗去重）避免双显。
3. **卡片载荷必须命名空间化**：统一放 `metadata.sendMessage`，由写侧白名单放行、读侧投影成 `send_message_meta` 列。不要在渲染层猜 payload 结构。
4. **hook 与 store 并存**：`useBotDirectTranscript` 独立于 conversation-store（workspace 视图仍吃未过滤流），bot 视图自包含，避免未来重构把隔离保证打穿。
