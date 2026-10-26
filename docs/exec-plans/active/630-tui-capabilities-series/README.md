# 630 TUI 四能力系列

状态：active · 负责人：630 系列 owner · 更新：2026-10-26

## 目标与边界

用户在 CLI TUI 内获得四类此前只有 Desktop（或根本没有）的能力：插件市场管理界面、provider 与模型管理、项目切换、事件流显示格式自定义（与 Desktop 共享同一组配置 key）。

本系列不改 agent 推理链、不改 Desktop 既有交互形态（仅让 Desktop 消费共享 key）、不引入 keychain。数据真源仍是 `~/.duya/config.toml` 与 SQLite settings 表；写侧一律下沉 Host，TUI 与 Desktop 都经 HTTP 控制面。

## 切片与集成顺序

| 切片 | 内容 | 依赖 |
| --- | --- | --- |
| [630a 富面板模态原语](630a-tui-rich-panel-modal.md) | slash 触发的全屏模态面板通道 + Tabs/分页/搜索原语 | 无 |
| [631 plugin 市场管理界面](631-tui-plugin-market-ui.md) | Host plugin/marketplace 写路由 + `/plugin` 多 tab 界面 | 630a；写路由还依赖 632 的通用 TOML 命名空间写函数（#514） |
| [632 provider 与模型管理](632-tui-provider-management.md) | Host provider 写路由 + `/provider` 列表/向导/编辑 | 630a |
| [633 项目切换](633-tui-project-switch.md) | `/project` 切换 TUI 会话所在项目 | 无，可穿插 |
| [634 事件流显示档](634-tui-transcript-display-profiles.md) | `/display` 显示组合切换 + Desktop 接共享 key | 无 |

630a 先行合入；集成顺序（2026-10-26 用户拍板）：630a → 632 → 631 → 634 → 633。631 与 632 表面上都只依赖 630a，先后原是排期选择；2026-10-26 复核发现 631 的 Host 写路由还依赖 632 把 `packages/host/src/config-agents/config-file.ts` 的 `[agents]` 专用编辑器通用化，所以「632 先于 631」不再只是排期。

## 参考实现

- 插件界面交互形态：claude-code-haha 仓库 `src/commands/plugin/`（React Compiler 构建产物，原始 TS 在各文件 sourceMappingURL 的 `sourcesContent` 内）。
- provider 管理链路：minimax-code 仓库 `packages/tui/src/features/provider/`、`packages/config/src/config.ts`。
- 两仓库均为本机 `E:\cloned-projects\` 下的克隆，只对照行为，不搬代码。

## 验收

每切片各自的验收写在自身文件；系列级验收：`duya tui` 真机内四命令可用、无 Electron 进程参与、`npm run typecheck:all` 与 `npm run architecture:check` 全绿。

## 接续 / 结果

计划检出：`.claude/worktrees/tui-capabilities-plan` · 分支：`codex/630-634-tui-capabilities-plans` · base：`e9391659`。
下一步：按 630a 计划开工实现 worktree；其余切片在 630a 合入前保持 pending。
