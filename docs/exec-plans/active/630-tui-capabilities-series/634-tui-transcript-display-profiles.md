# 634 事件流显示档（TUI 与 Desktop 共享 key）

状态：active（PR A 已交付，PR B 待开工） · 负责人：codex（本检出） · 更新：2026-10-26
分支：`codex/634-tui-display-profiles` · worktree：`.claude/worktrees/634-display-profiles` · base：`d80ca3c6` · owner：本 agent

## 目标与边界

用户在 TUI 输入 `/display` 选择事件流显示组合：思考块（完整/折叠一行/隐藏）、工具组（全部展开/只列名称/只显示正在运行的工具）、工具结果行数等；提供 3–4 个预设档（详细/标准/精简/聚焦运行）加逐项覆盖。配置写共享 settings key，Desktop 转录视图接同一组 key：TUI 改档后 Desktop 生效，Desktop 设置面板出现同组开关。

允许修改：`packages/cli/src/tui/transcript-view.ts`（RenderOptions + 规划分支）、`packages/cli/src/tui/preferences.ts`、`packages/cli/src/tui/slash/settings.ts` 或新 `display.ts`、`packages/ui/` 转录渲染与设置面板、`packages/data/src/main-settings-store.ts` 之上按需加变更订阅。
本次不处理：按会话独立的显示档（先做全局）、主题/字体（另有线）、消息正文内容级过滤。

关联：[系列](README.md)。不依赖 630a（用现有 `openSettings` 行表）；与 [CLI todo 渲染](../2026-10-23-cli-todo-list-render.md)、[TUI 工具状态](../2026-10-24-tui-tool-status-marks.md) 同域，注意 `visibleBlocks` 语义回归。

## 现状事实（2026-10-26 核对）

- `RenderOptions` 已有 `expanded` / `showToolResults` / `toolResultLines` / `expandedBlockIds` / `collapsedBlockIds` / `showThinking?`（`packages/cli/src/tui/transcript-view.ts:91-142`，注释明确 hidden≠collapsed）；缓存 key 与这些字段一致（`transcript-cache.ts:84`）。
- 投影链：RunEvent → LegacyFrame（`tui/host-event-stream.ts:24`）→ `TranscriptModel`（`blocks.ts:407`）→ `planTranscript`/`buildUnits`（`transcript-view.ts:1117/:1073`，同名工具聚 group）→ `renderPlannedBlock` → `visibleBlocks` → `renderTranscript`。
- 偏好已持久化在 Host settings 表 `cli.tui.*`（`packages/cli/src/tui/preferences.ts:7-49`：theme/displayMode/showThinking/expandBlocks/showToolResults 等），读 `client.getSettings()`（`preferences.ts:220`）、写经 `slash/settings.ts:347`；底层是共享 SQLite（`packages/data/src/main-settings-store.ts:4` → `packages/host/src/local-settings-api.ts` → `http-client.ts:1238-1242`），Desktop 内嵌 Host 用同一个 store（`apps/desktop/src/main/cli/desktop-host-api.ts:240`）。
- 缺口一：「只显示运行中工具」无现成字段，需 RenderOptions 新字段 + 渲染分支（见「发现与决策」第二条：实际落在 `renderPlannedBlock`，不在 `buildUnits`）。缺口二：Desktop 与 `packages/ui` 不消费任何 `cli.tui.*` key（grep 为空），Desktop 显示设置走自己的 schema 组。

## 验收

- TUI：`/display` 切「聚焦运行」档后，工具组只剩运行中条目可见、思考隐藏；切「详细」恢复；`/settings` 行表与新字段一致；重进 TUI 偏好保持。
- Desktop：同一 Host 数据目录下改 TUI 档位，Desktop 转录视图在免重启前提下按新档渲染；Desktop 设置面板同名开关与 TUI 读写同一 key、状态互见。
- `typecheck:all`、`architecture:check`、`npm test -- packages/cli packages/ui` 相对基线零新增失败；UI 改动按测试指南用 Playwright 真跑。

## 进度

- [x] PR A（本检出，已提交）：`ToolGroupMode`（`full` / `names` / `running`）进 `RenderOptions` + `renderPlannedBlock` 折叠分支 + 两处缓存 key（per-block 与 `renderOptionsKey`）。原计划的 `thinkingMode` 不做，理由见「发现与决策」。
- [x] PR A：`preferences.ts` 新 key `cli.tui.toolGroupMode` + 解析/回退 + `describeToolGroupMode`；新 `tui/display-profiles.ts`（四档向量、派生 `resolveDisplayProfile`、`displayProfileSettings` 全量四键）；新 `/display` 命令（`slash/display.ts` + `command-catalog` 条目 + `registry` 注册，含 `/display <profile>` 直改与 headless `choose` 两条退路）；`/settings` 增 `Tool groups` 行。
- [x] PR A：`TUIApp` 播种 / `applyTuiPreferences` / `liveTuiPreferences` / `renderOptions` 四处接线，`chat.ts` 从 `effectivePreferences` 播种；切档即刻重绘（`noteTranscriptMutation` 条件纳入 `toolGroupMode`）。
- [ ] PR B：settings 通道变更订阅（Host SSE 或轮询失效），两 surface 应用。当前 TUI 只在启动时播种，Desktop 改 key 不会回灌正在跑的 TUI（`tui-settings-panel.test.ts` 的「labels the rows with what the screen does」把这个事实钉住了）。
- [ ] PR B：Desktop 转录渲染接共享 key + 设置面板开关；light/dark 均验。

## 发现与决策

- 共享载体定为 settings 表 `cli.tui.*` 组（用户拍板「共享同一组配置 key」）：已有双进程读写先例，无需新存储；key 命名保持 `cli.tui.` 前缀以维持单源，即使 Desktop 也消费——前缀含义在 local-settings-api 注释里改述为「转录显示偏好」。
- **「只显示运行中工具」最终落在渲染层而非 `buildUnits` 过滤**（推翻本文件前一条草案）。理由：批处理头 `Read 3 files` 是对同族连续调用的计数，把已结算调用从块数组里删掉会让剩余调用重新分组、头计数说谎，且要在 `visibleBlocks` 复制一份 `buildUnits` 的同族规则。折叠按 `BlockPlan.role` 决定：`running` 下已结算调用渲染零行（连它的 gap 行一起，隐藏内容不占行），但保住槽位；group head 只出摘要行。
- 不做 `thinkingMode` 字段：`showThinking` × `expandBlocks` 已能表达「完整 / 折叠一行 / 隐藏」三态，再加一个字段就是同一事实的第二来源。
- **不存 `cli.tui.displayProfile` key**：档位从四个正交 key 派生。存了就会有档位与开关两处真相——`/settings` 改一行后二者立刻打架，而 Desktop/TUI 共享同一张表会把冲突放大到两个进程。手调过任何一键就报 `custom`，并且不标记任何档位。
- `names` 是默认而非锁：`expanded` 或单块展开仍出正文（读者显式要过内容）；`running` 是行级折叠，展开是正文级请求，两者不同轴，故 `running` 不受展开影响。
- 折叠后可能零行，`renderTranscript` 与 `TranscriptRenderer.lines()` 的选中光标要先判长度，否则会铸出一行 `❯ undefined`。
- 选档写四个 key 而非 diff：只写差值会让老版本存的第四个 key 残留，同一个「标准」在两台机器上意思不同。
- 顺带发现（不在本任务修）：`renderOptionsKey` 未覆盖 `renderer` 字段（plan 615 Phase 0 引入的属性/折叠面切换）。它声称「覆盖渲染器读取的每个输入」，`renderer` 漏了。归 615 收尾。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6` + 本 PR 全部改动（未提交时先跑） | win32 / Node 24 | `npx vitest run packages/cli` | 0 | 123 files / 1460 tests 全通过；node-pty `AttachConsole failed` 是 PTY 用例通过后的退出噪声 |
| 同上 | win32 / Node 24 | `npm run typecheck:all` | 0 | 0 处 `error TS`；electron gate 仍报 9 个基线键收缩（先前既存提示） |
| 同上 | win32 / Node 24 | `npm run architecture:check` | 0 | OK，无新增越界；`module-dependency-permitted` 2762→2763（`preferences` → `transcript-view` type-only），基线内；「3 baseline fingerprint(s) no longer triggered」在 `d80ca3c6` 主检出同样出现，非本改动引入 |
| 同上 | win32 / Node 24 | `npx vitest run packages/command-catalog` | 0 | 30 tests 通过（`/display` 目录条目与 CLI handler 双向对齐） |
| `d80ca3c6`（主检出，只读） | win32 / Node 24 | `node scripts/architecture/architecture-check.mjs` | 0 | 基线对照：total 2872，同样 3 条陈旧指纹提示 |

未做：真机 `duya chat` 里切档观察（`/display` 无头单测覆盖到 `liveTuiPreferences` 与保存键，像素级「渲染器读到 toolGroupMode」目前与既有 `showToolResults` 同等覆盖强度——无 app 级帧断言）。

## 接续 / 结果

PR A：TUI 侧档位、`/display`、`/settings` 行、缓存与偏好全链路，已交付（见上表）。
PR B 下一步：Host settings 变更订阅（TUI 侧失效重读 + Desktop 消费 `cli.tui.*`），Desktop 转录渲染与设置面板开关；完成判据是验收第二段 Desktop 条目与「同一 Host 数据目录下改 TUI 档位，Desktop 免重启生效」。
