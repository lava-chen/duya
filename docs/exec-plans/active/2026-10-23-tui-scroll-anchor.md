# TUI 滚动语义:绝对偏移 + 独立 follow

状态：active · 负责人：mavis · 更新：2026-10-23
分支：codex/tui-scroll-anchor · worktree：.claude/worktrees/tui-scroll-anchor · base：c81ed169 · owner：mavis

## 目标与边界

用户能观察到的变化：用户向上滚动阅读时,模型继续输出的新内容**不再把视窗往下推**。
新内容出现在正在读的内容下方,正在读的那几行留在屏幕上。

允许修改：`packages/cli/src/tui/core/visible-window.ts`、`components/transcript-pane.ts`、
`TUIApp.ts` 的滚动状态与滚动操作,以及对应测试。
本次不做：pi 的 `followSuppressedAtEnd`(在底部但不跟随)—— duya 没有全文搜索跳转,暂无此状态需要。
关联参考：`E:\cloned-projects\pi` → `packages/tui/src/components/scroll-view.ts`、
`packages/tui/src/layout.ts:130-147`、`packages/tui/test/tui-alt-screen.test.ts:111-126`。

## 验收

- `npx vitest run packages/cli/src/tui/` 全绿
- `npm run typecheck:all` 与 `npm run architecture:check` 退出码 0
- 行为级用例:上滚后追加输出,视窗偏移不变且 follow 仍为 false
- 变异证据:把视窗重新锚回尾部,新用例必须转红

## 进度

- [x] 读 pi 的滚动实现与测试,确认差异点
- [x] `visibleWindow` 改为吃绝对 `scrollTop` + 独立 `following`
- [x] `TranscriptPane` props 同步
- [x] `TUIApp` 滚动状态、滚动操作、块选择定位、inline `viewEnd` 全部改写
- [x] 单元测试改写 + 新增「文档增长时视窗不动」用例
- [x] TUIApp 层行为测试 + 变异验证
- [x] 门禁 + commit + PR

## 发现与决策

- **根因**:`scrollLines` 是「距尾多少行」,`lineStart = maxStart - offset`。`maxStart` 随文档增长,
  而 `offset` 不变,所以视窗跟着尾部一起下移,正在读的内容从顶部滑出。距尾偏移在数学上
  就无法表达「保持我正在看的这段」。
- **pi 的模型**(`scroll-view.ts:29-33`):绝对 `currentScrollTop` + 独立布尔 `followingEnd`
  + `followSuppressedAtEnd`。规则在 `updateLayout`(`:181-193`):跟随则顶到底,不跟随则**只 clamp
  不移动**。duya 照抄这一条。
- pi 有测试锁住该行为(`tui-alt-screen.test.ts:111-126`):内容从 8 行涨到 10 行,视窗仍停在
  line 4–7。duya 新增对应用例。
- **「到底即跟随」的判定**:pi 是 `next === maxScrollTop`。duya 改为 `start >= maxStart`,
  语义相同。注意这不是「推导 follow」——`follow` 仍是独立布尔,只是滚动操作后按位置更新它。
  推导 follow 的老写法(`follow = scrollLines === 0`)在绝对偏移下不再成立,因为「到底」现在
  是 `scrollTop === maxStart` 而非某个固定值。
- **inline 模式的 `viewEnd`**:旧式 `length - scrollLines` 恰好等于距顶行数,新模型直接用
  `scrollTop`,语义更清楚。
- pi 的 TUI 层是纯按行切片,duya 是「块 + 每块高度 + 前缀和」。这是渲染结构的差异,本次不动;
  滚动**语义**可以独立于渲染单位改。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| c81ed169 clean | Windows / Node | `npm run build:packages` | 0（20 packages） | worktree 内 dist 就绪 |
| 工作区（滚动改造） | Windows / Node | `npx vitest run packages/cli/src/tui/` | 0（70 files / 900 passed） | 改造后全绿 |
| 工作区（滚动改造） | Windows / Node | `npx vitest run .../virtual-doc.test.ts` | 1（1 failed） | 首版断言沿用「距尾」语义,已改为「距顶」并补「越过底部」用例 |
| 工作区（+变异） | Windows / Node | 在 `paintTranscript` 里把视窗重新锚回尾部 | 1（新用例转红） | 证明用例有牙齿,非恒绿 |
| `aec08d75` | Windows / Node | `npx vitest run packages/cli/` | 0（85 files / 1035 passed） | CLI 全包绿 |
| `aec08d75` | Windows / Node | `npm run typecheck:all` | 0 | 类型门禁 |
| `aec08d75` | Windows / Node | `npm run architecture:check` | 0 | 架构门禁 |
| `aec08d75` | Windows / Node | CI（PR #388） | 全绿：architecture / test scope / typecheck / test / build | GitHub Actions |

## 接续 / 结果

已提交 `aec08d75`（实现 + 本计划文档）。PR #388(draft)：https://github.com/lava-chen/duya/pull/388
门禁：`typecheck:all` 0、`architecture:check` 0、CLI 全包 85 files / 1035 passed、CI 全绿。
变异证据见上（把视窗重新锚回尾部 → 新用例转红）。

未提交路径：无。worktree `.claude/worktrees/tui-scroll-anchor` 独占 `packages/cli/src/tui/**` 的滚动相关路径
(与 `tui-todo-list` 分支的改动不重叠:后者改 `todo.ts`/`blocks.ts`/thinking 预览,前者改
`visible-window.ts`/`transcript-pane.ts`/滚动状态)。
下一步:等 review 与 CI；获集成授权后合并并重验,再回收检出。
