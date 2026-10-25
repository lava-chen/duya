# TUI 后台任务视图

状态：active · 负责人：qoder session · 更新：2026-10-24
分支：codex/tui-background-tasks · worktree：`.claude/worktrees/tui-background-tasks` · base：`686f3c81` · owner：qoder

## 目标与边界

让 `duya tui` 能看见并查看后台工作（后台 bash 与 subagent）：转录下方常驻一行摘要，F6 / `/tasks` 进入任务视图，方向键选行、Enter 打开详情。

用户可观察的变化：

- 摘要行常驻在转录与输入框之间：`⠋ <当前活动> · 1 background · 1 subagent · /tasks details`；没有后台工作时整行消失。
- `F6` 或 `/tasks` 进入任务视图；`↑↓` 选行，`←→` 折叠/展开分组，`Enter` 打开详情，`Esc` 回到输入。
- 任务视图把背景 bash 与 subagent 分成两个可折叠分组，行内显示名称、状态、耗时。
- 详情窗口显示命令（或 agent 描述）、状态、启动时间、耗时、退出码，以及后台 bash 输出的尾部。

允许修改：

- `packages/agent-protocol`：新增本地后台任务读契约（独立文件）。
- `packages/host`：缓存 worker 已推送的 `bash_task:update` 快照，新增只读 HTTP 路由与客户端方法。
- `packages/cli`：事件投影、任务模型、摘要行、任务视图、`/tasks` handler。
- `packages/command-catalog`：`/tasks` 条目。
- `docs/exec-plans`：本计划与入口表。

本次不处理：

- kill / cancel 后台任务（第二步）。
- 在主 TUI 内进入子会话的实时 transcript（第二步）。
- 任务出现时自动展开面板、drain 后自动收起（第二步）。
- Desktop 侧改动；Desktop 已通过 IPC 有完整 `BashTaskSection`。
- 完整输出流式推送；只提供按需读取的尾部快照。

## 验收

| 层 | 命令 / 操作 | 预期 |
| --- | --- | --- |
| 缓存 | `npx vitest run packages/host/tests/background-task-index.test.ts packages/host/tests/run-execution.test.ts` | 新快照整体替换旧快照、按 session 隔离；真实 worker 发出的 `bash_task:update` 落入缓存并经读 API 返回 |
| 契约与 Host | `npx vitest run packages/host/tests/background-task-routes.test.ts` | 未注入 API 返回 404 命名错误；注入后按 session 过滤、字段收敛 |
| 投影 | `npx vitest run packages/cli/src/tui/__tests__/host-event-projection-coverage.test.ts packages/cli/src/tui/__tests__/host-event-stream.test.ts` | `subagent.started/completed` 不再落入 `default` 丢弃；覆盖率测试的 `suspicious` 标记移除 |
| 任务模型 | `npx vitest run packages/cli/src/tui/__tests__/background-tasks.test.ts` | 合并、排序（运行中优先、新到旧）、分组折叠、计数正确 |
| 摘要行 | `npx vitest run packages/cli/src/tui/__tests__/working-tail.test.ts` | 有任务且空闲时仍渲染；计数与 `/tasks details` 提示；宽度裁剪不切断标记 |
| 视图与按键 | `npx vitest run packages/cli/src/tui/__tests__/tui-key-routing.test.ts packages/cli/src/tui/__tests__/tui-background-tasks-view.test.ts` | `F6` 进入任务聚焦；方向键只移动任务选择；`Esc` 回到输入；无任务时显示空态 |
| 门禁 | `npm run typecheck:all && npm run architecture:check` | 均通过，无新增 baseline 指纹 |
| 真机 | `npm run build:cli-dev`，再用 `node tmp/tui-bg-realrun.cjs`（node-pty 起真 `duya tui`，`DUYA_TUI_ATTACH=1` 挂到真 `duya serve`，worker 为 stub：发 `bash_task:update` 快照 + `subagent.started`） | 摘要行出现 `· 1 background · 1 subagent · /tasks details`；`F6` 画出两分组并可选中；`Enter` 详情含输出尾部；`/tasks` 再次进入；`Esc` 回输入；`Ctrl+D` 退出 |

基线：改动前在同一 worktree 运行上述测试记录失败签名；当前分支未改动时 TUI 侧相关测试应为全绿。

## 进度

- [x] Phase 0：记录基线（SHA、Node、上述测试退出码）。
- [x] Phase 1：`agent-protocol` 新增 `HostLocalBackgroundTaskApiV1`。
- [x] Phase 2：Host 侧缓存 `bash_task:update` 并暴露只读路由（列表 + 输出尾部）。
- [x] Phase 3：`HostSessionHttpClient` 实现该契约；TUI 侧新增 1s 轮询器。
- [x] Phase 4：TUI 投影 `subagent.started/completed` → `agent_progress` 帧。
- [x] Phase 5：任务模型（合并 bash + subagent、分组、折叠、计数）。
- [x] Phase 6：摘要行扩展（空闲且有任务时仍显示）。
- [x] Phase 7：任务视图替换 transcript 聚焦层（`focus: 'input' | 'tasks'`）。
- [x] Phase 8：详情窗口与 `/tasks` slash handler、catalog 条目。
- [x] Phase 9：门禁与真机验证，提交 PR。

## 发现与决策

1. **TUI 拿不到后台 bash 的真因不是 UI，是通道。** worker 的 `BashTaskRegistry` 每次变化都推 `bash_task:update`（`packages/host/src/worker-process-entry.ts:504`），但 Host 的 `#onWorkerMessage` 只处理 plugin-app / db / run:event / chat:*（`packages/host/src/run-execution.ts:728`），该消息静默落到末尾。Desktop 走 `apps/desktop/src/main/agents/server/index.ts:187` 的 `setMessageHandler` 转发给主进程；独立 Host 没有消费者。因此在 Host 侧加缓存分支是最小改动，不需要新增 worker→Host 请求协议。
2. **subagent 事件已经在线上，只是被投影丢弃。** `subagent.started/completed` 是 durable RunEvent（`packages/agent-protocol/src/events/registry.ts:228`），TUI 的 `projectHostEvent` 没有 case（`packages/cli/src/tui/host-event-stream.ts:111`）。`ActivityTracker` 已能处理 `agent_progress` 帧（`packages/cli/src/tui/components/activity.ts:189`），所以投影成同形帧即可让既有代码变活。
3. **方向键改造范围：只换 transcript 聚焦层。** 输入框的 `←→` 是行内光标、`↑↓` 是输入历史（`TUIApp.ts:2975`），保留不动。原 `focus: 'input' | 'transcript'` 的 transcript 分支（块选择 / 折叠，`TUIApp.ts:3203-3230`）替换为任务视图。块展开没有丢失：`Ctrl+T` 仍全局展开/折叠。
4. **子 agent 任务行不与 bash 混在同一个运行时表里。** 本步的 subagent 行来自 RunEvent（父会话视角），bash 行来自 Host 快照；两者在 TUI 模型层合并，不要求 Host 统一。
5. **输出只在详情里按需读。** 不推送 stdout 增量：协议没有工具输出 delta（`packages/agent-protocol/src/events/registry.ts:209`），Host 侧 `BashTaskRegistry.readOutput` 已有按字节尾部读取（`packages/host/src/managed-shell/task-registry.ts:236`），路由直接复用。
6. **CLI 的类型检查解析的是 Host 的 dist，不是 src。** `@duya/host/http-client` 在 CLI 侧走 `packages/host/dist`，因此新增客户端方法后必须先 `npx tsc -p packages/host/tsconfig.json`，否则 CLI typecheck 报 `listBackgroundTasks` 不存在。新增了跨包方法时这是固定前置步骤。
7. **分组全空时不画两个空标题。** `rows()` 在所有分组都没有任务时返回空数组，让视图落到空态；否则两个 0 任务标题会成为可选行，并且把 "No background tasks." / "unavailable" 的答案挤掉。只有一个分组为空时仍保留标题，结构可见。
8. **`←` 折叠、`→` 展开。** 初版把两个方向传反了（左传 `false`、右传 `true`），单测在真实按键路径上抓到；以 `setGroupCollapsed(id, true)` 为折叠修正。
9. **真机验证用 stub worker，而不是真模型。** `tui-command.ts` 的 `DUYA_TUI_ATTACH=1` + `DUYA_TUI_HOST_ORIGIN/TOKEN` 是现成的入口：终端、Host、HTTP/SSE、缓存、路由、投影、渲染全走生产代码，只有 worker 换成会发 `bash_task:update` 与 `subagent.started` 的桩。因此"前台超 15s 自动转后台"这条触发链没有被端到端跑（`autoPromoted` 是桩直接给的字段的值），它由 BashTool 自身用例覆盖；本步的视图只负责如实显示注册表告诉它的东西。
10. **桩 TUI 也要跟上生产选项面。** `chat-tui-host-stop-continue.test.ts` 的假 `TUIApp` 缺 `setBackgroundTasks` 等新方法，轮询器在真实 busy 期把快照推进去时抛错，`onError` 每轮重报，把本该唯一的 `runtime_crash` 挤成 6 条错误。补上四个方法后恢复。给 TUI 增加选项方法时，所有 mock `TUIApp` 都要同步。
11. **"产物只是再生噪声"这个判断在这里不成立。** 首版 PR 不带 `packages/host/bundle/*`，CI 的 `bundle:verify` 直接失败：它按历史比较"bundle 提交"与"任一第一方输入的最后提交"，本任务改了 `agent-protocol/src/index.ts`（新增 `export * from './background-tasks.js'`），所以即使重新生成的 `worker-entry.js` 差异几乎全是 esbuild 标识符改名，也必须提交一次再生结果把 bundle 提交推到后面。命令是 `npm run bundle:worker`——`npm run build:packages` 不会更新 bundle，跑完 `git status` 仍然干净，容易误判成"没有变化"。
12. **与 master 的真重叠只有"焦点层叫什么"，不是两套功能并存。** master 自 merge base 起没有碰 transcript 聚焦层，本任务在 Phase 7 把它整层换成任务视图（`focus: 'input' | 'tasks'`，见发现 3），所以 `TUIApp.ts` 三处冲突里两处是并集、一处要挑边：忙碌期状态栏提示取 master 的 `Enter steer · Tab queue · Esc stop`（它描述合并后树上真实存在的键行为，master 的 `tui-busy-draft-keys.test.ts` 也断言这三个词），Tab 键分支取本任务的 `focus === 'tasks'` 判定加 master 的排队分支。master 唯一因此过期的断言是 `'transcript'` 这个字面量，改成 `'tasks'` 后用例语义不变——仍断言"Tab 在空输入框上切焦点而不是进排队"。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `686f3c81` + 本计划文档 | Windows 10.0.26200 / Node 24.18.0 | `npx vitest run` 6 个相关测试文件 | 首次 2 文件失败：`Failed to resolve entry for package "@duya/ai"`（新 worktree 无 `packages/*/dist`）；`npm run build:packages` 后 6 文件 / 57 用例全绿 | 失败签名与修复动作见本条 |
| `686f3c81` + 未提交改动 | 同上 | `npx tsc -p packages/host/tsconfig.json` | 0 | Host dist 重建成功 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run packages/host/tests/background-task-index.test.ts packages/host/tests/background-task-routes.test.ts packages/host/tests/run-execution.test.ts packages/host/tests/run-execution-turn-contract.test.ts` | 0 · 4 文件 / 35 用例通过 | 含真实 worker 发出 `bash_task:update` 的端到端缓存/读取用例 |
| `686f3c81` + 未提交改动 | 同上 | `npx tsc -p packages/cli/tsconfig.json --noEmit` | 0 | 依赖上条重建的 Host dist |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run` projection 两文件 | 0 · 2 文件 / 15 用例通过 | `subagent.*` 已投影，覆盖率测试的 exact-set 反向断言仍成立 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run` `background-tasks/background-task-poller/working-tail/tui-key-routing/tui-background-tasks-view` | 0 · 5 文件 / 64 用例通过 | 模型、轮询、摘要行、按键路由、真机式视图渲染 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run packages/cli/src/tui/__tests__ --exclude '**/perf/**'` | 0 · 65 文件 / 783 用例通过 | 聚焦层改名后全 TUI 回归 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run packages/cli/src/tui/slash/__tests__/slash-commands.test.ts packages/command-catalog/tests/catalog.test.ts` | 0 · slash 71 用例通过，catalog 通过 | 注册表固定清单加入 `tasks`；`/hotkeys` 标题改为 Background tasks |
| `686f3c81` + 未提交改动 | 同上 | `npm run typecheck:all` | 0 | 末段 `eval:agent:core:check` 通过，说明整条链未中断 |
| `686f3c81` + 未提交改动 | 同上 | `npm run architecture:check` | 0 · 2729 tolerated / baseline 2530，无新增违规 | 仅提示 2 条 baseline 指纹消失 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run packages/cli/src/__tests__/chat-tui-foundation.test.ts` | 0 · 9 用例通过 | 新增 3 条 `chat.ts` 接线用例：打开视图触发一次读快照、`Enter` 读 bash 输出尾部并进面板、subagent 详情不读输出 |
| `686f3c81` + 未提交改动 | 同上 | `npx vitest run packages/cli` | 0 · 102 文件 / 1260 用例通过 | 首轮 1 失败：`chat-tui-host-stop-continue.test.ts` 期望 1 条错误实得 6 条，按发现 10 补齐桩 `TUIApp` 后转绿 |
| `686f3c81` + 未提交改动 | 同上 | `npm run build:cli-dev` 后 `node tmp/tui-bg-realrun.cjs` | 0 · 7 步全过（见验收"真机"行） | 日志 `tmp/tui-bg-realrun.log`：`• Completed · 1 background · 1 subagent · /tasks details`；`Tasks · ↑↓ select · ←→ fold · Enter open · Esc back` / `▾ Background bash (2) · 1 running` / `❯ ● sleep 60 · 16s`；详情面板 `command sleep 60 · pid 4242 · output 18 B · note promoted…` 且尾部正文 `listening on 3000` |
| `068d3752`（feature commit） | 同上 | `git merge origin/master`（`379d990b`，PR #461 带进 `/compact` `/btw` `/diff` 与 session compaction） | 2 处冲突：`tui/slash/registry.ts`（导入与命令表并列）、`host/local-host.ts`（`runExecutionApi` 与 `localBackgroundTaskApi` 同一个 spread，再加 master 的 `sessionCompactionApi` / `sideQuestionApi`）；合并提交 `42066088` | 固定注册表清单合并后同时含 `btw/compact/diff/tasks`，未被任一侧覆盖 |
| `42066088` + 未提交改动 | 同上 | `npm run build:packages` 后 `npm run typecheck:all`、`npm run architecture:check` | 均 0 · 2738 tolerated / baseline 2530，无新增违规 | 合并后重验：门禁仍只提示同样 2 条指纹消失 |
| `42066088` + 未提交改动 | 同上 | `npx vitest run packages/cli`；host 4 文件 + catalog | 0 · CLI 106 文件 / 1298 用例；host+catalog 5 文件 / 63 用例 | 合并引入的 slash 用例与本任务用例同树通过 |
| `42066088` + 未提交改动 | 同上 | `npm run build:cli-dev` 后 `node tmp/tui-bg-realrun.cjs` | 0 · 7 步全过 | 真机链路在合并后的树上复现，摘要行与详情文案与合并前一致 |
| `d9d365e1` | 同上 | `git merge origin/master`（`f6120e04`，PR #462 改了 `TUIApp.ts` 的 inline 滚动） | 1 处冲突：HEAD 的 `openSelectedTask()` 与 master 更新过的 `revealSelectedBlock()` 重叠；本步已删除 transcript 块选择，保留 HEAD 方法、丢弃后者（`grep revealSelectedBlock` 在 `src` 中已无调用点）。合并提交 `21af3db4` | 4 处注释仍点名已删除的方法，随 `docs(tui)` 提交改为 `visibleWindow()` / 滚动数学 |
| `21af3db4` | 同上 | `npx tsc -p packages/cli/tsconfig.json --noEmit`；`npx vitest run packages/cli`；transcript 两文件 | 均 0 · CLI 106 文件 / 1297 用例；transcript 30 用例 | 二次同步后重验；PR #464 由 CONFLICTING 转 MERGEABLE，Test workflow 在 head `21af3db4` 上运行 |
| `9b4bfc35` | 同上 | CI：Test workflow（architecture / test scope / typecheck / test） | architecture **FAIL** · `bundle:verify`：`STALE worker-entry.js`，6 个 bundle 输入在 bundle 提交 `41f5749b` 之后改动；其余 3 项 pass | 失败签名与发现 11；修复动作 = `npm run bundle:worker` 后提交 bundle（`26cef6db`） |
| `26cef6db` | 同上 | `npm run bundle:verify`；`npm run architecture:check`；`npx vitest run packages/cli packages/host/tests/{background-task-index,background-task-routes,run-execution}.test.ts` | 0 · `FRESH 0/953 bundle inputs`；2738 tolerated 无新增违规；首轮 1 失败 / 1325，重跑两次均 109 文件 / 1325 全绿 | 首轮那条失败在随后两次同命令运行中不可复现（记录为 flake，未定位到用例） |
| `26cef6db` | GitHub Actions | `gh pr view 464 --json statusCheckRollup` | 全 pass · architecture / test scope / typecheck / test / build | 修好 bundle 后 architecture 由 FAIL 转 pass |
| `8887d295`（文档提交） | GitHub Actions | `gh pr checks 464 --watch` | 全 pass · architecture 2m30s / test scope 8s / typecheck 4m50s / test 5m52s / build 3m23s | PR 状态 MERGEABLE、非 draft、无 required review 阻塞记录 |
| `8449a39b`（merge 提交） | 同上 | `git merge origin/master`（`0bab8f6a`）解 7 处冲突后：`npm run typecheck:all`；`npm run architecture:check`；`architecture:client-closure` / `slice-graph` / `boundaries` / `browser-closure`；`npm run plan:sync`；`npm run test:rules`；`npx vitest run packages/cli packages/agent-protocol`；`npx vitest run packages/host/tests/{background-task-index,background-task-routes,run-execution}.test.ts`；`npm run bundle:verify` | 均 0 · typecheck 0；architecture 2747 tolerated / baseline 2530 无新增违规；plan:sync 16 行 / 28 file refs / 14 test-name refs OK；test:rules 6/6；CLI + protocol 137 文件 / 1814 用例；host 3 文件 / 28 用例；bundle `FRESH 0/957` | 首轮 vitest 1 失败 / 1814：`tui-busy-draft-keys.test.ts` 断言 `focus` 为 `'transcript'`，见发现 12；改断言后全绿 |

## 接续 / 结果

已实现：Phase 1–9（契约、Host 缓存与只读路由、客户端方法、1s 轮询器、subagent 投影、任务模型、摘要行、任务视图与详情、`/tasks` 与 catalog 条目）。
已验证：上表单元/集成/门禁项；`packages/cli` 全量 1260 用例；跨包 typecheck 与架构门禁；真机 PTY 7 步（`tmp/tui-bg-realrun.log`）；合并 master 后的 9 项门禁与 CLI + protocol 1814 用例（见 `8449a39b` 行）。
未验证：真模型驱动的 `sleep 60` 前台超时自动转后台触发链（发现 9）；Desktop 侧未改动；合并后的真机 PTY 7 步**未**重跑（本次只做冲突解决与门禁复验）。
本任务不提交的本地改动：只剩 `packages/capabilities/src/ModuleTool/inline-content.ts` 与 `packages/host/bundle/package.json` 的行尾差异（`git diff --numstat` 为 0 行内容变化），已 `git restore`。worker bundle **必须**提交：`scripts/architecture/bundle-verify.mjs` 比较 bundle 提交与其第一方输入的最后改动，`packages/agent-protocol/src/index.ts` 现在多转出了契约文件，历史即判 STALE；重建命令是 `npm run bundle:worker`（`build:packages` 不含它），产物差异基本是 esbuild 压缩标识符改名，metafile 才记录真实新增输入。
PR：[#464](https://github.com/lava-chen/duya/pull/464)（base `master`，head `codex/tui-background-tasks`，非 draft）；未合并。已把 `origin/master`（`0bab8f6a`）合并进分支（merge 提交 `8449a39b`），冲突全部解决且门禁全绿，等新 head 上的 CI 重跑与 review 后按授权集成。
回收：未开始；分支与 worktree 在 PR 集成前保留。
下一步：在 PR #464 的新 head（`8449a39b`）上跑 CI 与 review，通过后按授权集成；随后重验真机 PTY 7 步、同步 master 并回收 worktree。第二步（kill / 子会话实时 transcript / 输出流式 / 自动展开收起）另立计划。
