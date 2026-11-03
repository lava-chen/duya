# Codex TUI 表面与斜杠命令体系对照

状态：active · 负责人：duya 会话（codex-tui-alignment-survey）· 更新：2026-11-04
分支：docs/codex-tui-alignment-survey · worktree：C:\Users\lavachen\.duya\worktrees\duya-158718b0aef8\codex-tui-alignment-survey-e57f59 · base：203d7d5191bc463915591af3911649a7b313394a · owner：duya 会话

## 目标与边界

用户可观察到的变化：**没有产品行为变化**。本次产出的是一份可供后续切片决策的对照报告。

1. 用 codex 当前版本对照 duya，回答「斜杠命令体系差在哪、TUI 表面差在哪、哪些该抄哪些不该抄」。
2. 产出带 `file:line` 证据的差距清单与候选切片，供用户选型。

允许改：`docs/references/`（新增报告 + 索引）、`docs/exec-plans/`（本计划与目录）。
本次不改任何 `packages/` 或 `apps/` 代码；不改 codex clone（只读对照，不引入依赖、不 vendor）。

关联：承接 PR #567（`codex/tui-codex-surface`，已合并）之后的对齐工作；与
`docs/exec-plans/active/2026-11-01-tui-codex-surface.md` 同属「TUI 学 codex 表面」线，
但那是实现计划、本次是调研，成果落在 `docs/references/codex-tui-alignment-survey.md`。

## 验收

- 报告含双方 `file:line` 锚点，结论可逐条复核；不存在的能力写「当前版本无」。
- 关键数字用命令独立复核（命令条数、文件数），不靠目测。
- codex clone 处于与 `origin/main` 一致的版本，工作区干净。
- 报告进 Git 并经 PR 交付；原始材料留在 ignored 的 `docs-local/`。

## 进度

- [x] 确认 codex clone 版本并更新到最新
- [x] 盘点 codex 斜杠命令体系（注册表、弹窗过滤、分发、动态来源、兜底）
- [x] 盘点 duya 斜杠命令体系（catalog 单一来源、执行器映射、遗留层状态）
- [x] 盘点 codex TUI 表面（九轴）
- [x] 盘点 duya TUI 表面（九轴）
- [x] 交叉比对，产出 22 条差距 + 7 个候选切片
- [x] 写入 `docs/references/codex-tui-alignment-survey.md` 并进索引
- [x] 开 PR（#590）

## 发现与决策

- **duya 的斜杠命令结构质量已经追平 codex**：两边都做「定义与执行分离」+「lookup 与 popup filter 分离」。codex 在 `bottom_pane/slash_commands.rs:120-137` 查找时强制打开被 feature gate 关掉的命令；duya 在 `packages/cli/src/tui/slash/registry.ts:101-104` 用独立的 `resolveTuiSlashCommand` / `advertisedSpecs` 做同一件事，且 `registry.ts:10-20` 注释**逐字点名 codex** 作为参照。这条规则两边一致，**不需要再改**。
- **不要抄渲染范式**。codex 是 ratatui + 全屏 viewport；duya 是自研 cell-grid（`screen/own/`）+ inline/fullscreen 双轨，inline 把滚动交还终端原生 scrollback（`terminal/viewport.ts:76` 编码「已提交不可撤回」不变量）。两者都成立，抄会推翻 duya 现有资产。
- **三个 P0 差距**：① `/presets`（codex 让用户保存可复用 prompt 与斜杠命令，duya catalog 硬编码 53 条无用户可扩展层）；② 组件树未接线（`core/component.ts` 的 `UIComponent`/`SceneCanvas` 存在但生产路径不走，`core/component.ts:20-26` 自陈无 diff / 无脏传播）；③ 逐块折叠是骨架（渲染器支持 `expandedBlockIds`/`selectedBlockId`，但 `TUIApp.ts:1669-1692` 从不设置）。
- **两处 duya 事实错误**（非缺口，是 bug）：`chat.ts:605-621` 注释称「默认全屏、需 `DUYA_TUI_INLINE=1` 开启」已过期，真实默认是 inline（`preferences.ts:116`）；`packages/agent/src/cli/slash-commands.ts` 遗留层仍有 3 处 TODO stub（`:610`、`:807`、`:1091`）。
- **终端原语差距的定性**：OSC 11 背景探测与 OSC 8 超链接在 duya 是**明确拒绝**实现的（`theme.ts:32-36`、`terminal/ansi.ts:258-262`），不是漏做。要不要翻案属于产品决定，不属于「抄 codex」。
- **本次未核完**：Desktop 侧命令执行器逐条映射、codex `/presets` 的存储格式。已在报告 §6 列明，不影响主结论。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `git fetch origin` + `git rev-list --count HEAD..origin/main` | 0；0 behind / 0 ahead | 与 `origin/main` 一致 |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `git pull --ff-only` | 0；"Already up to date" | 工作区干净（`git status --porcelain` 0 行） |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `sed -n '/^pub enum SlashCommand {/,/^}/p' slash_command.rs \| grep -cE '^    [A-Z][A-Za-z0-9]*(,\|\s*\{)'` | 0；**65** | codex 命令变体数 |
| worktree @ `203d7d51` | Windows 11 / Node 22 | `grep -c "^    name: '" packages/command-catalog/src/index.ts` | 0；**53** | duya catalog spec 数 |
| codex clone @ `fbf5f0d3a7` | Windows 11 | `find . -maxdepth 1 -name '*.rs' \| wc -l` 等 | 0；228 顶层 / 42 子目录 / 递归 1173 | 报告 §6 的规模声明 |
| worktree dirty | Windows 11 | `grep -c "DUYA self-config hint" docs/references/codex-tui-alignment-survey.md` | 0；0 | 报告体未被工具输出污染 |

代码门禁：纯文档变更，未跑 `typecheck:all` / `architecture:check` / `vitest`（PR #590 的 CI
因路径过滤只跑 `test scope` 与 `architecture`）。

## 接续 / 结果

已产出：`docs/references/codex-tui-alignment-survey.md`（277 行，斜杠命令 + TUI 表面九轴 +
22 条差距 + 7 个候选切片），并更新 `docs/references/README.md` 索引。

已验证：关键数字全部用命令独立复核；全部 `file:line` 来自实际 Read/Grep 命中行。

PR：<https://github.com/lava-chen/duya/pull/590>（分支 `docs/codex-tui-alignment-survey`，
base `master`，**Draft，未合并**）。提交 `ec214e26`（报告 + 索引）、`f2ed4772`（本计划）。
未经用户授权不合并。

未提交路径：无（worktree 干净，`git status --short` 空）。

副作用：`E:\cloned-projects\codex` 被 `git fetch` 更新过远端引用（工作区与 HEAD 未变，
`git pull --ff-only` 报 Already up to date）。`E:\Projects\duya\docs-local/research/codex-tui-alignment/`
新增原始材料（ignored，不进 Git）。

阻塞：下一步取决于用户选型。候选切片（报告 §5）：S1 命令预设 / S2 组件树接线 /
S3 逐块折叠接线 / S4 状态行可配置 / S5 搜索与回退 / S6 键位目录化 / S7 OSC 8 超链接。
建议顺序 S3 → S6 → S1 → S5 → S2 → S4/S7。

回收：owner 是本会话，**未回收**——PR #590 未合并，按隔离规则保留分支与 worktree；
集成后走 `scripts/remove-worktree.sh`。

下一步：用户选定切片后，为该切片新建计划（模板见 `docs/exec-plans/template.md`），
在其独立 worktree 实施、过门禁、开 PR。
