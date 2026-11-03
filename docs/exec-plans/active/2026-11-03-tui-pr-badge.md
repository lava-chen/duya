# TUI 常驻 PR 徽标与 OSC 8 可点击链接

状态：active（已实现并通过本地门禁，待 PR 集成） · 负责人：claude-code 会话（Code tab）· 更新：2026-11-03
分支：worktree-tui-pr-badge · worktree：E:\Projects\duya\.claude\worktrees\tui-pr-badge · base：origin/master · owner：claude-code 会话

## 目标与边界

用户能观察到的变化：

- TUI inline footer 第一行常驻显示当前会话关联的 pull request（`PR #123`），颜色随状态变化：
  绿=已合并/检查通过/已批准，红=CI 失败，黄=待评审/需修改，灰=draft/未知，中性=进行中。
- 徽标在终端支持 OSC 8 时可点击，直接打开该 PR；不支持时退化为纯文本。
- `/pr` 面板从纯文本列表升级为可交互列表（Enter 看详情），详情含 base 分支、head 提交、观测时间与状态说明。

本次只做 CLI TUI。Desktop 侧已有 `WorkspaceLifecyclePanel` 的 PR 区块（`packages/ui/src/components/workspace/WorkspaceLifecyclePanel.tsx`），本次不动。

不处理：PR 创建/合并动作（duya 只有观测，没有写 GitHub 的动作）；GitHub token 管理；非 GitHub 托管（GitLab 等）——Host 观测器只认 GitHub。

关联：plan 621 slice B/C/E/F（Host 侧 integration 契约、gh 观测器、sync、TUI `/pr` 命令）已落地，本计划补上「常驻 UI」这一层。

## 验收

- `npm run typecheck:all` 退出码 0。
- `npm run architecture:check` 退出码 0。
- `packages/cli` 相关 vitest 全绿；新增用例覆盖徽标选择规则、状态配色映射、footer 组装与链接标签。
- 真机：inline TUI 中 footer 第一行出现 `PR #123`，颜色随 `/pr` 面板里显示的状态变化。

## 进度

- [x] 徽标选择与配色规则（纯函数，可测）—— `packages/cli/src/tui/pr-badge.ts`
- [x] footer 第一行承载徽标（含 OSC 8 链接标签）—— `packages/cli/src/tui/footer.ts`
- [x] TUIApp 选项与 chat 循环的徽标刷新（读投影，空时补一次 sync）
- [x] `/pr` 面板升级为列表 + 详情
- [x] 测试与门禁（vitest / typecheck:all / architecture:check）

## 发现与决策

- **Host 侧已比 codex 强**：`packages/host/src/scm/observe.ts` 的 `deriveIntegrationState` 推导 11 种状态（含 CI 与 review decision），codex 的 `gh pr view` 只取 number/url/state。所以本次的富余量在 UI 层，不需要新写 GitHub 客户端。
- **OSC 8 基础设施已就绪**：`core/span.ts` 有 `safeHyperlink`/`encodeHyperlinkTag`，`core/tags.ts` 解析 `link-*` 标签，`terminal/ansi.ts` 的 `spansToAnsi` 已发射 OSC 8，`core/component.ts` 的 cell 保留 `linkId`，`markdown/inline.ts` 的 `spansToTags` 在 `renderer === 'own'` 时也输出 link 标签。缺的只是「footer 用它」这一步。`terminal/ansi.ts` 里「OSC 8 is deliberately absent」的注释与代码已经不符，属过时注释。
- **blessed 渲染器已退役**（`screen/factory.ts` 只剩 `own`），所以 blessed 的 `spansToTags` 不支持 link 不构成阻塞。
- **读不触网是既有契约**（`host/src/integration-api.ts`）：读投影永不调用 GitHub，只有 `sync` 会。故刷新策略取「读投影，投影为空时补一次 sync」。
- **sync 会自动关联会话**：`host/src/scm/sync.ts` 的 `syncSession` 匹配 checkpoint refs 后调用 `store.linkSession`，因此一次 sync 之后 `observeIntegrationsForSession` 就能读到该会话的 PR。
- **`no_checkpoints` / `no_origin_remote` 不算用掉那次 sync**：它们表示「这次没东西可看」而不是「看过了没有」，所以下一次 turn 仍会再试；只有 `synced` 与 `observation_failed` 才算用掉（`packages/cli/src/tui/pr-refresh.ts`）。
- **footer 宽度约定**：徽标放在会话名之前，窄终端从右裁剪时先丢会话名（最不结构），保住徽标与路径。
- **badge 只在 inline 模式出现**：full-screen 模式是单行 status row，没有 footer；本次不为它加第三行。
- **master 上已有 `statusline` profile**（full/compact/location/usage）。徽标属于「where」，因此只在 `full` 与 `location` 出现，窄 profile 不显示。
- **`core/tags.ts` 的 close 分支顺序已修**：link body 是 base64url，可能以 `-fg` 结尾，原先会被颜色分支抢走；把 link 判断提前。（该情形需要 URL 含非 ASCII 字节才可达，属防御性修正。）
- **worktree 的代码与主检出不同**：主检出在 `codex/tui-subagents-view` 分支上，footer 已无 `statusline` profile；worktree 从 `origin/master` 切出，更新。所有改动都在 worktree 内。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| worktree-tui-pr-badge @ 未提交 | Windows 11 / Node 24.16.0 | `npx vitest run packages/cli/src/tui/__tests__/{pr-badge,pr-refresh,footer}.test.ts` | 0 · 3 文件 / 52 用例通过 | Tail: `Test Files 3 passed (3) · Tests 52 passed (52)` |
| worktree-tui-pr-badge @ 未提交 | Windows 11 / Node 24.16.0 | `npm run architecture:check` | 0 | `OK — no new boundary violations.`（全部 3102 条均在 baseline 内） |
| worktree-tui-pr-badge @ 未提交 | Windows 11 / Node 24.16.0 | `npm run typecheck:all` | 0 | 全链路通过；`typecheck-electron-gate` 报 178 条 baseline 内既有错误、无新增 |

## 接续 / 结果

已实现：
- `packages/cli/src/tui/pr-badge.ts`：徽标选择规则（进行中优先、同组取最新）、状态→配色映射、状态说明与分组。
- `packages/cli/src/tui/pr-refresh.ts`：读投影 + 至多一次 sync 的有界刷新；`no_checkpoints` / `no_origin_remote` 不消耗那次机会。
- `packages/cli/src/tui/footer.ts`：第一行承载徽标（路径与分支之后、会话名之前），颜色表状态，终端支持时挂 OSC 8 链接；`statusline` 的 `full` / `location` 档显示，`compact` / `usage` 不显示。
- `packages/cli/src/tui/TUIApp.ts`：新增 `pullRequestBadge` 选项，把徽标与终端超链接能力交给 footer。
- `packages/cli/src/chat.ts`：turn 结束、启动时、会话切换时刷新徽标；刷新逻辑走 `readPrBadge`。
- `packages/cli/src/tui/core/tags.ts`：close 分支里 link 判断提前（防御性）。
- `packages/cli/src/tui/slash/pr.ts`：`/pr` 升级为可交互列表（Enter 看详情），详情含 base / head / url / 观测时间；`/pr refresh` 保持原面板。
- `packages/cli/src/tui/slash/statusline.ts`：档位说明补上 pull request。
- 测试：`packages/cli/src/tui/__tests__/pr-badge.test.ts`、`pr-refresh.test.ts`（新增），`footer.test.ts`（补 5 例）。

已验证：`typecheck:all` / `architecture:check` / 定向 vitest（52 用例）退出码均为 0，见上表。已合并：无。PR URL：待建。

副作用：仅本 worktree 内的文件改动，无外部副作用。

回收：未回收（成果已提交、待集成）。

下一步：推送分支、开 PR，等必需检查通过后按用户授权合并，再更新本节的 PR URL 与合并 SHA。

已知验证缺口：真机冒烟未做——inline TUI 无法用管道驱动，徽标在真实终端里的配色与 OSC 8 点击需用户在有 PR 的会话中确认。
