# TUI 本地 shell 命令的专属 UI：红色 `!` 提示与独立的 "You ran" 卡片

状态：complete · 负责人：claude-desktop-code · 更新：2026-10-29
分支：worktree-tui-bang-shell-ui · worktree：E:\Projects\duya\.claude\worktrees\tui-bang-shell-ui · base：220a63ff · owner：claude-desktop-code
集成：PR #533 由 `lava-chen` 以 merge commit `bd526d3b` 合入 master（2026-10-29T00:21:54Z）

## 目标与边界

用户可观察到的变化（限 CLI TUI，`packages/cli/src/tui/`）：

1. 编辑器里首字符是 `!` 时，composer 的提示符从 `❯` 换成**红色的 `!`**，命令正文紧随其后（`!` 不再留在正文里重复出现）。这是 codex 的做法：前缀被提升为提示符本身并染红。
2. 用户本地跑的 `!cmd` 在 transcript 里有自己的卡片：标题是 **"You ran"**（agent 跑的是 "Ran"），并且**不与 agent 的 bash 调用合并成同一组**——本地命令和 agent 命令在视觉上分开。

不处理：Desktop（`packages/ui/`）的 composer；`!!cmd` 的执行语义（保持现状，`!!` 仍是"不进下一条上下文"）；agent 工具卡的其它措辞。

关联：无上级计划（本任务独立）。路径所有权：全部在 `packages/cli/src/tui/` 与 `packages/cli/src/chat.ts`，本会话独占，不与其他任务交叉。对照来源：`E:\cloned-projects\codex` 的 `codex-rs/tui/src/bottom_pane/chat_composer.rs:4900`（前缀吸收与染色：`"!".light_red().bold()`）、`codex-rs/tui/src/bottom_pane/chat_composer/draft_state.rs:12`（`PromptPrefix`）、`codex-rs/tui/src/ui_consts.rs:10`（`LIVE_PREFIX_COLS = 2`）与 `codex-rs/tui/src/exec_cell/render.rs`（user shell 的 "You ran" 标题、独立输出预算）。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/composer-layout.test.ts packages/cli/src/tui/__tests__/composer-paint.test.ts packages/cli/src/tui/__tests__/shell-command.test.ts packages/cli/src/tui/__tests__/tui-tool-render.test.ts` 通过。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。
- 真机：`npm run build:cli-dev` 后 `npm run dev:tui`，输入 `!echo hi` 看到红色 `!` 提示符；提交后 transcript 出现 "You ran" 卡片且不与 agent 的 bash 合并成组。TUI 只能人工敲（ink 不接受管道输入），此项由用户执行。

## 进度

- [x] 读两侧实现（duya composer/TUIApp/transcript-view/tool-render，codex chat_composer/exec_cell）
- [x] 计划文档
- [x] 抽出 shell 前缀规则模块（`tui/shell-command.ts`）
- [x] composer 识别 `!` 前缀 → 红色提示符（composer-layout + composer-paint + TUIApp 染色）
- [x] 本地 shell 独立卡片："You ran" + 独立分组 + 更大输出预算
- [x] 补单测
- [x] 门禁（typecheck / architecture / vitest）
- [x] commit + PR（PR #533，merge commit `bd526d3b`）

## 发现与决策

- **duya 的 composer 没有 prefix 概念**：`buildComposerLayout` 把 `❯ ` 与正文拼成一行后交给上层染色（`TUIApp.colorComposerBody` / `colorComposerRules`），宽度计算全程按无 tag 的纯文本走（`markdown/escape.ts` 明确 width.ts 不解析 tag）。因此"红色 `!`"必须落在**染色层**，不能落在 layout 层。
- **codex 的做法是"吸收前缀"**：`PromptPrefix::Shell` 把 `!` 从 textarea 里拿走，prompt 位置单独画红色 `!`（`chat_composer.rs:4900`，prompt 画在 `textarea_rect.x - LIVE_PREFIX_COLS`，即两列槽）。duya 的 editor 是纯 code point 数组（`InputEditor`），`!` 是普通字符；把显示层剥离首字符（layout 少显示一个字符、光标列相应左移一格）即可得到同样观感，且不碰 editor 的插入/撤销/历史语义。**决定**：在 layout 层做显示剥离，editor 语义不变。
- **前缀规则只有一处**：`tui/shell-command.ts` 的 `shellDraftOf` 是唯一判据，composer（画提示符）与 `chat.ts`（跑命令）都读它。两边若各写一份，composer 会承诺一条 submit 路径当消息发走的命令。
- **前导空白**：submit 路径先 `line.trim()` 再找 `!`，所以 `  !ls` 与 `!ls` 跑同一条命令。composer 的识别因此也从前导空白之后找 `!`，并把这些空白一并算进"提示符覆盖的字符数"，光标相应左移。
- **`!!cmd`**：仍是"不进下一条上下文"。显示上提示符画成 `!!`（两列，与 `! ` 同宽），而不是只剥一个 `!` 把第二个留在正文里——留在正文里会显示成 `! !cmd`，用户看不出那是 opt-out 标记。
- **染色点**：full-screen 走 `colorComposerBody(body, …)`，body[0] 是首正文行；inline 走 `colorComposerRules(layout.lines, …)`，规则行是首末行，body 首行索引 = `hasRules ? 1 : 0`。两处都要染。
- **染色抽成纯函数**：`tui/composer-paint.ts` 的 `paintComposerRow` 是纯函数（无终端可测），TUIApp 只传主题 tag。红色用主题的 `error` tag（dark `bright-red-fg`、light `160-fg`）。
- **本地 shell 卡片用独立 tool name `local_shell`**：`toolGroupKey` 按 name 分族，`bash` 与 `powershell` 同族。给本地卡片独立 name 并在 `toolGroupKey` 里映射到独立 family（`user-shell`），就不必给 `ToolBlock` 加字段——模型层零改动，缓存 key 也天然分开。名字不取 `shell`：插件/MCP 工具可能就叫 `shell`，而写 "You ran" 的卡片必须只指用户自己跑的命令。
- **本地 shell 输出预算**：`selectShellOutput` 走 `options.toolResultLines`（默认 5）。codex 对 user shell 用 50 行、对普通 tool call 用 5 行。本地命令是用户自己要看的东西，给它独立且更大的预算（`LOCAL_SHELL_RESULT_LINES = 50`）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| worktree-tui-bang-shell-ui（未提交） | Windows 11 / Node 24.16 | `node scripts/junction-worktree.mjs .` | 0 | 建 60 条链接（worktree 自有 node_modules 缺失导致） |
| 同上 | 同上 | `npm run build:packages` | 0 | 18 个包构建完成；**副作用**：`scripts/inline-modules.mjs` 把 `packages/capabilities/src/ModuleTool/inline-content.ts` 重写成 CRLF（内容语义不变，`git diff` 为空），与本任务无关，不进提交 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui/__tests__/{composer-layout,composer-paint,shell-command,tui-tool-render}.test.ts` | 0 | 4 文件 / 54 用例全过 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui/__tests__` | 0 | 74 文件 / 905 用例全过 |
| 同上 | 同上 | `npx vitest run packages/cli` | 0 | 128 文件 / 1525 用例全过（`tui-pty.test.ts` 的 node-pty 子进程在无 TTY 环境 AttachConsole 失败，既有问题，与本任务无关） |
| 同上 | 同上 | `npm run architecture:check` | 0 | no new boundary violations |
| 同上 | 同上 | 端到端（inline + full-screen，真终端字节） | 0 | inline 输出 `\x1b[91m!\x1b[m echo hi`；`!!` 为 `\x1b[91m!!\x1b[m`；full-screen 同样含红色 `!`；`beginLocalShell` 卡片渲染出 "You ran" |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 各包 tsc、electron gate、eval 4 用例全过 |
| 同上（master `bd526d3b` 合并后） | 同上 | `npx vitest run packages/cli` | 0 | 130 文件 / 1535 用例全过（较合并前多的是 PR #534 的用例） |

## 接续 / 结果

已实现：`994c03ab`（16 个文件），计划接续 `e059e001`。已验证：`typecheck:all`、`architecture:check`、TUI 套件 905 用例、CLI 全量 1525 用例、inline 与 full-screen 的真终端字节（红色 `!`）与 "You ran" 卡片。已合并：PR #533，merge commit `bd526d3b`（2026-10-29T00:21:54Z）。

未提交路径：无（合并时未暂存的 `packages/capabilities/src/ModuleTool/inline-content.ts` 是 `build:packages` 的 CRLF 副作用，内容语义不变、未进提交）。

回收：worktree `E:\Projects\duya\.claude\worktrees\tui-bang-shell-ui` 与分支 `worktree-tui-bang-shell-ui` 保留，未移除。

下一步：真机冒烟（`npm run build:cli-dev` 后 `npm run dev:tui`，手工敲 `!echo hi` 看红色提示符与 "You ran" 卡片）仍待用户执行；确认后再回收 worktree。
