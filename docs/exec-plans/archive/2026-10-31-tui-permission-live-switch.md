# TUI 权限切换实时生效 + 已发 steer 的渲染

状态：complete · 负责人：mavis · 更新：2026-10-31
分支：fix/tui-permission-mode-live · worktree：E:\Projects\duya\.claude\worktrees\permission-live · base：a33bbb05 · owner：mavis
集成：PR #554 由 `lava-chen` 以 merge commit `59cd3e3d` 合入 master（2026-10-31T10:25:52Z）。真机冒烟待用户。

## 目标与边界

用户在 CLI TUI 按 `Shift+Tab`（或 `/permission`）切换权限模式后，**正在跑的这一轮**就该按新模式做权限裁决。
已发出的 steer 在队列预览里必须显示为「已发出」，不能画成待发。

改动范围：`packages/host/`（读侧修 await + 写侧推 `permission:set`）、`packages/cli/src/tui/`（steer 行文案）、`packages/cli/src/chat.ts`（注释）、回归测试。
不处理：Desktop composer（它已有自己的 live 通道）、`auto` 模式语义、`LocalToolPermission`（Host 常驻开关，另一条轴）、steer 落地的时机（下一模型边界，属 Worker 行为）。

关联：上游 [TUI 权限 banner 与 Shift+Tab 快速切换](archive/2026-10-29-tui-permission-banner.md)（PR #538，`73710504`）。

## 验收

- `npx vitest run packages/host/tests/authorization/session-permission-profile.test.ts packages/host/tests/session-permission-hook.test.ts packages/host/tests/run-execution.test.ts` 通过。
- `npx vitest run packages/host packages/cli` 无回归。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。
- 真机：TUI 里 `Shift+Tab` 切到 `bypass` 后，同一轮里再触发一次需要审批的动作，应不再弹审批；steer 发出后预览行应显示 `↳ sent`。TUI 只能人工敲（ink 不接受管道输入），此项由用户执行。

## 进度

- [x] 定位根因（读侧漏 `await`；Host 无 live 通道；steer 文案把已发当待发）
- [x] 抽出可测的 `readSessionPermissionProfile`
- [x] 修 `chat:start` 的读（`await`）
- [x] Host 写侧推 `permission:set` 给运行中的 worker
- [x] steer 预览行文案：`↳ steer` → `↳ sent`
- [x] 回归测试（读侧单测 + 真 Host 跑 stub worker 的端到端 + 队列预览）
- [x] 门禁（typecheck:all / architecture:check / host 与 cli 全量）
- [x] 推分支 + PR #554 + CI 全绿 + merge commit 合入 master

## 发现与决策

- **写侧一直是好的**：`applyPermissionMode` → `PATCH /v1/sessions/:id` → `session-api.update()` → `permission_mode` 列落库，全链路正常。坏的是读侧。
- **根因是漏了 `await`**：`worker-process-entry.ts:1852` 写的是 `const sessionRow = sessionDb.get(msg.sessionId)`。`sessionDb.get` 是 IPC 异步调用，返回 Promise；`Promise.permission_profile` 永远是 `undefined` → `rowProfile` 永远 `null` → `profileToAgentMode(null)` → 永远 `'default'`。同文件 1684 行的读法是对的。自 `8f7f5032` 引入即如此。
- **所以不是「下一轮才生效」，而是「一直不生效」**：worker 只有两处会设置 agent 的权限模式 —— `chat:start`（读侧坏了）与 `permission:set`（Host 从不发）。清单里的 `permissionPolicy.mode` 虽按行算对了，但门禁读的是 agent 的模式，所以 badge 显示 `[bypass]` 而实际仍在逐次审批。
- **`full_access` 不能直接喂给 agent**：`permissionModeFromString` 不认它，会 fallback 成 `default`。profile→agent 模式必须过 `profileToAgentMode`（`@duya/agent-runtime/authorization/profile-bridge`），这也是 Desktop 的做法。
- **「实时」需要第二根线**：权限门是每次决策实时读模式的（`permission-gate.ts:172` 的 `getPermissionMode()`，注释明写 "per-call accessor; do not snapshot"），所以把模式推给**运行中的 worker** 就能真正即时生效。Desktop 早就有这条线（`agent-communicator.ts:202` → Agent Server `POST /sessions/:id/permission-mode` → `permission:set`），Host 侧（CLI 走的路）一直没有。
- **hook 放在 `session-api.update()`**：模式变更的唯一写入口就是它；`local-host.ts` 把 hook 接到 `runExecution.setSessionPermissionMode(...)`，`PATCH /v1/sessions/:id` 因此全覆盖。hook 只在真的变化时触发，避免每次改标题都往 worker 推命令。
- **steer 的「已发出」是数据里现成的事实**：`PendingDraft.mode === 'steer'` ⟺ 已经有 Host 邮箱行（两处写入点都同时给 mode 与 mailboxId）。所以不需要新字段，只改文案：预览行由 `↳ steer` 改成 `↳ sent`，`/queue` 面板描述由「steer · …」改成「sent · …」。草稿仍留在队列里，是为了「这一轮没读到就改作下一轮发出」的兜底。
- **没有动页脚计数**：页脚的 `⧗ N` 是「队列里有几条待办」的计数，不是「还没发出去」的计数；改它会连带影响「/queue resume」提示的触发条件。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| a33bbb05（基线） | Windows 11 / Node 24.16 | `node scripts/junction-worktree.mjs .` | 0 | 建 60 条 workspace 链接 |
| 工作区改动 | 同上 | `npx vitest run packages/host/tests/authorization/session-permission-profile.test.ts packages/host/tests/session-permission-hook.test.ts` | 0 | 2 文件 / 9 用例全过 |
| 工作区改动 | 同上 | `npx vitest run packages/host/tests/run-execution.test.ts` | 0 | 15 用例全过，含新增「把模式变化推给正在跑这一轮的 worker」 |
| 工作区改动 | 同上 | 变异验证：摘掉 `onPermissionModeChanged` 接线后重跑上面那条 | 1 | 用例变红，证明断言是承重的 |
| 工作区改动 | 同上 | `npx vitest run packages/cli` | 0 | 134 文件 / 1595 用例全过 |
| 工作区改动 | 同上 | `npx vitest run packages/host` | 0 | 242 文件：241 通过 / 1 跳过 / 0 失败 |
| 工作区改动 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations；「5 条基线指纹不再触发」在 master 上同样出现，非本次引入 |
| 工作区改动 | 同上 | `npm run typecheck:all` | 0 | no new type errors（178 known across 101 keys）；electron gate 的「10 条基线 key 收缩」是既有状态 |
| 工作区改动 | 同上 | `npm run bundle:worker` | 0 | worker bundle 重建；metafile 的输入差异 = 4 个改动的 host 源文件 + 1 个新模块，无关输入未变（bundle 产物 0 个 `\r`，内容与 master 一致） |
| PR #554 head `a40720bc` | GitHub Actions（ubuntu-latest 22.x） | 必需检查 | 全绿 | architecture / build / test / test scope / typecheck 五项在最新 head 上通过 |

## 接续 / 结果

已实现、已验证、已合并：PR #554，merge commit `59cd3e3d`。
两个提交：`7bf54e9b`（权限实时生效）、`a40720bc`（steer 渲染）。
真机冒烟待用户：TUI 里 `Shift+Tab` 切 `bypass` 后同一轮不再弹审批；steer 发出后预览行显示 `↳ sent`。
回收：worktree `permission-live` 已按 `scripts/remove-worktree.sh` 回收，分支 `fix/tui-permission-mode-live` 已删除。
