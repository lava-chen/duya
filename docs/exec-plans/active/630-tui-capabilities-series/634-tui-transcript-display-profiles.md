# 634 事件流显示档（TUI 与 Desktop 共享 key）

状态：active · 负责人：未认领 · 更新：2026-10-26
分支：未建 · worktree：未建 · base：master · owner：无

## 目标与边界

用户在 TUI 输入 `/display` 选择事件流显示组合：思考块（完整/折叠一行/隐藏）、工具组（全部展开/只列名称/只显示正在运行的工具）、工具结果行数等；提供 3–4 个预设档（详细/标准/精简/聚焦运行）加逐项覆盖。配置写共享 settings key，Desktop 转录视图接同一组 key：TUI 改档后 Desktop 生效，Desktop 设置面板出现同组开关。

允许修改：`packages/cli/src/tui/transcript-view.ts`（RenderOptions + 规划分支）、`packages/cli/src/tui/preferences.ts`、`packages/cli/src/tui/slash/settings.ts` 或新 `display.ts`、`packages/ui/` 转录渲染与设置面板、`packages/data/src/main-settings-store.ts` 之上按需加变更订阅。
本次不处理：按会话独立的显示档（先做全局）、主题/字体（另有线）、消息正文内容级过滤。

关联：[系列](README.md)。不依赖 630a（用现有 `openSettings` 行表）；与 [CLI todo 渲染](../2026-10-23-cli-todo-list-render.md)、[TUI 工具状态](../2026-10-24-tui-tool-status-marks.md) 同域，注意 `visibleBlocks` 语义回归。

## 现状事实（2026-10-26 核对）

- `RenderOptions` 已有 `expanded` / `showToolResults` / `toolResultLines` / `expandedBlockIds` / `collapsedBlockIds` / `showThinking?`（`packages/cli/src/tui/transcript-view.ts:91-142`，注释明确 hidden≠collapsed）；缓存 key 与这些字段一致（`transcript-cache.ts:84`）。
- 投影链：RunEvent → LegacyFrame（`tui/host-event-stream.ts:24`）→ `TranscriptModel`（`blocks.ts:407`）→ `planTranscript`/`buildUnits`（`transcript-view.ts:1117/:1073`，同名工具聚 group）→ `renderPlannedBlock` → `visibleBlocks` → `renderTranscript`。
- 偏好已持久化在 Host settings 表 `cli.tui.*`（`packages/cli/src/tui/preferences.ts:7-49`：theme/displayMode/showThinking/expandBlocks/showToolResults 等），读 `client.getSettings()`（`preferences.ts:220`）、写经 `slash/settings.ts:347`；底层是共享 SQLite（`packages/data/src/main-settings-store.ts:4` → `packages/host/src/local-settings-api.ts` → `http-client.ts:1238-1242`），Desktop 内嵌 Host 用同一个 store（`apps/desktop/src/main/cli/desktop-host-api.ts:240`）。
- 缺口一：「只显示运行中工具」无现成字段，需 RenderOptions 新字段 + buildUnits/visibleBlocks 分支。缺口二：Desktop 与 `packages/ui` 不消费任何 `cli.tui.*` key（grep 为空），Desktop 显示设置走自己的 schema 组。

## 验收

- TUI：`/display` 切「聚焦运行」档后，工具组只剩运行中条目可见、思考隐藏；切「详细」恢复；`/settings` 行表与新字段一致；重进 TUI 偏好保持。
- Desktop：同一 Host 数据目录下改 TUI 档位，Desktop 转录视图在免重启前提下按新档渲染；Desktop 设置面板同名开关与 TUI 读写同一 key、状态互见。
- `typecheck:all`、`architecture:check`、`npm test -- packages/cli packages/ui` 相对基线零新增失败；UI 改动按测试指南用 Playwright 真跑。

## 进度

- [ ] `toolGroupMode`（full / names / running-only）与 `thinkingMode`（expand/collapse/hidden 归并现有二态）进 RenderOptions + 规划分支 + 缓存 key。
- [ ] `preferences.ts` 新 key 与预设档组合解析；`/display` 命令（预设 + 逐项覆盖）。
- [ ] settings 通道变更订阅（Host SSE 或轮询失效），两surface 应用。
- [ ] Desktop 转录渲染接共享 key + 设置面板开关；light/dark 均验。

## 发现与决策

- 共享载体定为 settings 表 `cli.tui.*` 组（用户拍板「共享同一组配置 key」）：已有双进程读写先例，无需新存储；key 命名保持 `cli.tui.` 前缀以维持单源，即使 Desktop 也消费——前缀含义在 local-settings-api 注释里改述为「转录显示偏好」。
- 「只显示运行中工具」放在规划层（buildUnits）而非渲染层过滤，避免与 `visibleBlocks` 的行分配/滚动锚定语义打架。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待执行 | win32 / Node 24 | 验收清单全部命令 | — | 基线在开工检出重记 |

## 接续 / 结果

下一步：建实现 worktree，先落 RenderOptions 两字段 + 单测（不动 Desktop）；完成判据是 TUI 档位切换用例全绿。Desktop 接线可拆第二 PR。
