# TUI 权限 banner 与 Shift+Tab 快速切换

状态：implemented · 负责人：claude-desktop-code · 更新：2026-10-29
分支：codex/tui-permission-banner · worktree：E:\Projects\duya\.claude\worktrees\tui-permission-banner · base：49800ec5 · owner：claude-desktop-code
集成：Draft PR #538（`codex/tui-permission-banner` → `master`）。真机冒烟未跑，故保持 draft；未获集成授权，不合并。

## 目标与边界

用户可观察到的变化（限 CLI TUI，`packages/cli/src/tui/`）：

1. footer 第二行右下角常驻**权限徽标**：`[ask]` / `[auto]` / `[bypass]`，按模式染色（muted / warning / error），后面跟一个提示 `· Shift+Tab`。
2. `Shift+Tab` 循环权限模式：`ask → auto → bypass → ask`。
3. **`bypass` 需要按第二次才生效**：第一次按只"暂存"，徽标变成 `[bypass] · press Shift+Tab again`；第二次按才真正写入。理由：`bypass` 等于把 shell / 文件 / 网络全权交给 agent，一次误按不该造成这个结果。

不处理：Desktop（`packages/ui/`）的 composer 布局；`auto` 模式的语义（沿用现有 `permission_profile`）；session 级 `LocalToolPermission`（Host 常驻开关，另一条轴）；按键重绑定（`Shift+Tab` 固定，与 630a 面板的"后退"共用同一个物理键）。

对照来源：`E:\cloned-projects\claude-code-haha` 的 `src/utils/permissions/getNextPermissionMode.ts`（循环顺序）、`src/components/PromptInput/PromptInputFooterLeftSide.tsx:348`（输入框左下的模式徽标 + `shift+tab to cycle` 提示）、`src/keybindings/defaultBindings.ts:30`（Windows 无 VT 时改用 `meta+m` 的降级思路——duya 本次不做降级，见"发现与决策"）。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/permission-mode.test.ts packages/cli/src/tui/__tests__/tui-permission-cycle.test.ts packages/cli/src/tui/__tests__/footer.test.ts` 通过。
- `npx vitest run packages/cli` 通过（无回归）。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。
- 真机：`npm run build:cli-dev` 后 `npm run dev:tui`，footer 右下角出现 `[ask] · Shift+Tab`；按 Shift+Tab 依次变 `[auto]`、暂存 `[bypass]`、再按一次生效。TUI 只能人工敲（ink 不接受管道输入），此项由用户执行。

## 进度

- [x] 读两侧实现（duya TUIApp / footer / keymap / slash permission；claude-code-haha 的 mode indicator 与循环）
- [x] 抽出权限模式词汇模块（`tui/permission-mode.ts`）
- [x] footer 第二行右下角徽标 + 窄屏降级阶梯
- [x] `Shift+Tab` 循环 + bypass 二次确认
- [x] `Shift+Tab` 进入 action 表与 keymap（显示 + 保留键）
- [x] `/permission` 改用共享映射（去掉第二份 profile↔词 的对照表）
- [x] `chat.ts` 接线（读会话模式、写会话模式）
- [x] 补单测
- [x] 门禁（typecheck:all / architecture:check / vitest）
- [x] commit（PR 待用户验收后开）

## 发现与决策

- **模式本来就是会话属性**：`SessionPermissionProfile`（`default` / `auto` / `full_access`）存在 Host 的会话行上，`/permission` 已经在写它。所以这次不新增任何协议面：徽标读会话、循环写会话，和 Desktop 的 composer 是同一个模式，不会出现两个界面各说各话。
- **`S-tab` 之前已经被占用**：630a 的富面板用它做"后退"。同一个物理键现在按上下文分派：面板开着 → 面板后退；没有面板 → 循环权限。窗口（`/model`、F1 help 等）开着时仍然归窗口。
- **按 blessed 的全名绑定**：两条输入路径都把 Shift+Tab 报成 `S-tab`（blessed `keys.js:302`；自有解析器 `own-key-parser.ts:258` 发 `tab` + `shift`，`fullKeyName` 再拼成 `S-tab`），所以绑一个名字即可。文本通道按"名字长度 > 1"吞掉这个键，编辑器不会插入制表符。
- **`Shift+Tab` 不进可重绑定表**：它同时是面板的后退键，放进 `REBINDABLE_ACTIONS` 会让"用户改了这个键 → 面板后退键和权限循环键分家"。和参考实现一致：固定键。同时把 `Shift+Tab` 加进 `RESERVED_KEYS`，防止别的动作抢走它。
- **bypass 要二次确认**：参考实现里 `bypassPermissions` 只有在"用户显式开启过"时才进循环，duya 没有这个开关，所以直接循环到 bypass 就是一个误按即交出全权限。改成两段式，并把"再按一次"的提示画在徽标本身里——用户不需要猜第二次按什么。
- **徽标用词而不是符号**：参考实现用 `⏵⏵`，但那个符号在 Claude Code 里专指"自动接受编辑"，用它表示 `ask` 会误导。改成 `[ask]` / `[auto]` / `[bypass]`，颜色承担"分量"（muted / warning / error）。
- **徽标放在 footer 第二行右下角**（用户选定）：inline 模式的 footer 是两行，第二行右端是模型名；徽标插在模型名前面。full-screen 模式没有两行 footer，状态行是唯一的最底行，徽标挂在它的右端——两处都是"屏幕最底行的最右端"。
- **窄屏降级有固定顺序**：右端组是 `[徽标][提示][模型]`。放不下时依次让位：先截模型的尾巴（截了还认得出模型）→ 再丢提示（它只是重复徽标已经暗示的键）→ 再整个丢模型（连 `MIN_RIGHT` 都保不住时它什么也不是）→ 最后才丢徽标。模型名被截到认不出之前，徽标一定在。
- **footer 的行右侧从"一个字符串"变成"一组片段"**：`composeRow` 的右端参数改成 `RowSegment[]`，每段带自己的分隔符和可选标记，才能表达"徽标紧贴、提示跟一个空格、模型隔两个空格"以及上面那条降级顺序。测量仍然只按无 tag 的纯文本走。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| codex/tui-permission-banner（未提交） | Windows 11 / Node 24.16 | `node scripts/junction-worktree.mjs .` | 0 | 建 60 条 workspace 链接 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui/__tests__/{permission-mode,footer,tui-permission-cycle}.test.ts` | 0 | 3 文件 / 42 用例全过 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui` | 0 | 103 文件 / 1278 用例全过 |
| 同上 | 同上 | `npx vitest run packages/cli` | 0 | 132 文件 / 1553 用例全过（`tui-pty.test.ts` 的 node-pty 子进程在无 TTY 环境 AttachConsole 失败，既有问题，与本任务无关） |
| 同上 | 同上 | `npm run architecture:check` | 0 | no new boundary violations |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 各包 tsc、electron gate、eval 4 用例全过；electron gate 报"10 个 baseline key 收缩"，属既有状态，与本任务无关 |
| 同上 | 同上 | `npm run build:cli-bundle` | 0 | 产出 `packages/cli/bundle/cli.cjs`（3.97 MB，gitignored）；**副作用**：`scripts/inline-modules.mjs` 把 `packages/capabilities/src/ModuleTool/inline-content.ts` 重写成 LF（内容语义不变，`git diff` 为空），已按"只撤销本次命令产生且不属于本任务成果"的规则还原 |
| 同上 | 同上 | 直接渲染 footer（宽度 100 / 80 / 60 / 45） | 0 | 100：`[bypass] · Shift+Tab  (deepseek) deepseek-flash • high`；80：模型截到 `deepseek`；60：丢提示、模型截到 `(deepseek) `；45：右端整组让位（与改动前一致） |
