# TUI Slash Command 四方调研 + duya 对照分类

> 调研日期：2026-10-15
> 参考对象：`E:\cloned-projects\{minimax-code, codex, grok-build, claude-code-haha}`
> 对照基线：`E:\Projects\duya`（当前 HEAD）
> 方法：逐个项目定位 slash 命令注册表源码，全量提取命令名/参数/描述/file:line；再定位 duya 四层命令体系（桌面注册表 / 桌面弹窗 / 桌面提交分发 / CLI TUI / Agent CLI），逐条对照。

---

## 1. minimax-code（packages/tui，TypeScript）

**注册表**：`packages/tui/src/application/command-descriptors.ts`（11 个 canonical descriptor）+ `packages/tui/src/tui/controller/product/command-flow.ts:957-1282`（46 个 handler，权威全集）。分发：`TuiCommandCatalog`（`packages/tui/src/tui/commands/catalog.ts`），`submit()` 先经 `parseTuiBashInput` 判 `!` 前缀走 bash，再 `catalog.resolve/dispatch`。另有 `@` 路径补全、contribution 注册（`packages/tui/src/contributions/registry.ts`）。

| 命令 | 参数 | 说明 | 定义位置 |
|---|---|---|---|
| /help | | Show available commands | command-descriptors.ts:7 |
| /new | | Start a fresh session in the current workspace | command-descriptors.ts:11 |
| /model | [args] | Choose a model（showModelPicker） | command-flow.ts:1228 |
| /status | | Show account and model status | command-flow.ts:1135 |
| /doctor | | Check the local config file | command-flow.ts:1175 |
| /context | | Show the Runtime-owned context snapshot | command-flow.ts:1176 |
| /skills | [args] | List built-in and user Skills | command-flow.ts:1231 |
| /mcp | [args] | Inspect MCP capabilities and project configuration | command-flow.ts:1232 |
| /usage | | Show session usage | command-flow.ts:1262 |
| /compact | [args] | Shorten the active conversation | command-flow.ts:1131 |
| /export | [args] | Export the current Session as Markdown | command-flow.ts:1263 |
| /update | | 检查更新 | command-flow.ts:960 |
| /changelog | | 显示更新日志 | command-flow.ts:961 |
| /sessions (/resume) | [args] | 会话管理器，支持按 session 引用直接激活 | command-flow.ts:963-973 |
| /goal | [args] | 目标模式执行（goalFlow） | command-flow.ts:974-980 |
| /plan | [on/off/status/view] | Plan 模式开关/状态/查看最新 plan | command-flow.ts:981-1005 |
| /review | | 转为提交 "Please review my uncommitted changes." | command-flow.ts:1006-1027 |
| /parent | | 激活父会话 | command-flow.ts:1028 |
| /btw | [question] | 开 side session 旁问 | command-flow.ts:1029-1038 |
| /history | | 打开历史记录选择（startHistory） | command-flow.ts:1039-1058 |
| /fork | | fork 当前会话 | command-flow.ts:1059 |
| /rewind | | 回滚到更早 turn | command-flow.ts:1060-1081 |
| /edit | | 编辑某条消息 | command-flow.ts:1082-1101 |
| /retry | | 重试上次失败消息 | command-flow.ts:1102 |
| /rename | [title] | 重命名会话 | command-flow.ts:1103-1120 |
| /archive | | 归档会话 | command-flow.ts:1121-1130 |
| /tasks | | 后台任务视图 | command-flow.ts:1136-1143 |
| /permission | [status/ask/auto/full] | 权限模式（default/auto/bypassPermissions） | command-flow.ts:1144-1169 |
| /login | | MiniMax OAuth 登录（region picker） | command-flow.ts:1170-1173 |
| /logout | | 登出 | command-flow.ts:1174 |
| /steer | | 向活跃 turn 注入引导 | command-flow.ts:1177-1190 |
| /feedback | [text] | 发送反馈 | command-flow.ts:1191 |
| /checkin | | 每日签到 | command-flow.ts:1192 |
| /settings | | TUI 模式设置（chat/full 等） | command-flow.ts:1193 |
| /statusline | | 状态行开关 | command-flow.ts:1194 |
| /hotkeys | | 键位定制 picker | command-flow.ts:1195 |
| /reload | | 重载 TUI 配置 | command-flow.ts:1196-1227 |
| /provider | | Provider 管理器 | command-flow.ts:1229 |
| /plugins | [args] | 插件管理 | command-flow.ts:1230 |
| /add-dir | [path] | 添加 workspace 目录 | command-flow.ts:1233-1253 |
| /decision | | 显示待决策交互 | command-flow.ts:1254-1260 |
| /permissions | | 权限面板 | command-flow.ts:1261 |
| /transcript | | 显示 transcript | command-flow.ts:1264 |
| /copy | | 复制最后一条回复 | command-flow.ts:1265 |
| /stop | | 中断当前 turn | command-flow.ts:1266-1270 |
| /queue | | 队列管理 | command-flow.ts:1271-1279 |
| /quit | | 退出 | command-flow.ts:1280 |

特殊前缀：`!` = bash 模式（`parseTuiBashInput`，command-flow.ts:284）。

---

## 2. codex（codex-rs/tui，Rust）

**注册表**：`codex-rs/tui/src/slash_command.rs:12-83`（`SlashCommand` enum，56 个变体，展示顺序即枚举序）；辅助过滤 `codex-rs/tui/src/bottom_pane/slash_commands.rs`（feature gating：sandbox/collaboration/connectors/plugins/token-activity/service-tier/goal/personality）；分发 `codex-rs/tui/src/chatwidget/slash_dispatch.rs`。别名：`stop`=`clean`，`pets`=`pet`，`approve`=AutoReview，`pwd` 序列化 `cwd`。动态来源：custom prompts（`~/.codex/prompts/*.md`）、service-tier 命令（model 后插入）。`!` = bash 模式。

| 命令 | 说明（slash_command.rs:87-151） |
|---|---|
| /model | choose what model and reasoning effort to use |
| /ide | include current selection, open files, and other context from your IDE |
| /permissions | choose what Codex is allowed to do |
| /keymap | remap TUI shortcuts |
| /vim | toggle Vim mode for the composer |
| /setup-default-sandbox | set up elevated agent sandbox |
| /sandbox-add-read-dir | let sandbox read a directory |
| /experimental | toggle experimental features |
| /approve | approve one retry of a recent auto-review denial |
| /memories | configure memory use and generation |
| /skills | use skills to improve how Codex performs specific tasks |
| /import | import setup, this project, and recent chats from Claude Code |
| /hooks | view and manage lifecycle hooks |
| /review | review my current changes and find issues |
| /rename | rename the current thread |
| /new | start a new chat during a conversation |
| /archive | archive this session and exit |
| /delete | permanently delete this session and exit |
| /resume | resume a saved chat |
| /fork | fork the current chat |
| /app | continue this session in the Desktop app |
| /init | create an AGENTS.md file with instructions for Codex |
| /compact | summarize conversation to prevent hitting the context limit |
| /plan | switch to Plan mode |
| /goal | set or view the goal for a long-running task |
| /agents | view and switch between all active agent sessions |
| /side | start a side conversation in an ephemeral fork |
| /btw | start a side conversation in an ephemeral fork |
| /copy | copy the last response, code block, or quote |
| /export | export the conversation as markdown |
| /raw | toggle raw scrollback mode |
| /diff | show git diff (including untracked files) |
| /mention | mention a file |
| /status | show current session configuration and token usage |
| /cd | change the current working directory |
| /pwd | show the current working directory |
| /usage | view account usage or use a usage limit reset |
| /debug-config | show config layers and requirement sources |
| /title | configure which items appear in the terminal title |
| /statusline | configure which items appear in the status line |
| /theme | choose a syntax highlighting theme |
| /pets | choose or hide the terminal pet |
| /mcp | list configured MCP tools; use /mcp verbose for details |
| /apps | manage apps |
| /plugins | browse plugins |
| /logout | log out of Codex |
| /quit /exit | exit Codex |
| /feedback | send logs to maintainers |
| /rollout | print the rollout file path（debug only） |
| /ps | list background terminals |
| /stop | stop all background terminals |
| /clear | clear the terminal and start a new chat |
| /personality | choose a communication style for Codex |
| /test-approval | test approval request（debug only） |
| /subagents | switch between this session's subagents |
| /debug-m-drop, /debug-m-update | DO NOT USE（debug only） |

---

## 3. grok-build（Rust，shell + pager 双前端）

**Shell 端注册表**：`crates/codegen/xai-grok-shell/src/session/slash_commands.rs:47-303`（`BUILTIN_COMMANDS` 20 个，带 `BuiltinGate` 能力门控：AlwaysOn/Feedback/Memory/MemoryConfigured/Scheduler/Hooks/Plugins/Goal/WorkflowLaunches/WorkflowManagement）。**Pager 端**：`PAGER_COMMAND_KEYS`（slash_commands.rs:426-534，~110 个保留名），用户文档 `crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md`（权威说明）。skills（user-invocable）+ workflows 也进同一菜单，命名冲突时 builtin 持裸名、skill 持限定名（`local:xxx`）。ACP `AvailableCommand` 广告（available_commands()）。

### Shell builtins（20）

| 命令 | 参数 | 说明 | 门控 |
|---|---|---|---|
| /compact | [context] | Compress conversation history to save context window | AlwaysOn |
| /always-approve (/yolo) | on/off | Toggle always-approve mode | AlwaysOn |
| /flush | | Flush conversation memory to disk now | Memory |
| /dream | | Run memory consolidation | Memory |
| /memory (/mem) | on/off | Browse, view, and manage your memories | MemoryConfigured |
| /context | | Show context window usage and session stats | AlwaysOn |
| /hooks-trust | | Trust this project for hook execution | Hooks |
| /hooks-list | | Show hooks loaded in this session | Hooks |
| /hooks-add | [path] | Add a custom hook file or directory | Hooks |
| /hooks-remove | [path] | Remove a custom hook file or directory | Hooks |
| /hooks-untrust | | Remove trust for the current project | Hooks |
| /plugins (/plugin) | list/reload/trust/add/remove/install/uninstall/update | Manage plugins | Plugins |
| /reload-plugins | | Reload plugins from disk | Plugins |
| /session-info (/status /info) | | Show session details (model, turns, context usage) | AlwaysOn |
| /feedback | [text] | Send feedback about the current session | Feedback |
| /deep-research | [query] | Research with bounded parallel agents + cited report | WorkflowLaunches |
| /workflow | [name\|pause/resume/stop/save] | Launch a saved workflow, or manage a run | WorkflowManagement |
| /goal | [objective --budget N\|status/pause/resume/clear] | Set, manage, or check an autonomous goal | Goal |
| /loop | [interval] [prompt] | Run a prompt on a recurring interval（PROMPT_COMMANDS） | Scheduler |

### Pager builtins（用户文档权威列表，节选主要）

- 会话：/new(/clear)、/resume、/dashboard(/agents-dashboard /sessions)、/compact、/context、/session-info(/status /info)、/fork、/rewind(/undo)、/edit-prompt、/copy [n|path]、/export、/quit(/exit)、/home(/welcome)、/delete、/rename(/title)
- 模型/模式：/model(/m) [name] [effort]、/effort [level]、/always-approve、/auto、/multiline(/ml)、/history、/compact-mode、/vim-mode、/minimal、/fullscreen(/full)、/plan [desc]、/view-plan(/show-plan /plan-view)
- 记忆：/memory(/mem)、/flush、/dream、/remember
- 扩展：/hooks、/plugins、/marketplace、/skills
- 媒体：/imagine [desc]、/imagine-video [desc]
- 调度/工作流：/loop、/goal、/deep-research、/workflow、/workflows
- 其他：/theme(/t)、/feedback、/btw、/mcps、/doctor、/release-notes(/changelog)、/docs(/howto /guides)、/tutorial(/tour /onboarding)、/import-claude
- Agents：/config-agents(/agents)、/personas
- 账户：/login、/logout、/usage(/cost) [manage]、/privacy
- 配置/UI：/settings(/config /preferences /prefs)、/timestamps

---

## 4. claude-code-haha（TypeScript/bun）

**注册表**：`src/commands.ts`。`COMMANDS()`（L258-346）= ~55 个用户可见 builtin + feature 门控（KAIROS/BRIDGE/DAEMON/VOICE/UDS_INBOX/FORK_SUBAGENT/BUDDY/WORKFLOW_SCRIPTS/CCR_REMOTE_SETUP/TORCH/ULTRAPLAN 等）；`INTERNAL_ONLY_COMMANDS`（L225-254）= 28 个仅 `USER_TYPE=ant` 可见。分发：`getCommands(cwd)` 合并动态来源 → REPL `findCommand`。动态来源：bundled skills、builtin plugin skills、skill 目录命令、workflow 命令、plugin 命令（含 plugin skills）、MCP skills（feature MCP_SKILLS，`getMcpSkillCommands`）、custom commands（`.claude/commands/**/*.md`，源码内 `loadedFrom: 'commands_DEPRECATED'` 兼容路径）。特殊前缀：`!` bash、`#` memory、`@` file。

| 命令 | 说明（src/commands/*/index.ts） |
|---|---|
| /add-dir | Add a new working directory |
| /advisor | Configure the advisor model |
| /agents | Manage agent configurations |
| /branch | Create a branch of the current conversation at this point |
| /btw | Quick note（旁问） |
| /chrome | Claude in Chrome (Beta) settings |
| /clear | Clear conversation history and free up context |
| /color | Set the prompt bar color for this session |
| /compact | Compact conversation |
| /config | Open config panel |
| /context | Visualize current context usage as a colored grid |
| /cost | Show the total cost and duration of the current session |
| /diff | View uncommitted changes and per-turn diffs |
| /doctor | Diagnose and verify your Claude Code installation and settings |
| /effort | Set effort level for model usage |
| /exit | Exit the REPL |
| /fast | 快速模式 |
| /files | List all files currently in context |
| /help | Show help and available commands |
| /ide | Manage IDE integrations and show status |
| /init | 初始化 CLAUDE.md |
| /keybindings | Open or create your keybindings configuration file |
| /login | 登录/切换账户 |
| /logout | Sign out from your Anthropic account |
| /install-github-app | 安装 GitHub App |
| /install-slack-app | 安装 Slack App |
| /mcp | Manage MCP servers |
| /memory | Edit Claude memory files |
| /mobile | Show QR code to download the Claude mobile app |
| /model | 选择/配置模型 |
| /output-style | Deprecated: use /config to change output style |
| /pr_comments | Get comments from a GitHub pull request |
| /release-notes | View release notes |
| /rename | Rename the current conversation |
| /resume | Resume a previous conversation |
| /session | Show remote session URL and QR code |
| /skills | List available skills |
| /stats | Show your Claude Code usage statistics and activity |
| /status | 显示版本/模型/账户信息 |
| /stickers | Order Claude Code stickers |
| /tag | Toggle a searchable tag on the current session |
| /theme | Change the theme |
| /feedback | 发送反馈 |
| /review | Review a pull request |
| /ultrareview | review 的强化版（内部） |
| /rewind | 回滚对话（checkpoint） |
| /security-review | 安全审查 |
| /terminal-setup | 终端配置 |
| /upgrade | Upgrade to Max |
| /extra-usage | 额外用量 |
| /rate-limit-options | 限速选项 |
| /usage | Show plan usage limits |
| /insights | Generate a report analyzing your Claude Code sessions |
| /vim | Toggle between Vim and Normal editing modes |
| /thinkback, /thinkback-play | 年度回顾 |
| /permissions | Manage allow & deny tool permission rules |
| /plan | Enable plan mode or view the current session plan |
| /privacy-settings | View and update your privacy settings |
| /hooks | View hook configurations for tool events |
| /export | Export the current conversation to a file or clipboard |
| /sandbox-toggle | 沙箱开关 |
| /passes | 内部 |
| /tasks | List and manage background tasks |

内部/门控（不代表可移植性，仅备忘）：/commit /commit-push-pr /ctx_viz /good-claude /issue /init-verifiers /mock-limits /bridge-kick /version /ultraplan /subscribe-pr /reset-limits /onboarding /share /summary /teleport /ant-trace /perf-issue /env /oauth-refresh /debug-tool-call /agents-platform /autofix-pr /backfill-sessions /break-cache /bughunter /force-snip；门控：/fork /buddy /proactive /brief /assistant /bridge /remoteControlServer /voice /peers /workflows /web /torch。

---

## 5. duya 现状（五层 + 断点）

duya 没有一个统一入口，而是五层并存：

| 层 | 文件 | 命令集 | 状态 |
|---|---|---|---|
| ① 桌面注册表 | `apps/desktop/src/renderer/lib/commands/registry.ts:18-192` | 14 条：new(reset) / clear / compact / export / help(?) / status / cost / recap(summary,catchup) / model / review / simplify / doctor / commit / plan / goal(status/pause/resume/clear) | 元数据权威，但**执行器从未被调用** |
| ② 桌面执行器 | `apps/desktop/src/renderer/lib/commands/parser.ts:69-104`（DEFAULT_EXECUTORS） | help/status/cost=dismiss、clear、new、compact/export/model=forward、review..plan="Use the X skill"、goal 分流 | **死代码**：`executeCommand`/`executeByName` 全仓无调用方 |
| ③ 桌面弹窗 | `apps/desktop/src/renderer/hooks/useSlashCommands.ts:30,259-287` | 只显示 /recap；`/help /status /cost /new /clear /model` 被 `HIDDEN_COMMANDS` 隐藏；另有 5 个 settings 子项（thinking/style/compact/btw/focus）+ skills 列表（`electronAPI.skills.list`，user-invocable） | 弹窗与注册表脱节 |
| ④ 桌面提交分发 | `MessageInput.tsx:1818-1849` → `resolveDirectSlash`（`lib/message-input-logic.ts:142-154`） | immediate=true 的只有 info 类 + clear。`/clear`→onClearMessages；`/recap`→requestRecap；`/help /status /cost`→`onExecuteCommand` **props 从未被任何父组件传入**（全仓仅 MessageInput 内部声明）→ **静默吞掉**；其余（/compact /export /model /goal /review...）→ not_slash → **原样当用户文本发给 agent** | 主要断点 |
| ⑤ CLI TUI | `packages/cli/src/chat.ts:611-652`（handleLine） | /exit(/quit /q) /resume /sessions /new /queue[clear\|resume] /clear /help；未知命令 printError | **全实现**（7/7） |
| ⑥ Agent CLI | `packages/agent/src/cli/slash-commands.ts`（COMMAND_REGISTRY L198-236 + initSlashCommands L303-994） | 27 注册：goal/export/copy/transcript/resume(sessions)/new/clear/history/status/retry/undo/title/stop/compress(agents,tasks)/plan/cd/config/model/login/effort/setup/skills/tools/image/help/usage/quit(exit,q) | **8 个 stub**：retry/undo/title/stop/compress/agents/plan/usage 的 handler 是 TODO 或 "coming soon"；usage L972-979 "coming soon" |

**动态来源**：skills 四路加载（`~/.duya/skills` user、`<cwd>/.duya/skills` + `<cwd>/.agent/skills` project、`agent.skill_path` custom、plugin skills；`apps/desktop/src/main/ipc/skills-handlers.ts:430-483`）→ user-invocable skills 进 `/` 弹窗（agent_skill）。**没有** custom commands 目录（`.duya/commands/*.md`）、**没有** MCP prompts 暴露（MCP core 只有 tools，`packages/plugin-core/src/mcp` 无 listPrompts）。

**架构伏笔**：`packages/host/src/worker-compaction/engine-sources.ts:125-131` 明确写着 `manual` compaction "is a slash command handled outside the loop entirely" —— 即设计上预期有一个 loop 外处理的 `/compact` slash 命令，当前未接线（桌面把 `/compact` 当文本发给模型）。

---

## 6. 三分法对照

### A 类：duya 已有接口/后端能力，容易实现（主要是 UI/命令接线）

| 命令 | duya 现有能力（file:line） | 缺口 |
|---|---|---|
| /model | ProviderModelEditor、ChatView model picker、conversation-store setSessionModel、agent CLI /model 完整实现（slash-commands.ts:772-798） | 弹窗隐藏 + 提交走文本；接 picker 即可 |
| /login /logout | Provider 设置 UI（ProviderEditView/ProviderQuickConnect）、agent CLI `providerLogin` bridge（slash-commands.ts:800-819） | 缺命令入口 |
| /permission(s) | PermissionMode UI（App.tsx/ChatView/MessageInput 引用） | 缺命令入口 |
| /cost /usage /status /help | usage 显示（ContextLedger，plan 577）+ resolveDirectSlash immediate 分支 | `onExecuteCommand` 接线即修复（当前被静默吞） |
| /export | agent CLI handleTranscriptCommand 完整（slash-commands.ts:334-351） | 桌面接文件对话框 |
| /copy | agent CLI 实现（clip/pbcopy/wl-copy，slash-commands.ts:353-386） | 桌面接 clipboard |
| /transcript | agent CLI 实现（slash-commands.ts:388-409） | 桌面缺 |
| /rename /title | 会话重命名 UI（projects-store） | 缺命令 |
| /resume /sessions | CLI TUI 已实现（chat.ts:620-629）；桌面有会话侧栏 | 桌面缺命令入口 |
| /new /clear | 桌面 /clear 已实现；/new 在注册表（resetSession） | /new 弹窗被隐藏 |
| /queue | CLI TurnQueue 已实现（chat.ts:630-641） | 桌面缺 |
| /stop | 桌面 Esc 中断（abortLiveTurn 等价物） | 缺命令 |
| /btw | side chat settings 项已存在（useSlashCommands.ts:168-177） | 缺 /btw 命令 |
| /effort | thinking settings 项 + agent CLI /effort（DUYA_REASONING_EFFORT，slash-commands.ts:821-881） | 缺命令 |
| /goal | goal mode 完整（goal-commands.ts handleGoalCommand、ModeTracker plan 411） | 桌面缺命令入口 |
| /review /commit /simplify /doctor /plan | agent_skill 已接线（dispatchBadge → "Use the X skill"，message-input-logic.ts:174-178） | 已有 |
| /skills | skills 系统 + 弹窗 agent_skill 项 | 缺显式 /skills 列表命令 |
| /diff | Code Review panel（git:review / git:review-diff IPC） | 缺 /diff 命令入口 |
| /image | agent CLI /image（imageCmds，slash-commands.ts:922-938） | 桌面缺 |
| /deep-research | research mode（plan 423：research_start/report 工具） | 缺命令入口 |
| /context | ContextLedger/usage 锚点（plan 577） | 缺命令入口（需接展示面板） |
| /loop | automation/cron 系统（apps/desktop/src/main/automation） | 缺 slash（中等工作量） |
| /memory | packages/memory + MemoryRagCard | 缺命令（后端在） |
| /mcp | MCP capability core（plan 580：ConnectionStore、IPC、设置 UI） | 缺命令入口（中等） |
| /add-dir | workspace roots（projects-store、registerLocalDirectory） | 缺命令（中等） |

### B 类：实现了一半（有定义/有 UI，dispatch 断或被吞）

1. **parser.ts 整个执行层是死代码** —— `DEFAULT_EXECUTORS`/`executeCommand`/`executeByName` 设计完整（compact/export/model=forward、goal 子命令分流），但无调用方；MessageInput 只走 `resolveDirectSlash`。这是所有"半个命令"的总根因。
2. **/help /status /cost 被静默吞** —— immediate=true 进入分支，但 `onExecuteCommand` props 从未传入（全仓无 `onExecuteCommand={`），输入即消失，无任何反馈。
3. **/model /compact /export /goal** —— 注册表 + executor 都有，弹窗隐藏或走"原样发 agent"文本路径；agent 侧对裸 `/compact` 文本无特殊处理（manual trigger 未接线，见 worker-compaction UNCOVERED_TRIGGERS）。
4. **CLI /help 只有一行** —— `chat.ts:643` 只 print `/resume /sessions /new /clear /exit`，而 agent CLI /help 有完整分类列表（slash-commands.ts:941-966）。
5. **Agent CLI 8 个 stub** —— /retry /undo /title /stop /compress /agents /plan /usage（"TODO: implement"/"coming soon"，slash-commands.ts:556-660、968-980）。
6. **skills-as-slash 半通** —— 弹窗插入 `/skill` 可用，提交后是纯文本 chip，靠 host skill 注入（worker skill-injections）生效；无参数提示、无 description 来源标注（claude 的 formatDescriptionWithSource 等价物）。

### C 类：duya 完全没有

| 命令 | 参考实现 | duya 现状 |
|---|---|---|
| /fork | 四方全有（会话分叉） | 无任何 fork 概念 |
| /rewind /undo | claude/codex(无)/grok/minimax | 无会话回滚 |
| /delete /archive | codex/grok/minimax | 无命令 |
| /init | claude/codex（生成 AGENTS.md/CLAUDE.md） | 无 |
| /history | minimax/grok（prompt 历史搜索面板） | 无 |
| /hooks /hooks-* | claude/codex/grok | 有 hook 机制，无命令 |
| /plugins /marketplace /reload-plugins | claude/codex/grok/minimax | 有 plugin 系统，无命令 |
| /agents /dashboard /personas /subagents | claude/codex/grok | 有 subagent，无命令 |
| /theme /vim /keymap(/keymap /hotkeys) /statusline /multiline /timestamps /compact-mode /raw | claude/codex/grok | 无 |
| /terminal-setup /ide /sandbox-* /experimental /debug-config /ps /rollout | claude/codex | 无（sandbox 包存在但无 slash） |
| /release-notes /changelog /update /docs(/howto) /tutorial(/tour /onboarding) | claude/codex(import)/grok/minimax(update/changelog) | 无 |
| /import-claude /import | grok/codex | 无 |
| /feedback | 四方全有 | 无 |
| /privacy /privacy-settings /upgrade /extra-usage /rate-limit-options | claude/grok | 无 |
| /mention /pwd /cd(桌面) /steer /decision /checkin /parent /edit /tasks /files /stats /insights /tag /branch /color /stickers /mobile /desktop /teleport /session /pr-comments /install-*-app /advisor /output-style /security-review /passes /memories /approve /side /app /apps /personality /pets /imagine-video | 各自特有 | 无 |
| **MCP prompts 作为 slash 命令** | claude（`/mcp__server__prompt`）、grok（skills 目录等价） | MCP core 仅 tools，无 prompts 支持 |
| **custom commands 目录** | claude `.claude/commands/*.md`、codex `~/.codex/prompts/*.md` | 无（只有 skills 目录机制） |
| **服务端动态命令** | codex service-tier commands（/model 后插入） | 无 |
| **workflow slash** | grok /workflow /workflows、claude /workflows(门控) | 有 WorkflowRunStore 后端，无 slash |

---

## 7. 落地建议（按性价比排序）

**P0 — 修复断点（小改动，立竿见影）**
1. 把 `resolveDirectSlash` 的 immediate 分支接到 `parser.ts` 的 `executeCommand`（或直接在 MessageInput 实现 help/status/cost 的 UI 面板）——修复"输入即吞"。
2. `/model`：弹窗解除 HIDDEN，提交分流到 ChatView 现有 model picker。
3. CLI `/help` 换用 agent CLI 的 `getGatewayHelpLines`/分类列表。

**P1 — 低成本补齐（后端已在，做命令入口）**
/login /logout、/permission、/cost、/context、/export、/copy、/transcript、/rename、/resume(桌面)、/stop、/btw、/effort、/goal、/diff、/deep-research、/new(解除隐藏)。

**P2 — 中等工作量（新交互，后端部分在）**
/loop（接 automation）、/mcp（接 MCP capability core 列表）、/memory、/hooks、/plugins、/agents、/theme、/vim、/keybindings、/statusline、/queue(桌面)、/add-dir。

**P3 — 大型/需设计**
/fork、/rewind、/delete/archive、/history 面板、/init、MCP prompts 暴露（需 MCP core 加 prompts 能力，plan 581 评估项）、custom commands 目录（`.duya/commands/*.md`）、service-tier 动态命令、/imagine-video。

**建议的注册表演进**：把五层合并为单一 registry（扩展 `CommandDef`：`handler` 直接带执行闭包 + `availableWhen` 上下文谓词 + `dynamic` 来源声明），桌面/CLI/agent 三端共用——对标 grok 的 `EffectiveCommandCatalog`（builtin+skill+workflow 三源统一去重）与 codex 的 `find_builtin_command`（精确查找与 popup 过滤分离，保证隐藏命令仍可精确触发并给出针对性提示）。
