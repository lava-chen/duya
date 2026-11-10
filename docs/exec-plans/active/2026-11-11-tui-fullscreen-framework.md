# CLI TUI — 全屏框架先进化

状态：实施中。owner：本会话。工作树：`.claude/worktrees/tui-fullscreen-framework`。
分支：`codex/tui-fullscreen-framework`。base：`codex/cli-pi-workbench` head `10b049af6`
（PR #624，stacked 交付；#624 合并后 GitHub 自动改投 master）。
独占路径：`packages/cli/src/tui/**`（含 `__tests__`）与本文档；不改 `chat.ts`、Host、协议。

## 方向与依据

用户裁定：pi / Claude Code 的全屏设计是对的，TUI 框架按他们的路线推进到先进水平。
本计划只做 #624（Pi 工作台：pointer 命中区、侧栏、显示画像）没有覆盖的**阅读流
richness**，全部是 [pi-tui-workbench](../../references/pi-tui-workbench.md) 对照里
Pi 已有、Duya 缺失的全屏能力：

- Pi 全屏有 `Ctrl+Shift+F` 转录搜索（`enter`/`ctrl+g` 下一个、`shift+enter`/`ctrl+shift+g`
  上一个、高亮 `searchMatchBg`），Claude Code 的 transcript viewer 有 less 式 `/` 搜索
  与 `n`/`N`。Duya 只有 `/search` 结果面板（无高亮、无视口导航）。
- Pi 有比例滚动条与拖选；Claude Code 2.1.27x 有滚动条与点击展开。
- Pi 用 OSC 133 标记 user prompt，`Ctrl+Shift+Up/Down` 在回合间跳转。

切片顺序（每个切片独立可验收，本 PR 先交付 S1）：

- [x] S1 全屏转录搜索（本 PR）：`Ctrl+F` 打开、输入框内首行搜索条、可见行高亮、
      `Enter`/`↓` 下一个、`↑` 上一个、自动滚动到当前匹配、`Esc` 关闭。
- [x] S2 比例滚动条（本 PR）：fullscreen transcript 右缘独立一列，thumb 比例尺寸
      与位置、pointer 点击寻址 + 拖拽（grab offset），`DUYA_TUI_SCROLLBAR=off|
      always|auto`（默认 auto：仅离开尾部时显示）。
- [x] S3 回合跳转（本 PR）：`Alt+Up`/`Alt+Down` 在 user block 锚点间跳转；视口
      位置即游标（无存储态）。OSC 133 输出另列（属 S5 渲染统一的终端集成面）。
- [ ] S4 默认显示模式翻转评估：等 S1–S3 实机验收后，与用户确认是否把 fullscreen
      设为默认（pi 1.0 的做法）；inline 保留为显式选择。
- [ ] S5 渲染管线统一（pi 式 `TuiMainScreen`/`TuiAltScreen` 双面同组件树）：大改，
      独立计划另立。

## S1 设计决定

- 匹配以**渲染后的可见行**为准（当前 display profile 折叠什么就搜什么），与 pi 一致；
  既有 `/search`（block 级结果面板）行为不变，两种入口并存。
- 高亮是 **paint 期 overlay**：`transcript-search.ts` 纯函数把 tagged 行经
  `tagsToSpans` 拆 span、按匹配区间拆段、给命中段加 `searchMatchBg`/当前命中
  `searchMatchCurrentBg` 后 `spansToTags` 重组。`query` 不进 `renderOptionsKey`，
  不打爆块级渲染缓存（pane 内按 docKey+query 记忆化索引）。
- 搜索条占输入框 body 首行（全屏）：不新增布局区域，transcript bottom 沿用既有
  height 推导；光标行 +1。无匹配显示 `0/N` 而不是隐藏行（诚实读数）。
- inline 不获得搜索：提交行不可反悔（`terminal/surface.ts` 头注），无法回写高亮；
  `Ctrl+F` 在 inline 打印一次性提示指向 `/settings` 与 `/search`。
- 按键合同：搜索激活时 typeable/backspace/Ctrl+U 归搜索条，`Enter`/`↓` 下一个、
  `↑` 上一个、`Esc` 关闭（保持视口位置，`Ctrl+End` 回底）、`Ctrl+C` 照常打断；
  弹层/权限模态优先于搜索。

## 验收

- 新增 `tui/__tests__/transcript-search.test.ts`：纯函数（plain 化、匹配、高亮重组、
  往返不变量）+ pane 集成（高亮只落在可见行、索引按 docKey+query 记忆化）。
- `tui-keymap.test.ts` 同步新 action（可重绑、无保留键冲突）。
- 先记录相关测试基线（`npx vitest run packages/cli/src/tui/__tests__/`），改动后按
  文件/用例/错误签名比较。
- 门禁：`npm run -w @duya/cli typecheck`、`npm run architecture:check`、
  `npm run typecheck:all` 静态环节（不跑聚合尾部 `node --test` 时明确记录）。
- 终端实机（Windows/ConPTY、流式期间的搜索、宽字符命中）未验收；PR 保持 draft。

## 证据

环境：Linux x64 / Node v26.13.0。依赖：主检出无 `node_modules`（`junction-worktree` 的根链接目标不存在），按隔离规则在本检出 `npm ci`（lock 原样，exit 0），未穿过共享链接安装。

| SHA / dirty | 命令 | 结果 |
| --- | --- | --- |
| `10b049af6`（base，S1 改动 stash 后） | `npx vitest run packages/cli/src/tui/__tests__/` | exit 0；**基线失败 2**：`tui-settings-panel.test.ts` › applies a profile as four keys and moves the live renderer / cycles one switch from the same list；1145 passed |
| S1 全部改动 | 同上 | 同 2 个基线失败（同文件、同用例、同签名），**0 新增失败**；1163 passed / 1167 total（新增 19 用例全过，含 `transcript-search.test.ts` 19 项与 keymap 清单同步） |
| S1 全部改动 | `npm run -w @duya/cli typecheck` | exit 0，0 error |
| S1 全部改动 | `npm run architecture:check` | exit 0，无新增违规、未写 baseline |
| S1 全部改动 | `npm run typecheck:all` | exit 0（含 `build:packages` 22 包与尾部 `eval:agent:core:check` 4/4——即聚合命令的尾部 `node --test`，本次实际执行并通过） |
| S1 全部改动 | `node scripts/build-cli-bundle.mjs` | exit 0，`packages/cli/bundle/cli.cjs` 4.75 MB |
| S2 全部改动 | `npx vitest run packages/cli/src/tui/__tests__/` | 同 2 个基线失败（同签名），**0 新增失败**；1176 passed / 1179 total（新增 `scrollbar.test.ts` 12 项全过） |
| S2 全部改动 | `npm run -w @duya/cli typecheck` | exit 0，0 error |
| S2 全部改动 | `npm run architecture:check` | exit 0，无新增违规、未写 baseline |
| S2 全部改动 | `node scripts/build-cli-bundle.mjs` | exit 0，`packages/cli/bundle/cli.cjs` 4.76 MB |
| S2 全部改动 | `npm run typecheck:all` | exit 0（含 `build:packages` 与尾部 `eval:agent:core:check` 4/4） |
| S3 全部改动 | `npx vitest run packages/cli/src/tui/__tests__/` | 同 2 个基线失败（同签名），**0 新增失败**；1185 passed / 1188 total（新增 `turn-navigation.test.ts` 9 项全过） |
| S3 全部改动 | `npm run -w @duya/cli typecheck` | exit 0，0 error |
| S3 全部改动 | `npm run architecture:check` | exit 0，无新增违规、未写 baseline |
| S3 全部改动 | `node scripts/build-cli-bundle.mjs` | exit 0，`packages/cli/bundle/cli.cjs` 4.76 MB |
| S3 全部改动 | `npm run typecheck:all` | exit 0（结果随提交记录核对） |

已实现 / 已验证 / 未验证：S1 代码与单测已实现并验证（上述门禁）；终端实机（高亮观感、流式期间搜索、CJK 宽字符命中、Windows/ConPTY、`Ctrl+F` 实键派发）未验证，PR 保持 draft 待真机验收。搜索条颜色（58/100/229/186）为静态选择，真机如刺眼按主题 token 调整即可。

## 远程交付

- S1 代码提交：`8abd2f8ac`（`feat(cli): add fullscreen transcript search with paint-time highlights`），+807/−10，10 文件。
- S2 代码提交：`bdfdfe0c7`（`feat(cli): add a proportional scrollbar to the fullscreen transcript`），+428/−8。
- S3 代码提交：见 git log（`feat(cli): jump between prompts with alt+up and alt+down`）。
- 分支 `codex/tui-fullscreen-framework` 已推送（exit 0）；stacked draft PR：[lava-chen/duya#625](https://github.com/lava-chen/duya/pull/625)，base `codex/cli-pi-workbench`（#624 合并后随 GitHub 改投 master），未合并。
- worktree 保留在 `.claude/worktrees/tui-fullscreen-framework`，等待实机验收与 review/CI；下一动作是 S3 回合跳转。

## S2 设计决定

- **独立一列，不遮挡**：pi/CC 的滚动条都是覆盖在内容最后一列上的瞬态条，需要
  show-then-fade 定时器才诚实。duya 已有 HStack 槽位机制（侧栏），滚动条作为
  `HStack[pane flex, scrollbar 1]` 的第二槽：条升起时内容精确窄一列，什么都不被
  盖住。`auto` 模式只在 `follow=false` 时付这一列的成本（正是需要方位感的时候）。
- **pointer 合同**：复用 #624 的 `HitRegion.drag`——按下即寻址（`drag('start')`
  立即回调，绕过 280ms 多击延迟），保留 grab offset（按住 thumb 中部不会瞬移到
  光标下），`move` 续拖，`end/cancel` 收尾。region 从提交帧的 `scrollbarLayout`
  构建，点击永远落在画出来的条上。
- **数学**：thumb 尺寸 = 可见份额（`round(rows/total × trackRows)`，至少 1 行），
  位置 = `scrollTop/maxScroll × (trackRows − size)`，`maxScroll` 时 thumb 底边贴
  track 末行；逆映射用于拖拽，量化桶性质由测试 pin（按下即松开 thumb 不动）。
- **字形**：`█`/`░` 沿用 capacity-bar 验证过的宽度表 + Windows Terminal 一致性
  先例；组件在绘制前运行时复核宽度表，不为 1 就画空（画歪不如不画）。
- **模式开关**：`DUYA_TUI_SCROLLBAR=off|always|auto`（缺省 auto）；`/settings`
  行留到 S4 与全屏设置面一起做，避免触碰 settings-panel 既有失败用例的数据面。
- `follow` 期间 `scrollTop` 是陈旧值——thumb 用 `effectiveScrollTop()`（follow 时
  取 `total − rows`），拖拽把 `follow` 置 false，尾部恢复仍走 `Ctrl+End`。

## S3 设计决定

- **弦**：`Alt+Up`/`Alt+Down`。pi 的 `Ctrl+Shift+方向键` 在本键位系统不可表达
  （`normalizeChord` 明确拒绝 shifted control 弦——多数终端无法区分送达），own
  解析器对 `\x1b[1;3A` 产出 `{name:'up', meta:true}`（既有测试 pin），故以
  `M-up`/`M-down` 送达；`toBlessedKey` 的 alt 分支为此扩展导航名。
- **锚点**：user block 在渲染文档中的首个非空行（提示带本身，而非其块的
  leading gap 行）；profile 过滤计入——隐藏块不渲染即不占行，锚点随之移动。
  与搜索索引一样按 documentKey 记忆化。
- **无游标状态**：previous = 严格高于视口顶的最后一个锚点；next = 视口顶下方
  context rows（=2，`ANCHOR_CONTEXT_ROWS`，与搜索跳转共用）之后的第一个锚点。
  落定的锚点不会成为自己的下一个目标（数学性质，测试 pin）；手动滚动与跳转
  永远一致。跳转置 `follow=false` 并取消 pointer 手势。
- **inline 不跳**：终端拥有 scrollback、应用无法重绘已提交行（与 inline 无
  app 滚动的同一条理由），动作静默 no-op——与 PgUp/PgDn 的 inline 语义一致。
