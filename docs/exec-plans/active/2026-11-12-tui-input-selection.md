# CLI TUI 输入、选择、工具详情与消息色彩

状态：active。负责人：本会话。更新：2026-11-12。
分支：`codex/tui-cursor-selection`。worktree：`/home/lavachen/.codex/worktrees/tui-cursor-selection/duya`。
base：`2af62ce3c81b059e3e82c5b41e9f5299bdfd61fc`。独占路径：`packages/cli/src/tui/**` 与本文档。

## 目标与边界

- 输入光标稳定显示在当前输入位置，交互表现按用户对 Pi 的预期确认。
- 移除 composer 的实色填充，保留输入文本与边框提示。
- 全屏转录支持普通鼠标拖选，选区反白并通过 OSC 52 复制到终端剪贴板；离开底部时，将回底按钮移到输入框上方居中显示。
- 工具行支持点击展开/收起完整调用参数与结果；错误调用按主题显示红色背景，显示模式保留单块交互。
- 为消息渲染定义基于语义角色与 256 色号的色彩体系；本轮记录方案，后续按该体系逐步迁移渲染器。
- 精简工作台侧栏为单面板与两个会话入口；显示模式菜单只保留极简、默认、详细；路径和活动状态置于输入框下方的两行 footer。
- 对照 Pi 扩展 API 记录 Duya 插件 UI 扩展的可行接口边界；本轮先形成合同建议，不新增通用插件 UI API。
- 本轮仅改 CLI TUI，不改 Host、协议或 Desktop UI。

关联：[Pi / Duya TUI 对照](../../references/pi-tui-workbench.md)、[TUI 全屏框架](2026-11-11-tui-fullscreen-framework.md)。

## 验收

- 在全屏与 inline 两种模式中检查光标、输入背景及选中反馈。
- 全屏滚离底部时，回底提示显示在转录区最后一行、输入框上方居中，点击该提示恢复跟随。
- `full/names/focus/running` 中可见的工具行都能通过点击切换单块详情；展开后显示完整参数和完整结果，收起后恢复当前 view 的预览；错误行及其详情带有 dark/light 主题错误背景。
- 覆盖窄终端、CJK 文本、滚动视口与输入焦点切换。
- 颜色角色不依赖终端自定义 ANSI 色；正文、弱化文本、Markdown、工具输出和状态色均有明确语义 token 与 dark/light 映射。
- 运行受影响的 CLI TUI 检查及仓库要求的类型/架构门禁；记录 SHA、dirty 范围、环境、命令和结果。
- 光标闪烁策略、文本选择按键/鼠标语义以用户回复为准。

## 进度

- [x] 阅读 CLI TUI 约束、当前全屏计划与 Pi 全屏选择实现。
- [x] 按用户确认的闪烁光标与普通拖选语义实现三项改进。
- [x] 验证相关测试、类型检查、架构门禁和真实 PTY 启停。
- [x] 提交并创建 draft PR；未经授权不合并。
- [x] 将回底按钮从底部状态栏移至输入框上方居中，并验证鼠标命中仍可回底。
- [x] 对照 Pi 与 Duya 现有主题，形成消息色彩 token 与色号映射方案。
- [x] 使工具行点击展开完整参数与输出，在 full/names/focus/running 可见模式下验证展开、收起及错误背景。
- [x] 合并 Sess/CTX/View 为单面板，简化会话入口与 context，移除默认资源链接。
- [x] 将显示模式压缩为 Minimal / Default / Detailed，旧命令名做兼容映射。
- [x] 将 fullscreen footer 调整为路径/分支在上、活动状态在下；验证 inline/footer 与提示弹层布局。
- [x] 阅读 Pi 扩展的 widget、header/footer、custom UI、editor/theme、tool renderer 与 RPC 接口，并记录 Duya 合同建议。

## 发现与决策

- 全屏 composer 以前填充主题底色，inline 则将每行包在底色标签中；现在两种模式均透出终端背景。
- 全屏鼠标报告接管按钮事件；普通左键拖动现在在可见转录区维护选区、反色绘制并通过 OSC 52 复制，交互控件仍优先响应点击。
- `placeCursor()` 以前在异步 diff 写出前移动硬件光标，随后被行重绘移走；现在 surface 在每帧 diff 后定位并显示光标，保留终端默认闪烁样式。
- `[↓ Latest]` 原先位于最底部状态栏左侧；现仿照 Pi 叠在转录视口最后一行并水平居中，鼠标命中范围随按钮坐标移动；快捷键文案读取有效 keymap。
- 原有 pointer target 已能点击可见工具标题，但展开主要展示受行数预算限制的结果；现将原始调用 JSON 留在 `ToolBlock.argumentText`，单块展开时格式化完整参数，并将结果行预算放开至完整输出。names/focus 行也始终显示可点击的 disclosure 提示；running 仍只允许其在运行中的行点击，settled 工具仍按 view 过滤。
- 错误调用的标题和结果行由 `toolErrorBg` 主题 token 铺满 pane 宽度；dark 用 `52-bg`，light 用 `224-bg`，文本前景与其余状态色保持原样。
- 用户已确认使用普通终端闪烁光标与无需 Shift 的普通鼠标拖选。
- Duya 已有 dark/light palette，但缺少 `text` 基础正文 token；未包裹语义标签的普通文本继承终端前景色。dark palette 的 `gray/cyan/green` 等 named ANSI 颜色还可被终端主题重定义，因此相同输出会随终端外观改变。
- Pi 的消息颜色有明确的角色层级：`text`、`muted`、`dim`、`thinkingText`、`toolTitle`、`toolOutput`，并分别定义 Markdown heading/link/link URL/code/code block/quote/list 等角色；正文主要是低饱和浅灰，强调色用于结构与语义，不给整段 prose 染色。
- 侧栏重新布局：一个可滚动面板里只留新建/全部会话入口、简要 context、三档显示方式；Skills/Plugins/MCP 继续由现有命令打开。路径从侧栏移除，fullscreen 与 inline footer 均按路径/分支在上、活动与提示在下排列。
- Pi 的扩展 UI 是明确槽位：`ExtensionUIContext` 支持 widget、header/footer、自定义聚焦组件、editor、theme、status/working indicator；工具定义支持 call/result renderer 和 renderer resolver。Duya 本轮只形成受限注册槽位建议，不开放 `TUIApp`/屏幕坐标访问。
- 色彩体系建议固定为 **语义 token → dark/light palette 色号 → renderer tag** 三层。renderer 不直接写色号；前景与背景角色分开命名，背景 token 统一以 `Bg` 结尾。新增 `text` 作为正文默认前景，`muted` 作为次级信息，`dim` 作为辅助/占位信息；内容角色包含 `thinking`、`toolTitle`、`toolOutput`、`user`；Markdown 角色包含 `heading`、`link`、`linkUrl`、`code`、`codeBlock`、`quote`、`listBullet`；状态角色沿用 `accent/success/warning/error`，填充沿用 `promptBg/diff*Bg/search*Bg`。
- 建议的 256 色 token 基线如下（编号是 xterm 256 palette index；映射为前景色，背景角色继续使用 `*-bg`）：

  | Token | Dark | Light | 用途 |
  | --- | ---: | ---: | --- |
  | `text` | 254 | 238 | assistant 正文与默认内容 |
  | `muted` | 248 | 244 | 次级说明、工具输出 |
  | `dim` | 242 | 247 | 时间、占位和弱提示 |
  | `accent` | 141 | 90 | 一般交互强调 |
  | `success` | 114 | 28 | 成功状态、添加内容 |
  | `error` | 203 | 160 | 错误状态、删除内容 |
  | `warning` | 221 | 172 | 警告状态 |
  | `user` | 151 | 28 | 用户消息标记与正文 |
  | `thinking` | 245 | 244 | thinking 正文 |
  | `toolTitle` | 254 | 238 | 工具调用名称 |
  | `toolOutput` | 248 | 244 | 工具结果正文 |
  | `heading` | 221 | 136 | Markdown 标题 |
  | `link` | 75 | 25 | Markdown 链接文字 |
  | `linkUrl` | 245 | 244 | Markdown URL |
  | `code` | 177 | 90 | 行内代码 |
  | `codeBlock` | 114 | 28 | 代码块正文/语法默认色 |
  | `quote` | 248 | 244 | 引用正文 |
  | `listBullet` | 141 | 90 | 列表符号 |

  背景 token 与前景色分开：保留 `promptBg`、`diff*Bg`、`search*Bg`，工具错误行使用 `toolErrorBg=52`（dark）/`224`（light）。所有正文渲染必须显式落到 `text` 或内容角色，避免透传终端默认前景色。色号表是首版建议，合入渲染器时需用 dark/light 真实 PTY 检查长文、选区、代码和链接的辨识度。
- 分阶段实施：先扩展主题 token 并在 `transcript-view.ts` 为 assistant prose、thinking、tool title/output 和 Markdown 统一应用角色；随后迁移其他 TUI renderer 的硬编码颜色。兼容既有 `ThemeTags` 注入点，逐步迁移期间保留默认映射；色彩验证检查 token 覆盖、两套 palette 色号、CJK/代码/链接渲染，以及 dark/light PTY 截图。
- `workspace_get_context` 工具当前不可用，按版本化计划和 Git 状态对账；共享检出干净，HEAD 与 `origin/master` 一致。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2af62ce3`，只读 | Linux x64 / Node 26.13.0 | `git status --short --branch`; 检查 TUI 文档与 Pi 源码 | exit 0；共享检出干净 | 本会话对账 |
| `2af62ce3` + TUI 修改 | Linux x64 / Node 26.13.0 | 7 个 TUI 测试文件；`npm run typecheck:all`; `npm run architecture:check`; `python3 scripts/smoke-tui-pty.py functional ...` | 111 tests passed；typecheck exit 0；architecture exit 0（无新增违规）；PTY 7 项检查全通过 | worktree `codex/tui-cursor-selection`；`git diff --check` clean |
| implementation `2a942f1b0c5e5963be2d4d85c725647810198f1b` | Linux x64 / GitHub Actions | 推送 `codex/tui-cursor-selection` 并创建 [draft PR #631](https://github.com/lava-chen/duya/pull/631) | PR open、draft；architecture queued，test scope running | no merge; CI pending |
| PR head `ca10d76d645bead2eb1b9d40b29ca68a5be9ff0f` | GitHub Actions | `gh pr view 631 --json statusCheckRollup` | architecture, test scope, typecheck, test, build 全部 SUCCESS | PR #631 当前 head |
| base `ca10d76d` + follow button change | Linux x64 / Node 26.13.0 | 7 个 TUI 测试文件；`npm run -w @duya/cli typecheck`; `npm run typecheck:all`; `npm run architecture:check`; `node scripts/build-cli-bundle.mjs`; `python3 scripts/smoke-tui-pty.py content ...` | 113 tests passed；CLI/full typecheck exit 0；architecture exit 0；bundle exit 0；PTY content 6/6 checks passed | diff check clean; PTY capture `/tmp/duya-tui-latest-button-final-pty.log` |
| PR head `f294b17e393389b77399c7f73808079fadf320e8` | GitHub Actions | `gh pr view 631 --json headRefOid,state,isDraft,statusCheckRollup` | PR #631 open、draft；architecture, test scope, typecheck, test, build 全部 SUCCESS | button change 已推送；此 SHA 对应代码改动 |
| PR head `a8550af2538cffeff49c832eab8487eca85af55b` | Linux x64 / Node 26.13.0 | `git diff --check`; `gh pr view 631 --json headRefOid,statusCheckRollup` | `test scope` SUCCESS；architecture/typecheck/test 当时 IN_PROGRESS；文档色号细化为此记录后的 dirty change | 仅任务计划文档有改动，代码 head `f294b17e` 已通过上述全套 CI |
| PR head `d2b1ecacb052fa2b8852e2c11214e525fc8f832e` + 工具详情改动 | Linux x64 / Node 26.13.0 | 4 个 CLI TUI 测试文件；`npm run typecheck:all`; `npm run architecture:check`; `node scripts/build-cli-bundle.mjs`; `python3 scripts/smoke-tui-pty.py content ...`; `git diff --check`; `gh pr view 631 --json headRefOid,statusCheckRollup` | 4 files / 109 tests passed；typecheck:all exit 0；architecture exit 0；bundle exit 0；PTY 6/6 pass；diff check clean；PR test scope SUCCESS、其余 CI 进行中 | thinking body 回归已在 `d2b1ecac` 修复；PTY log `/tmp/duya-tui-tool-disclosure-final3-pty.log` |
| PR head `037791891844d3b7c64df1f00553c0bdf5103274` | GitHub Actions | `gh pr view 631 --json headRefOid,statusCheckRollup` | architecture, test scope, typecheck, test, build 全部 SUCCESS | 这是工具详情代码变更前的 PR head |
| `bc0649969` + 当前工作区改动 | Linux x64 / Node 26.13.0 | 5 个相关 TUI 测试文件；`npm run typecheck:all`; `npm run architecture:check`; `npm run build:cli-dev`; fullscreen PTY `functional` | 相关用例 62/62；typecheck:all exit 0；architecture exit 0；CLI/worker build exit 0；PTY 10 项通过。全 TUI 共 123 文件：1613 passed、1 expected fail，另有 6 项 `tui-file-diff-stream.test.ts` 失败 | 失败签名也出现在 PR #631 旧 head 的必需 test CI；该文件及对应 transcript 渲染源码未改。生成的 Host worker bundle 变化已还原 |
| PR #631 head `cb15fe5493b7b67cda18515c1e0d0db44dbcc933` | GitHub Actions run `43210652815` | `gh pr checks 631`; `gh run view 43210652815 --job 131157218167 --log-failed` | architecture / test scope / typecheck / build 均 PASS；test FAIL，仍是 `tui-file-diff-stream.test.ts` 同 6 项、同一错误签名 | PR 仍为 OPEN / DRAFT；未合并 |
| PR #631 head `9a381c5e2c5b96e35681aba9f3afd68d04efbfef` | GitHub Actions run `43211687631` | `gh pr checks 631` | architecture / test scope / typecheck / build 均 PASS；test FAIL，仍是 `tui-file-diff-stream.test.ts` 同 6 项 | 这是仅含验证记录的文档提交；运行时代码仍是 `cb15fe549` |

## 接续 / 结果

输入、选择、回底按钮、可见工具行点击展开、单面板工作台、三档显示和输入框下方的两行 footer 已实现。Pi 插件 UI 槽位与 Duya 合同建议已写入参考文档；通用插件 UI API 仍未实施。当前相关 TUI 测试 62/62 通过，完整 TUI 目录 123 文件中 122 文件通过、1 个未变更的 `tui-file-diff-stream.test.ts` 文件有 6 个失败：预览渲染只输出 `└ ⏺ write [-]`。相同失败签名出现在 PR #631 旧 head 的 GitHub test job；本轮没有改动该测试及对应 transcript 渲染源码。全量类型/架构门禁、CLI/worker bundle 和实际 PTY smoke 通过。构建改动过的 tracked Host worker bundle 已按生成产物路径还原。

工作台改动已提交为 `cb15fe5493b7b67cda18515c1e0d0db44dbcc933`，验证记录为 `9a381c5e2c5b96e35681aba9f3afd68d04efbfef`，均已推送到 PR #631。最新 CI 的 architecture、test scope、typecheck、build 通过；test 仍因未变更的流式 write 预览 6 项失败。PR 保持 OPEN / DRAFT，未合并。下一步：单独定位 `tui-file-diff-stream.test.ts` 的预览渲染，再更新 PR；不要在未评估该失败时集成。
