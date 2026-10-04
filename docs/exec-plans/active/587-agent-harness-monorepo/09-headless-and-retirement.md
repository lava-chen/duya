# H8 — 多 Host 共用与旧包退役

前置：M5、C6、D7。Next：H8.1。已有CLI/automation/workflow入口逐个接管，不新写平行引擎。

## H8.1 Headless composition

- [ ] CLI组合相同runtime/core/protocol、CPservices和SQLite/secret/processadapter，运行时import不含Electron/preload/DOM；现有CLIcommand/runner保留产品交互。
- [ ] CP是否独立成包用真实CLI/serverconsumer决定。先提供正常公开内部module入口；真正提包后Desktop只留adapter/composition，避免跨apps相对import变成长期接口。
- [ ] 需要独立HTTPdaemon时建立apps/agent-server，复用同服务；standalone服务默认受控local接口，auth/origin/资源限制实际验证，部署cloud另行授权。
- [ ] package membership/build/publish/CI选择分开；evals不成为生产依赖。

## H8.2 其他 consumer

- [ ] automation/wake将durableintent提交CP并读RunResult，取消和failure与Desktop一致；不会绕permission或预算。
- [ ] workflow `wf.agent`复用同runadapter，workflowRunId/nodeId与agentRunId关联；遵守560的Go/No-Go已验收结果，不复制worker内loop。
- [ ] subagent运行作为parentchildrun关联；profile/workspace隔离和backgroundoutput沿同合同；worktree能力由496拥有其具体Git实现。
- [ ] HTTP/subprocess/in-process同合同回归；CLI非交互approval拒绝/timeout或使用显式policy，不能自动allow。

### H8.2 测量记录（2026-10-04，未完成迁移）

入口普查已落为可重算的测试 `apps/desktop/src/main/__tests__/h8-2-consumer-inventory.test.ts`：
每个 `.streamChat(` 生产站点要么登记为 turn entry、要么登记为 look-alike，新增未登记站点直接失败。
因此下列数字可被测试复核，不是散文声明。

| 站点 | consumer | 经CP? | 判定 |
| --- | --- | --- | --- |
| `packages/agent/src/process/agent-process-entry.ts:3127` | desktop | 是 | 唯一经 `openRun` 的 turn |
| `packages/agent/src/cli/index.ts:509` | cli (REPL) | 否 | 直接 `new duyaAgent` |
| `packages/agent/src/cli/index.ts:549` | cli (`--task`) | 否 | 同上 |
| `packages/agent/src/cli/index.ts:749` | cli (`--print`) | 否 | 同上 |
| `packages/agent/src/tool/SubagentTool/runAgent.ts:499` | subagent | 否 | worker 内嵌套 loop |

**非CP turn entry = 4**（H8.3 退役闸门的计数对象）；另有 7 个 look-alike（compaction/side-question/
TurnStreamRunner/vision/memory/title/search，同名 `AIClient.streamChat`），刻意不计入。

逐条结论：

- **automation/wake：已经在CP上。** `agent-run.ts` POST 到与渲染器同一个
  `POST /sessions/:id/chat`，router 走 `deps.runOrchestrator.openRun`（`router.ts:1256`），
  cancel 走 `DELETE` → `handleDeleteChat` → `cancelSession`。
  `NON_DESKTOP_CONSUMERS` 里「runId 只活在 session id 字符串里、从不进 runs 表」的记录**已过期**。
  剩余缺口只有一个：它读 SSE `done` 收尾，**没有读 `RunResult`**。
- **workflow `wf.agent`：没有第二条 loop。** 560 的 Go/No-Go 走了 Go（方案 A），
  `workflow-runner.ts` 的 `runAgent` port 绑到 `SUBAGENT_TOOL_NAME`，因此与 subagent **共用同一条私有路径**。
  身份是自建表的 `workflowRunId`，与 `agentRunId` 尚无关联。**未改动。**
- **subagent：`runAgent.ts:499` 在父 worker 内直接 `streamChat`**，是嵌套 loop 而非 child run，
  身份 `taskId`/`subAgentSessionId` 都不是 runId，**无 `parentRunId`**。
  worktree 仍消费 496 的 `SubagentTool/worktree.ts`，未重实现 Git 行为。
- **CLI 非交互 approval：不自动放行。** CLI 不传 `permissionMode`（`DuyaAgent.ts:851` 落回 `'default'`）、
  不接 `requestPermission`，故 `ask` 落到 `resolveAskWithoutUser` → `deny`。
  行为级断言（含「工具未被执行」的 spy）见 `packages/agent/tests/permissions/cli-approval-safety.test.ts`，
  关闭 fail-closed 分支会使其 8 条失败，已验证非空断言。
  遗留产品缺陷：`duya setup` 写 `permission_profile`（含 `bypassPermissions`/`dontAsk`），
  但 CLI 运行期**无人读它**（唯一读取点是 setup 自身的回显），该设置静默无效。
  方向是 fail-closed（更安全，不是越权），但属配置漂移，需独立决策后再接线。

**PR #178（H8.1）截至 2026-10-04 仍为 OPEN / CONFLICTING，未合入 master**：
`packages/agent/src/process/headless-run-host.ts` 在 `origin/master` 上不存在，
CLI 的 3 个 `streamChat` 站点因此仍在树内。H8.2 的 CLI 改造以 #178 落地为前置。

## H8.3 清理与兼容窗口

- [ ] 消费者清单逐项归零：agent旧exports、aiwire再导出、CLI旧barrel、legacyworkercommands、main→agent实现、router自有seq/ring/双dispatch。
- [ ] shim保留release版本/使用指标和删除任务；至少一个兼容发布窗口实际过完，不以“经过一周”代替消费者证据。
- [ ] 在legacy读取路径尚可回退时停止新增写；schema收缩另PR，先rehearsal/backup/旧reader退出。
- [ ] 旧agent完全无剩余职责后删除package、buildscript、exports与bundle入口迁移；不能先删包再发现modes/工具仍引用。
- [ ] packageassets/nativeSQLite/BashWorker路径迁移同步build和packaging；不复制node_modules当生产修复。
- [ ] baseline只删除已消除fingerprints；managed新包zero容忍，fullsuite债有单独owner并尽量归零。

## H8.4 最终验收

| Host | 实际运行证据 |
| --- | --- |
| Desktop | 真实Electron、providerchat、approval/stop/reconnect/recovery、runs/events |
| Packaged Desktop | resourcesbundle/assets/native依赖完整，firstchatready，无modulemissing |
| CLI | 干净环境启动、offline/live已声明范围、非交互policy、恢复后产物 |
| Automation/Workflow | trigger→CP→runtime→terminal/outbox闭环及duplicate-trigger |
| Evals | 同API、无Desktop后端import、固定case/extendedreport、失败可归因 |

- [ ] clean多平台typecheck/build及requiredchecks，完整test无新增失败；capability与host支持范围逐项一致。
- [ ] ARCHITECTURE写实际owner/进程/DB/wire，packageREADME/exports同步；不把target图当current图。
- [ ] 迁移映射、旧任务清单和log全部有完成/显式后续归属，删除重复执行入口。
- [ ] 整个587目录移completed，项目索引移除Active row；rootRFC和docsarchitecture入口更新到completed位置。

## PR 与回退

H8-ACLI/headlessadapter；H8-Bautomation/workflow/subagent接管；H8-C退出旧wire/exports；H8-Dpackaging+deletelegacy；H8-E文档/gates收口。

退役前最后一个稳定兼容版本作为rollback点；数据保留compatible reader，外部副作用不通过gitrevert撤销。不能使用force/reset覆盖共享工作树。最终host能力可以不同，但其supported与限制必须真实且可探测。
