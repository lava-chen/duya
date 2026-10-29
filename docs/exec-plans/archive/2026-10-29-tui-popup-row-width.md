# TUI 补全弹窗的行宽：描述截断而不是让终端折行

状态：complete · 负责人：claude-desktop-code · 更新：2026-10-29
分支：fix/tui-popup-row-width · worktree：E:\Projects\duya\.claude\worktrees\tui-permission-banner · base：d609bec3 · owner：claude-desktop-code
集成：PR #542 由 `lava-chen` 以 merge commit `c8b47c3f` 合入 master（2026-10-29T06:23:22Z）。真 PTY 用例在 CI 上不跑（需要真 TTY），合并后由本地 `npx vitest run packages/cli` 复验。

## 目标与边界

`packages/cli/test/tui-pty.test.ts` 的 2 个用例在 master 上是红的：

```
expected ' ❯ /r │ /clear Clear the conversation…' to contain '/export'
```

用户可观察到的变化（限 CLI TUI 的补全弹窗）：

1. 候选的描述**在弹窗行的宽度内截断**（带 `…`），不再被终端折成两行。
2. 折行不再发生 ⇒ 弹窗不再比预留的高度高 ⇒ 弹窗的下边框与溢出标记 `…` 回到屏幕上，最后一个候选（`/export`）重新可见。

不处理：候选的排序与匹配规则；描述文案本身（`/project` 的描述是 #531 写的，本任务不改它）；full-screen 模式之外的呈现方式。

## 验收

- `npx vitest run packages/cli` 全绿，含 `packages/cli/test/tui-pty.test.ts` 的 2 个真 PTY 用例。
- 新增用例证明**没有修复时它会红**（变异验证）。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。

## 进度

- [x] 定位失败（真 PTY 抓帧，不是推理）
- [x] 二分出元凶 PR（#531，不是 #536）
- [x] 修复：弹窗行按宽度截断描述
- [x] 补单测 + 变异验证
- [x] 门禁（typecheck:all / architecture:check / vitest）
- [x] PR + 合并（PR #542，merge commit `c8b47c3f`）

## 发现与决策

- **失败是 #531 带进来的，不是权限 banner 改动带进来的**：在合并前的 master（`49800ec5`，不带本任务改动）上同一时刻跑同一个文件**通过**；在 #531 合入后的 `8c87920a` 上失败；二分到 `8c87920a` 即锁定 #531（`tui-project-catalog`），#536 无辜。
- **#531 只改了一句文案**：`/project` 的描述从 "Start a session in another project directory"（43 字符）变成 "Switch to a registered project, or register a directory as one"（61 字符）。候选列表、排序、匹配规则都没变（前后模拟的 `/rev`、`/re`、`/r` 三档命中列表完全一致）。
- **真正的不变量被破了**：inline surface 把 chrome 里的**每个数组元素当作一个终端行**（`surface.ts` 的 `chrome.map(lineToAnsi)`，高度就是 `chrome.length`），而终端会把超出宽度的行**自己折行**。于是：
  - 高度按"条目数"预留（`popupRows()` = min(completionRows, total) + 溢出标记 + 2），
  - 渲染按"终端行"发生（一条描述折行就多吃一行），
  - 差额让弹窗比预留的高 ⇒ 下边框被挤出屏幕、压到 footer 上、最后一个候选不可见。
  - full-screen 模式同理：盒子的 `height` 按条目数给，内容折行后溢出盒子。
- **修法是截断，不是把高度改成按行算**：inline surface 的契约就是"一个元素 = 一行"，所以**每一行 chrome 都必须 ≤ 终端宽度**。footer、状态栏、composer 早就按这个裁剪（`footer.ts` 的 `clipPlain`、状态栏的 `compactActivity(fixed, width)`），弹窗是唯一没裁的那个。改成截断描述（`truncateToWidth`，带 `…`）后，高度按条目数预留就重新是对的——因为每条候选恰好一行。
- **不改成"按行算高度"**：那要让 inline surface 知道每条 chrome 行折成几行，等于把折行知识搬进渲染层；而且弹窗会随描述变长而变高，把会话区挤掉——描述是次要信息，不该决定版面高度。
- **`innerWidth` 是"边框占掉的宽度"**：这个渲染器的 `RegionMetrics.innerWidth` 沿用 blessed 的 `iwidth` 语义（边框吃掉的列数），内容宽度是 `width - innerWidth`。第一次写成直接用 `innerWidth` 时，弹窗宽度算成 2 列，描述全被裁没了——是这个语义坑，不是别的。
- **顺手修了一个潜伏 bug**：`entry.description` 是可选的，旧代码只判了 `=== ''`，`undefined` 会被渲染成字面量 "undefined"。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `8c87920a`（#531 合入后） | Windows 11 / Node 24.16 | `npx vitest run packages/cli/test/tui-pty.test.ts` | 2 失败 | `expected ' ❯ /r │ /clear Clear the conversation…' to contain '/export'` |
| `49800ec5`（#531 之前，A/B 基线） | 同上 | 同上 | 2 通过 | 同一时刻、同一环境，不带本任务改动时通过 ⇒ 断点在 #531 |
| `4f198043`（master，A/B 基线） | 同上 | 同上 | 2 失败 | 错误签名相同 ⇒ 与本任务无关，是既有问题 |
| fix/tui-popup-row-width（未提交） | 同上 | 真 PTY 抓帧 | 0 | 弹窗行内容：`❯ /read-file Read a file from this session's workspace through the Ho│ │st` ⇒ 描述被终端折行，弹窗底边框与最后一个候选被挤出屏幕 |
| 同上 | 同上 | `npx vitest run packages/cli` | 0 | 133 文件 / 1571 用例全过（含真 PTY 的 2 个用例） |
| 同上 | 同上 | 新用例的变异验证 | 预期红 | 把截断改回旧写法后，新增用例失败于 `expected '…[ESC 序列]…' to contain '…'`（描述没被截断）；改回后 15/15 通过 |
| 同上 | 同上 | `npm run architecture:check` | 0 | no new boundary violations |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 各包 tsc、electron gate、eval 全过 |
