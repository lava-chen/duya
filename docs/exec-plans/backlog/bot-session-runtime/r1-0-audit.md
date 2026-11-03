# R1.0：生产调用链与状态单写者审计

状态：已审计（清单 + 最小 DTO diff 已产出）· 基线：master `95c30f58` · 更新：2026-11-01
执行：worktree `.claude/worktrees/bot-session-r1-0`（分支 `codex/bot-session-runtime-r1-0`）·
计划分支 `codex/bot-session-coordination`（PR #562）登记本片进度。

## 结论

1. 所有生产 Run 最终汇到**同一个** `openRun`（`packages/host/src/run-orchestrator.ts:658`），manifest 冻结与 run 行落盘因此是单写者。
2. 但 **Desktop 直接调 `openRun`**（`apps/desktop/src/main/agents/server/router.ts:1439`），绕过 `run-execution.ts` 的 checkout fence、caller 校验与权限收窄。准入前置因此有**两套强度**，R1.1 之前必须收敛。
3. 事件 `seq` 权威**已经在 Runtime**（`packages/agent-runtime/src/events/event-emitter.ts:28-44`），Host 只逐字落盘。迁移时 Host 不得再铸 seq。
4. 准入失败在 wire 上被降维：`run-execution.ts:547-556` 把 5 个内部 stage（`run_active` / `run_already_exists` / `run_not_created` / `started_not_durable` / `unknown`）压成同一个 `refused_run_open_failed`。**三态准入端口在此修复前无法成立**。
5. Session 层确实不消费 `projects` 实体，但 **project 概念出现在两处客户端/prompt 层**（见第 6 节），迁移时必须保持在 Session 服务之外。

## 1. 生产调用者矩阵

| 入口 | 调用链（file:line） | 终点 |
| --- | --- | --- |
| CLI/TUI 发消息 | `packages/cli/src/chat.ts:1649` → `packages/host/src/http-client.ts:527`（`POST /v1/agent-runs/start`）→ `packages/host/src/http-server.ts:3528,3540` → `packages/host/src/run-execution.ts:338` → `:536` | `run-orchestrator.ts:658` `openRun` |
| Desktop 发消息 | `apps/desktop/src/main/agents/server/router.ts:928` → `:1186` spawnWorker → `:1326` init → **`:1439` 直接 `openRun`** | 同上（**绕过 `run-execution.ts` 前置准入**） |
| Bot 派发 | `packages/host/src/bot-dispatcher.ts:218` → `packages/host/src/run-execution.ts:352` → `:536` | 同上 |
| Child Session | `packages/host/src/session-service.ts:353` → `:197` `startAgentRun` | 同上 |
| Sub-agent | `packages/host/src/worker-subagents/engine-run.ts:33` `driveSubagentRunWithEngine` → `packages/host/src/worker-engine-driver.ts:120` | **不经 `openRun`**：自建 session（`worker-subagents/service.ts:574`）、无 manifest 冻结、无 admission receipt |
| 取消 | `packages/host/src/http-server.ts:3543` → `packages/host/src/run-execution.ts:559` → `:573` `cancelRun` | `run-orchestrator.ts:1501` `controller.cancel` → `:1505` `#finish` → `run-control-plane.ts:290` `completeRun` |
| steer（忙时插话） | `packages/cli/src/chat.ts:906` `client.enqueue` → `packages/host/src/local-mailbox-api.ts:16` | `packages/data/src/mailbox.ts:294` `mailbox_items`（`kind='followup'`） |
| 排队（忙时 Tab） | `packages/cli/src/tui/turn-queue.ts:65` 进程内数组 | **不落库**（CLI 退出即丢） |
| 历史 | `packages/cli/src/chat.ts:592` `readMessages`（`includeSuperseded:false`） | `packages/host/src/session-api.ts` `readMessages`（rollout + `message_index`） |
| 重放 | `packages/cli/src/tui/run-event-resume.ts:62` SSE（`last-event-id`）→ `:98` `readAgentRunEvents`（`afterSeq`） | `packages/data/src/run-store.ts:273` `run_events` |

`openRun` 之后的下游对所有入口一致：`run-orchestrator.ts:756` `buildRunManifest` → `:766` `run:create`（`run-control-plane.ts:198`）→ `:841` `controller.start` → `:2683` `chat:start` → `worker-process-entry.ts:3228` → `:1759` `verifyRunManifestBinding` → `worker-engine-driver.ts:260` → `agent-runtime/src/engine/run-engine.ts:268` → `event-emitter.ts:28`（铸 seq）→ `run-orchestrator.ts:1584` `persistNativeRunEvent` → `run-control-plane.ts:235` `appendRunEvents` → `run-orchestrator.ts:1319` `#finish` → `run-control-plane.ts:290` `completeRun`。

## 2. 状态单写者

| 事实 | 唯一写者 | 证据 | 例外 |
| --- | --- | --- | --- |
| session id | Host `session-api.ts:456` | `input.id ?? randomUUID()` | `/fork` 由 CLI 铸（`packages/cli/src/tui/slash/shared.ts:317`） |
| run id | Host `run-orchestrator.ts:682,766` | 唯一铸造点 | — |
| manifest + fingerprint | `packages/host/src/manifest-factory.ts:171` | 唯一生产调用 `run-orchestrator.ts:756` | worker 侧 legacy 投影是**另一产物**（`worker-run-composition.ts:373`，唯一调用 `worker-engine-driver.ts:184`） |
| admission receipt | `packages/host/src/run-control-plane.ts:174-233` | `created`/`reused`/`conflict` | — |
| 事件 seq | **Runtime** `agent-runtime/src/events/event-emitter.ts:28-44` | Host 只落盘（`run-orchestrator.ts:1557`） | — |
| 终态 | Runtime `settle` → `run-control-plane.ts:290` `completeRun` | `run-orchestrator.ts:1341` | `#closeAbandonedRun`（`:983`）为**从未执行**的 run 合成终态 |
| 执行 owner（进程） | `packages/host/src/worker-manager.ts:367` + `worker-session-registry.ts:81` | registry 只记进程，不记任务完成 | — |
| 输入正文 | 客户端组装 → Host 落库 | `packages/cli/src/chat.ts:1649` | Bot 走 `bot_inbox.payload_json`；普通 chat 路径**无输入接收回执** |

**四处双写/旁路**（R1.0 必须登记，R1.3 收口）：

1. `run-orchestrator.ts:1282` `#committedTerminalByRun` 是终态影子副本，靠 `#durableTerminalFor`（`:1278-1296`）回读对账，不一致时丢弃事件并记 ERROR。
2. `packages/cli/src/host-session.ts:153` + `transcript-persistence.ts:78`：客户端直写 timeline，消费方 `packages/agent/src/cli/index.ts:444-484`（agent 在 CLI 进程内跑）。与 worker 并列构成**两个 transcript 写者**。
3. `packages/capabilities/src/send-to-agent-tool.ts:261-282`：发送方正文被旁路追加进发送方 transcript。
4. Desktop 的 `openRun` 直调（第 1 节第 2 行）：准入前置与 standalone 不同强度。

`worker-session-registry` 的 `SessionState.COMPLETED` **不是任务完成**：它只在 durable run 行已有 terminal 且 session 不忙时被派生写入（`packages/host/src/run-execution.ts:300-305`），worker 正常退出只写日志（`worker-manager.ts:470-471`）。

## 3. 字段兼容

| 事实 | 可 patch | 冻结 |
| --- | --- | --- |
| session | `title`/`projectName`/`status`/`model`/`providerId`/`mode`/`permissionMode`/`workspace`/`agentProfileId`/`parentSessionId`/`agentType`/`agentName`/`draft`/`extensions`（`packages/agent-protocol/src/session-api.ts:211-228`） | `id`、`createdAt`、`updatedAt`（乐观并发用 `expectedUpdatedAt`，`session-api.ts:474`）、`recencyAt`、`lastTurnStartedAt`、`archivedAt` |
| manifest | 无（全部 `readonly`，`packages/agent-protocol/src/manifest.ts:139-193`） | 全部；`ManifestField` 是**闭合集**（`:82-92`），加字段必须同时加枚举成员 |
| run | — | `manifest_hash`、`manifest_json`、`input_hash`（`packages/data/src/run-store.ts:242-260`）；`input_hash` 缺失即拒 create（`run-control-plane.ts:188-195`） |

`ManifestSource` 的 `'session_row'` 与 `'project_binding'` **已声明但零使用**（`manifest.ts:108,110`）——R1.0 若要给 manifest 加来源标注，无需新增枚举值。

## 4. 注释与代码不一致

| 位置 | 主张 | 实际 |
| --- | --- | --- |
| `packages/host/src/manifest-factory.ts:26-31` | 「No Desktop call site supplies one yet」（`permissionRules` 无来源） | 已是 wire 字段（`http-server.ts:5616` → `run-execution.ts:518` → `buildRunManifest`），`provenance.permissionPolicy.synthesised=false` |
| `packages/host/src/run-orchestrator.ts:2-10` | 「currently composed by Agent Server」，跨进程 `db:request` | 生产组装者是**进程内** standalone Host（`run-execution.ts:274-288`） |
| `packages/agent-protocol/src/run-api.ts:344-350` | 协议声明 steer 边界 | `steerAgentRun` **零实现零调用**；生产 steer 走 mailbox `kind='followup'` |
| `packages/agent-protocol/src/run-api.ts:356-359` 与 `:365-368` | — | `watchLiveAgentRunEvents` 在同一接口**声明两次** |
| `packages/bot/src/application/service.ts:22-24` | 「Desktop wake dispatcher remains the only scheduler」 | 已有 Host `bot-dispatcher.ts:30` |
| `packages/host/src/bot-dispatcher.ts:29,44` | 「legacy wakes untouched」「no public route yet」 | host 模式已被接管；渠道入站已有生产路由（`bot-channels.ts:35-57`） |
| `packages/agent-runtime/src/project/` | 目录名像 projects | 是 **projection**（SSE 投影），与 `projects` 表无关；命名易误读 |

## 5. 待裁决项

| # | 事项 | 证据 | 建议 |
| --- | --- | --- | --- |
| C1 | wire stage 降维 | `run-execution.ts:547-556` | 先修：让 `run_active`/`run_already_exists`/`run_not_created` 在 wire 上可区分，否则三态端口不成立 |
| C2 | `steerAgentRun` 声明无实现 | `run-api.ts:387` | 落地到 Host（带 `expectedTurnId` 校验 + 拒绝回执），或废止声明 |
| C3 | 客户端直写 timeline | `cli/host-session.ts:153`、`cli/transcript-persistence.ts:78` | 退役该导出；`packages/agent` 正在退役，不得为其保留第二写者 |
| C4 | 历史投影不一致 | CLI `includeSuperseded:false`（`chat.ts:592`）vs Desktop `true` | 统一口径，否则 R1.0 验收「TUI 与 Desktop 读取同一 transcript」不成立 |
| C5 | Desktop 直调 `openRun` | `router.ts:1439` | Desktop 改走 `run-execution` 统一入口，否则准入前置双轨 |
| C6 | `watchLiveAgentRunEvents` 重复声明 | `run-api.ts:356-359`/`:365-368` | 组合窄调用面前合并 |

## 6. Session 与 project 的真实耦合

用户原始要求：**「session 端只需要知道自己在什么 environment、什么目录启动，不需要过于复杂的 project 概念」**。实测结论：

- `sessions` 表**没有 `project_id`**，只有自由文本 `project_name`（`packages/data/src/session-store.ts:162`，可 patch、不可 join）。`chat_sessions` 同样只有 `project_name`（`packages/data/src/main-schema.ts:39`）。
- 唯一真实外键是 `workspaces.project_id → projects(project_id) ON DELETE SET NULL`（`packages/data/src/workspace-store.ts:166`，可空）。
- `RunManifest.projectId` 可空（`packages/agent-protocol/src/manifest.ts:142`），CLI/headless 路径**恒为 null**（`worker-engine-driver.ts:167`、`worker-headless-run-host.ts:662`）。设成必填会直接打断 CLI。
- `project_bots` 是**死表**：`addBot`/`removeBot`/`listBotsByProject` 生产调用点为 0。
- project 概念真正出现在两处，**都不在 Session 服务内**：
  1. 客户端请求组装：Desktop 按 cwd 反查得到 `projectId` + `projectHome` + 附加可写根（`router.ts:1309,1322` → `apps/desktop/src/main/agents/db-bridge.ts:1880`）。
  2. prompt 组装：worker 用 `projectHome` 注入 `~/.duya/projects/<id>/AGENTS.md`（`packages/host/src/worker-prompts/types.ts:417-419`）。

**边界结论**：Session 服务层与 session 记录层不依赖 projects；迁移保持该边界即可。将来若要重塑或退役 project，动的是上面两处与 `projects` 真实消费方（`GET /v1/projects`、TUI `/project`、bot memory tier、`plan` 工具目录），Session 服务不用碰。

## 7. 最小 DTO 草案（additive）

协议层只加类型不改行为，随 R1.0 单独 PR：

| 建议 | 位置 | 内容 |
| --- | --- | --- |
| 结构化输入 | `packages/agent-protocol/src/session-input.ts`（新） | `SessionInputRequest{sessionId, requestId, intent:'steer'\|'enqueue'\|'interrupt', expectedRunId?, expectedTurnId?, content, attachments?, contextRefs?}`；`SessionInputReceipt{inputId, requestId, stage:'persisted'\|'queued'\|'delivered'\|'consumed'\|'rejected', reason?}`（对齐计划 P2 的五阶段） |
| 控制租约 | 同文件 | `SessionControlLease{sessionId, leaseId, holder, revision, requestId, expiresAt}` |
| 清理 | `packages/agent-protocol/src/run-api.ts:356-368` | 合并 `watchLiveAgentRunEvents` 重复声明 |

数据层建议（**本片不实现**，留给 R1.2）：core 迁移 id 取 **> 48**（`packages/data/src/bot-outbox.ts:8` 是当前最大号）；新增 `session_inputs`（`request_id` 唯一、`input_seq` 单调）与 `session_control_leases`（`session_id` 主键、`revision` CAS）。**不复用** `session_runtime_locks`（执行锁，语义相反）与 `mailbox_items.client_msg_id`（已是 dedup 键）。

## 8. 验证记录

| 环境 | 基线 | 操作 | 结果 |
| --- | --- | --- | --- |
| Windows / 独立 worktree | master `95c30f58` | 5 条只读代码调查（CLI/TUI、Desktop、Bot、Host 控制面、data/protocol） | 全部结论可追溯到 file:line；未构建、未跑测试、未改产品代码 |

## 9. 接续

- R1.0 的清单与本文件已并入计划分支 PR #562；最小 DTO diff 以独立 PR 交付（协议层 additive，行为不变）。
- R1.1 的实现以本文件第 1–3 节为边界：`agent-runtime/src/session` 公开 subpath、通用历史恢复迁入、admission 端口三态 + receipt 携带、Host 原入口转发新服务。
- R1.1 开工前先落 C1（wire stage 降维修复），否则三态准入无法在 wire 上验证。
- Sub-agent 旁路（第 1 节第 5 行）是 R1.1 未覆盖的第二条执行路径，需在 R1.3 收口时决定是否纳入统一服务。
