# TUI 对照报告的七项改进

状态：completed · 更新：2026-11-03
实现分支：`codex/pr590-all` · 实现提交：`2307a45c` · base：`bae0896eba19f72379b2c2bede6a3d4438dbdc3e`

## 目标与边界

用户授权把调研报告的七个候选切片都落地，并在验证与 GitHub 必需门禁通过后合并 PR #590。TUIApp 整理聚焦于将 transcript 和状态栏接到已有组件渲染层，避免一次性重写完整应用循环。

1. 接通 transcript 区块折叠、选择及组件树渲染。
2. 统一键位目录，增加可持久化命令预设和可配置状态栏。
3. 增加 transcript 搜索与安全的重编辑回退。
4. 保留 Markdown URL 并支持受限 OSC 8 超链接。

允许改：`packages/cli/src/tui/`、`packages/command-catalog/`（如预设命令需要 catalog 投影）、`docs/exec-plans/` 与 `docs/references/`。不改 Desktop UI，不引入第三方依赖，不迁移 TUI 渲染后端；OSC 8 只输出明确标记且经校验的 HTTP(S) 链接。

关联：承接 PR #567（`codex/tui-codex-surface`，已合并）之后的对齐工作；与
[`2026-11-01 TUI 表面计划`](../active/2026-11-01-tui-codex-surface.md) 同属「TUI 学 codex 表面」线，
但那是实现计划、本次是调研，成果落在 [`Codex TUI 对照报告`](../../references/codex-tui-alignment-survey.md)。

## 验收

- 七项均有可复跑的 TUI 单元测试，既有相关回归保持通过。
- CLI 类型检查、`npm run typecheck:all`、`npm run architecture:check` 通过；工作树中构建产物无意外变更。
- `/presets`、状态栏、折叠/选择、搜索/回退和超链接有 TUI 行为测试覆盖。
- 完成的计划与调研链接保持相对路径，报告调研日期修正为 2026-11-03。
- 将更新后的 PR #590 推到最新 master 基线；最新 head 的必需 review 与 CI 全部通过后，使用 merge commit 合并并做合并后重验。

## 进度

- [x] 调研完成并更新 PR 分支到最新 master，保留 master 上更新过的协调计划行，新增 TUI 对照行。
- [x] S3：把逐块选择、展开/折叠状态接入 `renderOptions()`；Ctrl+Up/Down 与 Ctrl+O 可重绑。
- [x] S6：将新增 transcript action 纳入共享 action 定义、帮助显示、override 与 dispatch 路径。
- [x] S1：新增 `/presets`，支持保存、列出、选择、载入和删除本地 prompt 预设。
- [x] S5：新增 `/search`；`/backtrack` 将最近一条 user prompt 复制到输入框，原会话记录保持不变。
- [x] S2：transcript pane 与 inline StatusBar 经 `renderTree` 绘制；full-screen 布局仍由现有 surface 管理。
- [x] S4：新增持久化 `/statusline`，支持 full / compact / location / usage 四种布局。
- [x] S7：Markdown 网页链接携带到 ANSI 渲染；OSC 8 仅允许无控制字符、无凭据且不超过 2048 字符的 HTTP(S) URL。
- [x] 全量 TUI、CLI 类型检查与架构检查通过；`npm run typecheck:all` 全部通过（含 22 包构建和 Web 生产包）。
- [x] 更新报告和计划；推送后刷新 PR 描述并等待远端检查。
- [x] PR #590 的最新 head 上全部必需 CI 检查通过，以 merge commit 合并；同步 master 并确认合并提交包含 PR head。

## 发现与决策

- **duya 的斜杠命令结构质量已经追平 codex**：两边都做「定义与执行分离」+「lookup 与 popup filter 分离」。codex 在 `bottom_pane/slash_commands.rs:120-137` 查找时强制打开被 feature gate 关掉的命令；duya 在 `packages/cli/src/tui/slash/registry.ts:101-104` 用独立的 `resolveTuiSlashCommand` / `advertisedSpecs` 做同一件事，且 `registry.ts:10-20` 注释**逐字点名 codex** 作为参照。这条规则两边一致，**不需要再改**。
- **不要抄渲染范式**。codex 是 ratatui + 全屏 viewport；duya 是自研 cell-grid（`screen/own/`）+ inline/fullscreen 双轨，inline 把滚动交还终端原生 scrollback（`terminal/viewport.ts:76` 编码「已提交不可撤回」不变量）。两者都成立，抄会推翻 duya 现有资产。
- **三个 P0 差距**：① `/presets`（codex 让用户保存可复用 prompt 与斜杠命令，duya catalog 硬编码 53 条无用户可扩展层）；② 组件树未接线（`core/component.ts` 的 `UIComponent`/`SceneCanvas` 存在但生产路径不走，`core/component.ts:20-26` 自陈无 diff / 无脏传播）；③ 逐块折叠是骨架（渲染器支持 `expandedBlockIds`/`selectedBlockId`，但 `TUIApp.ts:1669-1692` 从不设置）。
- **两处 duya 事实错误**（非缺口，是 bug）：`chat.ts:605-621` 注释称「默认全屏、需 `DUYA_TUI_INLINE=1` 开启」已过期，真实默认是 inline（`preferences.ts:116`）；`packages/agent/src/cli/slash-commands.ts` 遗留层仍有 3 处 TODO stub（`:610`、`:807`、`:1091`）。
- **终端原语差距的定性**：OSC 11 背景探测与 OSC 8 超链接在 duya 是**明确拒绝**实现的（`theme.ts:32-36`、`terminal/ansi.ts:258-262`），不是漏做。要不要翻案属于产品决定，不属于「抄 codex」。
- 报告中的七项都纳入本次交付；S2 限定为组件树先接 transcript + 状态栏，不迁移其它面板。
- 原 PR 分支落后最新 `master` 七个提交；已在 rebase 时保留 master 的项目协调路由项并解决 `docs/exec-plans/README.md` 冲突。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `git fetch origin` + `git rev-list --count HEAD..origin/main` | 0；0 behind / 0 ahead | 与 `origin/main` 一致 |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `git pull --ff-only` | 0；"Already up to date" | 工作区干净（`git status --porcelain` 0 行） |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `sed -n '/^pub enum SlashCommand {/,/^}/p' slash_command.rs \| grep -cE '^    [A-Z][A-Za-z0-9]*(,\|\s*\{)'` | 0；**65** | codex 命令变体数 |
| worktree @ `203d7d51` | Windows 11 / Node 22 | `grep -c "^    name: '" packages/command-catalog/src/index.ts` | 0；**53** | duya catalog spec 数 |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `find . -maxdepth 1 -name '*.rs' \| wc -l` 等 | 0；228 顶层 / 42 子目录 / 递归 1173 | 报告 §6 的规模声明 |
| worktree dirty | Windows 11 | `grep -c "DUYA self-config hint" docs/references/codex-tui-alignment-survey.md` | 0；0 | 报告体未被工具输出污染 |
| worktree @ `0ba68cf7` + implementation | Linux / Node 24.19.0 | `npx vitest run packages/cli/src/tui` | 0；108 文件 / 1341 测试通过 | 全量 TUI 回归 |
| worktree dirty | Linux / Node 24.19.0 | `npm run typecheck --workspace @duya/cli` | 0 | CLI 类型检查 |
| worktree dirty | Linux / Node 24.19.0 | `npm run architecture:check` | 0；无新增违规 | 架构门禁 |
| worktree dirty | Linux / Node 24.19.0 | `npm run typecheck:all` | 0；22 包构建、Web bundle、所有类型检查及 eval 检查通过 | Electron/evals 报告 178 项既有基线错误，无新增类型错误；Vite 仅有分块提示 |
| PR #590 head `2307a45c` | GitHub Actions / Node 22 | `test scope`, `architecture`, `typecheck`, `test`, `build` | 全部成功 | 最新 PR head 上五项检查均通过 |
| master `dbffec07` | Linux / Git | fetch `origin/master` + ancestor/status 检查 | 0；PR head 是 master 祖先，worktree clean | 合并后的 master 指向 merge commit `dbffec07d71c5dc8fbff977fe8e313fca5f77611` |

当前基线：实现前记录于 `0ba68cf70adc04b3632de4eb72a64ae81a426ca7`。验证环境为 Linux / Node 24.19.0。worktree 的 workspace 链接和临时 `picomatch` ambient declaration 仅用于验证，收尾时已移除；构建产物均未纳入改动。报告原标注的日期已更正为 2026-11-03。

## 接续 / 结果

已有调研：`docs/references/codex-tui-alignment-survey.md`（斜杠命令 + TUI 表面九轴 + 22 条差距 + 7 个候选切片）。

已验证：关键数字全部用命令独立复核；全部 `file:line` 来自实际 Read/Grep 命中行。

PR：<https://github.com/lava-chen/duya/pull/590>（分支 `docs/codex-tui-alignment-survey`，base `master`）。已于 2026-11-03 合并；merge commit 为 `dbffec07d71c5dc8fbff977fe8e313fca5f77611`。最新 head 的 architecture、test scope、typecheck、test、build 检查全部通过；GitHub 未返回 review decision 阻断，合并 API 成功。

未提交路径：无；实现与计划变更分别由 PR #590、PR #591 提交。worktree 的 `node_modules` 链接、包构建产物与测试临时目录均为 ignored，没有加入 Git。

副作用：worktree 的 ignored workspace 链接与包 `dist` 构建产物被补齐；prompt 预设测试只写入临时目录。

边界：backtrack 仅回填最新 user prompt，提交后创建新回合；Host timeline 是追加式，当前实现不会删除或截断历史。OSC 8 仅接受不含凭据、控制字符且长度不超过 2048 字符的 HTTP(S) URL。Statusline 以四种可保存的布局 profile 配置。

回收：PR #590 已合并；实现 worktree 在本计划归档 PR 集成后由 `scripts/remove-worktree.sh` 回收，并核对 ignored 临时文件与 Git 状态。

下一步：本计划归档 PR #591 合并后，使用 `scripts/remove-worktree.sh` 回收实现与归档 worktree，并确认本地任务分支已不再被 worktree 使用。
