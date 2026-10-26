# 个人长期 Bot：统一领域边界与可靠迁移

## S3c execution — 2026-10-26

- Owner: Codex root, `codex/bot-framework-s3c`, isolated linked worktree
  `.claude/worktrees/bot-framework-s3c`, base S3b `a692d74b` plus S2
  `3a35e047` integrated at `3bfaca2a`. Existing PR branches are not edited.
- Goal: complete the S3 acceptance matrix before declaring S4 ready. Persist
  per-Bot scheduler ownership and fence Run admission; forward Desktop input
  and revoke renderer execution for migrated Bots; preserve wake payloads,
  preemption/redrive, terminal reconciliation, restart and rollback evidence.
- Desktop keeps its current database owner and Agent Server executor. The
  shared Host scheduler is assembled over those existing ports; no second
  database connection owner or Run orchestrator is introduced.
- Implemented: migrations 46–47 persist owner epochs and preemption intents;
  Run creation atomically validates ownership, inbox lease and dispatch
  reservation; Host admissions carry fenced dispatch tickets; Desktop routes
  `sendTurn`, kickstart, claim and cancel through the Host-owned inbox only for
  opted-in Bots, preserving the legacy scheduler as the default. Accepted user
  input and its preemption intent commit in one SQLite epoch transaction.
  Cancellation names the exact Run ID; restart reconciliation redrives a
  cancelled background obligation from its stored WakeItem, retains user
  attachments, and sends malformed or exhausted work to recovery/dead-letter
  state. Ownership transfer requires drained Runs, inbox entries, wakes and
  preemption intents.
- Validation on final source: `npm run typecheck:all` exit 0;
  `npm run architecture:check` exit 0 with no new boundaries; four focused
  Vitest files, 59 tests, exit 0; `npm run electron:build` exit 0. The IPC
  E2E command attempted 50 cases but could not create a window in this runtime:
  Electron reports `Missing X server or $DISPLAY`; its default `/home/agent`
  test home is also not writable here. No IPC E2E assertion ran. The real
  Agent Server HTTP adapter's dispatch-ticket/canonical-Run-ID/specific-cancel
  tests passed (12/12) alongside the Host dispatcher and Wake routing tests;
  repeat the full IPC suite in CI or an X-enabled runner.
- S4 entry: S3 now supplies durable Bot input ownership and a fenced Run
  executor seam. S4 can start the data outbox and channel adapters. Its first
  work must define per-message channel event identity and acknowledgement
  recovery: the current legacy channel Wake envelope is not yet a durable
  per-event inbox/outbox receipt. Preserve this as an explicit S4 scope; do not
  infer channel delivery completion from S3c's Wake dispatch result.
- S2's classification/rule-file fixes are included; S1/S2/S3a/S3b review and
  CI remain with their existing owners. This branch is not yet integrated.
- Delivery: implementation commit `1795543e` on
  `codex/bot-framework-s3c`; draft [PR #506](https://github.com/lava-chen/duya/pull/506)
  targets `codex/bot-framework-s3b`. S3c is implemented and locally validated,
  but remains unmerged and the real IPC suite still needs an X-enabled runner.
- Worktree residue: the root/package `node_modules` workspace symlink overlay
  remains untracked and unstaged; `.e2e-userdata/` and `test-results/` are kept
  as evidence from the failed Electron launch attempt.
- Dependency setup: reused compatible S3b third-party modules with a worktree
  workspace overlay. Managed-worktree/context/CodeGraph tools unavailable;
  Git, current PR heads and versioned plans provided the shared-state evidence.


## S3b execution — 2026-10-26

- Owner: Codex root; branch `codex/bot-framework-s3b`; isolated worktree
  `.claude/worktrees/bot-framework-s3b`; foundation `bf9b62c8` (S2) plus
  `6c5d6229` (S3a), combined at `0a87a2f8`.
- Existing PR review belongs to other agents. This branch does not update
  #500, #502 or #503. Their fixes will be merged before integration.
- Scope: dispatch-key admission in the existing Run owner, a fenced data
  adapter over S3a tables, an opt-in Host inbox dispatcher and resident lifetime.
  Desktop routing remains S3c; legacy scheduling stays unchanged by default.
- Plan: record targeted baseline; implement admission and claim fencing; wire
  headless dispatch/reconciliation and shutdown; test lost responses, restart,
  stale claims and client disconnect; run repository gates and open a PR.
- Acceptance: one dispatch key never sends a second execution; expired claims
  cannot dispatch or mutate a new claim; a persisted terminal settles its input;
  ambiguous reservations/running rows become explicit recovery obligations;
  resident work survives the last client, then releases the Host when drained.
- Tools: managed worktree / workspace context / CodeGraph tools unavailable;
  isolated linked worktree and Git/PR/plan evidence used instead.
- Environment: Linux, Node 24.19.0. A clean install found S2's missing
  `@duya/bot` lock entry; independent dependencies are being prepared locally.
  No existing PR branch was changed.
- Implemented: opt-in `LocalHostHandle.botInputs`, scoped/fenced claim adapter,
  dispatch admission in the existing Run owner, restart reconciliation, and
  resident idle protection. An ambiguous start is a durable `recovery_required`
  dead letter; it never starts a second executor. Legacy routing is untouched.
- The isolated clean install also required declaring Host's existing Bot
  dependency and the two missing workspace lock entries (16 additive lock
  lines). This branch carries those prerequisites without changing #502.
- Validation on the S3b dirty tree: `typecheck:all` exit 0;
  `architecture:check` exit 0 with no new violations; Bot boundary PASS;
  `electron:build` exit 0; worker bundle rebuilt. Full affected regression:
  35 files / 239 tests passed, plus dispatcher 12/12 after correcting a test
  that wrongly assumed ordering between different Bots (priority is per Bot).
  The combined final coverage is 36 files / 251 tests. New tests: 15.
  Final Host runtime subset: 4 files / 36 tests, exit 0. A refused start
  without a reservation is retained once rather than retried forever.
- Runtime evidence: a real child-process Run survives the last HTTP client
  lease, reaches its durable terminal and releases the Host; a pending accepted
  input executes once after a real Host restart. Provider calls are stubbed;
  this is Host/process/persistence validation, not live-model or UI validation.
- Test environment: writable isolated `os.homedir()` preload for fixtures;
  Electron 44.9.1 archive verified against the package checksum after automatic
  download failed. Build warned that bundled ripgrep could not be downloaded;
  the build completed with its existing fallback. Raw logs stay in `work/`.
- Next: publish the S3b draft on the combined S2/S3a foundation (base master
  so PR CI runs), record its PR here, then integrate
  the independently reviewed S1/S2/S3a heads before S3c transfers Desktop
  scheduling ownership. Keep this worktree and all unmerged branches.
- S3c entry points checked: Desktop owns an embedded `HostSessionHttpServer`
  in `apps/desktop/src/main/cli/desktop-host-api.ts` and forwards execution via
  `createDesktopRunExecutionApi`; it does not call `startLocalHost`. Do not open
  a second database owner to enable this dispatcher. Transfer the Bot owner
  explicitly, forward `dispatchBotTurn`/`enqueueWakeItemForSession`, and reject
  `claimScheduledUserTurn` for migrated Bots. Preserve existing preemption,
  redrive, attachments, turn epochs and renderer event projections in that slice.
- Delivery: [Draft PR #504](https://github.com/lava-chen/duya/pull/504),
  implementation `e4c5019c0b83d3ffe1d1f5bfe1cfe1027a18f88a` on
  `codex/bot-framework-s3b`. Final staged-source `typecheck:all` exit 0,
  architecture exit 0, Bot boundary PASS and committed bundle FRESH.
  No user data migrated; no production scheduler switched; no PR merged.
  PR CI/review and prerequisite integration remain pending. Keep the worktree;
  ignored `work/` contains local logs and dependency-isolation fixtures only.


状态：active，设计已交付（draft PR #483 待 review）；S0 门禁与行为基线切片已实现并验证，待 PR review / CI · 负责人：Codex / root · 更新：2026-10-25
分支：`plan/bot-framework-foundation` · worktree：`.claude/worktrees/bot-framework-plan` · base：`270ba52869b6414094e553dd7f9abde5a1e429f7` · owner：本会话 root

## 目标与边界

本次交付是可评审的设计与迁移计划：定义长期个人智能体，明确 Bot 领域包、Host 运行装配、数据与记忆的唯一归属；以真实源码和四产品官方资料约束决策。后续按本计划切片逐步实现。

本次独占：本文件、`docs/design-docs/personal-bot-framework.md`、`docs/references/personal-agent-products.md` 及各自导航入口；仅文档。没有创建空 package、改 prompt、运行用户数据迁移或切换生产执行。

设计合同见[个人 Bot 框架](../../design-docs/personal-bot-framework.md)，依据与现有入口见[产品核实](../../references/personal-agent-products.md)。这两份文件维护合同和证据，本文件只维护排期、验收与接续。

前置与避让：610 保有通用 Run / Session / worker；622 保有层门禁与依赖测量；619 保有 prompt 双通道；620 保有会话记录合同；621 保有 managed workspace。Bot 切片调用这些服务，不接管其状态表，不重建 DAG、Run 引擎或审批系统。

## 本次设计验收与进度

- [x] 检查起始工作区无用户修改，fetch origin 并 pull 最新 master。
- [x] 从 `origin/master @ 270ba528` 建立独立 linked worktree；没有可用 managed worktree / workspace_get_context / CodeGraph 工具，以 Git 和版本化计划对账。
- [x] 核实当前 Host、Desktop wake、profile、memory、渠道与 Run 接缝；旧会话助手正文无法读取，已在依据中标明。
- [x] 按用户确认的四产品补读架构 / 安全 / 使用文档；完成八维对照，区分公开机制、源码事实和推导。
- [x] 写出领域合同、唯一 owner、失败窗口、迁移 / 删除标准与后续切片。
- [x] 完成导航、相对链接、Git 可见性、编码和 diff 检查；记录根门禁实际结果。
- [x] 提交文档切片并创建 [draft PR #483](https://github.com/lava-chen/duya/pull/483)，保存 review / 实施接续。
- [ ] S0–S7 生产迁移逐片验收；本次不勾选。

## 迁移切片

切片按顺序推进；同一数据根 / Bot 同时只有一个调度 owner。S1 建立端口后才开始 S2 提包。S3 的 durable 启动受理补齐前，S1 的 facade 只能委托旧调度器，不能伪装已可 headless 执行。

| 切片 | 交付与独占路径建议 | 依赖 | 完成标准 / 预计评审粒度 |
| --- | --- | --- | --- |
| **S0 边界与行为基线** | Bot 实际消费者清单、导入闭包探针、现有行为夹具；`scripts/architecture` 中 Bot 专属门禁与测试，计划证据 | 当前可开始；核对 622 01–04 真实 head | Bot→Host / UI→Host 反向边变异红→绿；现有身份、prompt、wake、投递行为具名基线。1 个门禁 PR |
| **S1 Host Bot 接口** | `host/src/bot` facade / ports，protocol 最小 DTO，Host 启动装配及 profile 写入接缝；旧 Desktop 调度作为过渡 adapter | S0 | Desktop/TUI 查询同一 Bot；create/update revision 冲突拒绝，错误不吞；不新增第二 scheduler。身份 journal 与跨文件修复测试。1–2 个窄 PR |
| **S2 提取 Bot 领域包** | `packages/bot` 的 domain/application/ports，host adapter，workspace/build/gates 必要接线 | S1；622 Host / 相关包层归属已落地或等价门禁实证 | 新包 managed、下向依赖受测、零 Electron/SQLite/fs/provider；至少一个真实 Host 用例消费，行为夹具不变。纯移动与行为修改分开 |
| **S3 持久唤醒与 resident** | data additive inbox / dispatch receipt；Host Run 幂等启动接缝、Bot dispatcher、lease 与恢复；Desktop bot handler 转发 | S2；Run receipt / fence 前置实证 | 无 UI 也能执行；Run 已受理响应丢失后不重复启动；旧 claim 无效；关闭最后客户端不误停 resident。先存储合同、再 Host 接线、最后切流，约 3 个 PR |
| **S4 投递与渠道** | data outbox；Host channel adapters；先 Telegram、再 Feishu 证明扩展接口；Desktop bridge / UI cards | S3；610 T22 范围对账 | 重复 inbound 一个 receipt；跨 binding 身份拒绝；发后崩溃进入 receipt reconciliation / unknown；无凭据泄漏。每平台独立 PR |
| **S5 记忆与 prompt 快照** | memory 范围过滤 / 遗忘 API，host BotContextSnapshot adapter，替换 worker 直接扫描；619/620 合同对齐 | S3；相关 memory owner 接缝 | own/user/project 授权隔离；撤权立即生效；prompt / 工具暴露对照不变；摘要不会复活已遗忘条目。人格变更另立切片 |
| **S6 持续责任与自主性** | Bot responsibility / attention 纯策略，现有 Goal / routine 端口，Host 预算与通知装配 | S3–S5；现有审批执行链 | 日程摘要闭环、离线 catch-up、预算 CAS、安静时段、暂停与授权撤销、审批准入；不重建 Task / DAG。按用户可见闭环拆 PR |
| **S7 旧路径退役** | Desktop wake / channel 业务退为 adapter 或删除，旧导出 / pending-wake bridge 清理，架构事实文档 | 所需 S3–S6 路径与各客户端已验收 | 消费者归零；新旧不能同时执行；fixture 迁移 / 回退 / 打包验收齐备，旧表最后 contract。独立删除 PR |

不以包数量、代码行数或搬了多少文件验收。每个 PR 都应说明一个用户行为、旧调用→新调用、失败时的结果与旧 adapter 退出条件。生产路径修改需相应 runtime / UI / 打包检查。

## 现有模块 → 目标归属

| 现有模块 / 旧任务 | 目标与退出条件 |
| --- | --- |
| `host/config-agents`、Desktop `config/bot-*`、485 | S1：Host 单写入口、规范 Bot view；保留 TOML / profile 兼容，旧 writer 消费者为零后删除 |
| protocol wake + core wake queue | 复用；S2 只迁 Bot 特有规则，不复制来源类型或通用队列 |
| Desktop `wake/*`、473 调度部分 | S3：Host Bot dispatcher；Desktop 只发送命令 / 展示状态，移除 renderer claim 执行权 |
| data `pending-wakes`、484、610 T22 | S3/S4：统一 delivery reconciliation 合同；T22 通用子会话完成事件仍由 610 owner 提供，Bot 只消费，不能两边实现同一唤醒 |
| Desktop `automation/*`、475、478 | S6：复用 Scheduler 与 routine 定义，触发适配器调 Bot acceptInput；通用非 Bot automation 保留原所有者 |
| Desktop `channels/*`、488、503 | S4：Host adapter + vault / connector 端口；不把 channel transport 和 AppConnector 视为同一概念 |
| `host/worker-prompts/bot`、474、479、536 | S5：有类型且受授权的 context；模板仍经既有 prompt 管线，memory 状态由 memory owner 维护 |
| `host/worker-tools/bot-builtin`、490 | 继续用现有 capability 工具，通过 Host Bot service 端口调领域；不在 bot 包实现 Shell / MCP |
| ui Bot chat / store、489、491 | S4 / S7：卡片和状态使用统一 query/event 投影；不以 SSE done 冒充对外投递完成 |
| DM / room、492、478 | 复用 Session / message envelope；S4 / S6 保持授权、hops 与防循环预算，不重做编排器 |

473–503 的历史 checkbox 不在本次批量改写。上述表只记录新合同覆盖关系；每个执行切片进入旧任务代码前，核实其剩余行为并在原计划加具名后继，确认完成或转交后再归档，避免两套调度工作队列。

## 风险、回退与数据窗口

| 风险 | 切流前证据 | 回退动作 |
| --- | --- | --- |
| 新旧调度同时执行 | 持久 owner epoch + 旧入口拒绝 + 双启动故障测试 | drain/暂停输入 → 交接 owner epoch → 切 adapter；禁止两者同时消费 |
| Run 受理后响应丢失 | 同 dispatchKey 查回 canonical runId；重启故障测试 | 保留 journal 对账；未可恢复 Run 标为 recovery_required，不盲目重跑 |
| 新 inbox 不能被旧版本理解 | 旧 marker 导入 dry-run、旧 reader 兼容夹具、记录新版本最低要求 | 先 drain 新队列或用有损项显式报告的 back-export；不能只 git revert |
| 身份文件与配置不一致 | 每个写入步骤 crash fixture，revision 冲突与修复 | durable create/update intent 驱动补齐，保留原始文件副本 |
| 远端动作已完成但 receipt 丢失 | provider 幂等 / 查询能力合同，unknown 路径演练 | 暂停 outbox，人工或 provider receipt 对账，不自动补发 |
| prompt 变动与目录迁移混杂 | 相同输入快照和工具 manifest 对照 | 保留旧组装 adapter；人格 / policy 变更分开开关与评审 |
| 机器离线被误报为持续服务 | resident 健康、租约与 catch-up 测试 | UI 明示离线与待处理，不承诺断电运行 |

迁移开关是设计要求，当前尚无这些开关：按 Bot ID 选择调度 owner，初始默认 legacy。shadow 只做只读比较，不调模型、不写 memory、不发工具与消息。切换步骤与 owner epoch 必须作为同一迁移命令校验；schema contract 只在回退窗口关闭后进行。

## 实施验收矩阵

每条由对应切片新增或复用具名测试；下表是待实现的测试要求，不能读作本次已通过。

| 场景 | 必须观察到的结果 | 所属 |
| --- | --- | --- |
| 同一 owner 由 Desktop 与 TUI 并发创建 / 更新 | 一份身份，requestId 去重，revision conflict 明确返回 | S1 |
| 同输入重投、两个 Bot 同 workId | 同 Bot 重投同 receipt；不同 Bot 相互隔离 | S3 |
| 在 inbox commit 后、dispatch 后、Run terminal 后杀 Host | 逐点重启对账，无丢失义务、无第二 executor | S3/S4 |
| user 抢占 background、旧 worker 延迟回报 | 绑定具体 runId/attempt；fence 拒绝旧写入；后台义务保留 | S3 |
| 最后客户端离开 / 重连 | resident 继续；client-scoped 行为不变；重连只读 replay | S3 |
| 发送已成功但未记 receipt | 幂等 provider 对账；不支持的进入 unknown，不能假成功 | S4 |
| 外部群成员 / DM 冒用 owner | 无权改 policy 或批准动作；记忆按受众过滤 | S4/S5 |
| 项目 membership 撤销、记忆遗忘后再压缩 | 立即禁止召回；旧摘要不复活记忆；审计保留边界明确 | S5 |
| 用户时区、DST 跳时 / 重复时、机器错过三天 | nextFire 与 fireKey 确定；按 misfire 策略限量补偿 | S6 |
| 预算并发预留、安静时段、暂停在途 / 排队责任 | 无超额派发；不重复打扰；审批与撤权照常生效 | S6 |
| 新增第二渠道 / 插件 | 改 adapter 不改领域与 Run loop；conformance 与真实接线通过 | S4/S7 |
| 旧版本 fixture 升级后回退 | 保留身份、历史、未投递义务与已完成动作；冲突可报告 | S7 |

每片执行根门禁；变更 main/preload 需 Electron 构建与真实桥；UI 用 Playwright；worker 或依赖 / 打包边界需重新构建并验证真实 Host→worker→provider 夹具→ledger。已有单测通过不替代后台 resident 和恢复链路。

## S0 执行记录（2026-10-25）

已实现、已验证、未合并。分支 `codex/bot-framework-s0`（base＝本计划分支 `plan/bot-framework-foundation` @ `1618a909`，PR 目标 master，交付 commit `24590d10`）；worktree `.claude/worktrees/bot-framework-s0`；owner 本会话。622 真实 head 核对：01 已合并（#399）、02 已合并（#405，README 状态滞后）、03/04 仍 todo——S0 依赖的 slice-graph / 门禁基建已就绪。

**交付（S0 = 1 个门禁 PR）**

- `scripts/architecture/bot-boundary-gate.mjs/.ts/.test.ts`，三条规则：
  - **R1 bot 下向**：`packages/bot/src/` 出现后，其全部非测试源文件的 value import 只允许 `@duya/agent-protocol` / `@duya/agent-core`；种子覆盖全部源文件而非 barrel，子路径无法绕过；不穿行 allowlist 包（agent-core 自己的依赖归它自己的门禁管）。包未提出时如实报 `pending`，目录存在但无源码报 `blind`。
  - **R2 反向边**：`agent-protocol / agent-core / agent-runtime / data / memory` 五包不得 value-import bot（"runtime 不知道 bot 存在"是 import 语句级语义，直接边扫描）。
  - **R3 客户端轴**：`packages/ui` / `packages/client-core` 不得 value-import `@duya/host` 或 desktop main / preload / renderer（622-05 的 Bot 切片；`packages/cli` 不在本规则内，其本地 Host 启动边归 G11-1 管）。
  - 防假绿：scanned 只计成功读取的文件并设 floor（R2≥100、R3≥100，实测 333 / 652）；Windows 瞬时读失败重试一次，仍失败计入 `unreadable` 上报。首版曾把 walk 计数当 scanned、且绝对路径转换错误导致全树假绿，被 census 全 0 暴露后重写——该教训已写进代码注释。
- `--census`：可复跑的消费者清单探针（下表）。
- 接线：`npm run architecture:bot-boundary`、test.yml architecture job 新 step、`architecture-ci-wiring.test.ts` 断言（防"有门禁没人跑"）。
- 测试 13 例：live 树绿（R1 pending / R2 R3 零发现、unreadable=0）＋三规则变异红→绿（value import 红；demote 成 `import type` 后绿且 typeOnly 计数可见）＋ blind/finding 拒绝判定＋ census 组存在性断言（含"退役层 `packages/agent` 是 host bot prompt 最大消费方"这一承重事实，移动归属时必须同 PR 更新）。

**反向边探针（本次树实测）**：UI / client-core → host / desktop 的 value 与 type 边均为 0；agent-core / runtime / protocol / data / memory → host / desktop 均为 0；host Bot 模块 value 闭包内 host 文件 187 个，全部下向包，不触 desktop / electron 路径。

**消费者清单**（`node scripts/architecture/bot-boundary-gate.mjs --census`；完整数字可复跑）

| 组 | 消费者要点 | 迁移注意 |
| --- | --- | --- |
| host/worker-prompts/bot（24 文件） | 29 个消费者；最大方是退役层 `packages/agent`（25 文件），desktop 仅 3（wake-dispatcher / routine-wake / config/groups） | S5 prompt 快照的现役面；退役层镜像副本是 S2 提包时的主要清退对象 |
| host/worker-prompts/configs/bot、worker-tools/bot-builtin | 各 1–2 个消费者，均含 agent 镜像 | 同上 |
| host/config-agents/bot-*（3 文件） | host 内部 2 处 | S1 Host 单写入口落点 |
| data/pending-wakes + protocol/wake* | data 4 / protocol barrel 1 | S3 inbox 合同的现有底座 |
| desktop/wake/*（19 文件） | 11，全部 desktop 内部 | S3 退役对象；现状 desktop 串联合同的实证 |
| desktop/channels/*（23 文件） | 7 | S4 退役对象 |
| desktop/automation/*（28 文件） | 14 | S6 复用 Scheduler，触发适配 |
| ui/chat/bot*（50 文件） | 2（Composer / GroupRoomChatView） | S4/S7 统一投影 |

**行为基线**（本检出实测全绿；迁移切片以同名测试对照，不以数量对照）

| 域 | 具名测试 | 结果 |
| --- | --- | --- |
| 身份 | `config-agents-write` / `agent-profile-config` / `worker-db-bridge-config-agents` / `bot-toolset` | 4 文件 29 用例 |
| prompt | host `tests/worker-prompts/`（partition / profile-sections / mode-composition / digest） | 4 文件 28 用例 |
| wake | desktop `wake/__tests__/`（dispatcher / preemption / idle / automation / ack-redrive / watchdog 等） | 10 文件 94 用例 |
| 投递 | desktop `channels/__tests__/`（delivery / telegram connector+offset / inbound-filter / secret-store 等） | 9 文件 117 用例 |
| bot 专属桌面面 | ipc `bot-channel-handlers` / config `bot-profile`+`bot-identity-rpc` / cli `bot-channels` / agents router `provider-fallback` | 5 文件 46 用例 |

## S1 执行记录（2026-10-25）

已实现、已验证、未合并。分支 `codex/bot-framework-s1`（base＝master `f24166ec`——S0 已由用户合入 #495，S1 提交 rebase 至其上，PR 目标 master）。

**交付（S1 = Host Bot 接口，1 个窄 PR）**

- `@duya/agent-protocol/bot-api`：Bot 身份的 wire DTO——`BotRecord`（canonical 视图：profile.json 优先、config 兜底、id 最后）、`CreateBotCommand`（带 `requestId` 幂等）、`UpdateBotCommand`（带 `expectedRevision`）、`BotCommandReceipt`（形状兼容 legacy `{id,name}`）、`BotErrorCode` 四值联合。只放身份：调度 / inbox / 投递的 DTO 属于 S3/S4，wire 不承诺未实现的行为。
- `config.toml` schema 增加 `revision` 字段：facade 创建=1、每次 facade 更新 +1；0=前 facade 时代条目。facade 是唯一 revision 权威。
- `host/src/bot/`：`ports.ts`（ConfigStore/Profile 两个端口，Host 文件后端与 Desktop store 后端各一套适配器）、`journal.ts`（`<agentsRoot>/.identity-journal.jsonl` 追加式意图账本：create/update 意图先行，applied 标记收尾，requestId→receipt 去重跨进程存活，损坏尾行计数不炸加载）、`service.ts`（应用服务：create/update/get/list/repair；revision 冲突以 `bot_revision_conflict` 结构化拒绝并携带 stored/expected；update 一个意图覆盖 config + profile 两处身份写入，repair 同步补齐）、`bridge-assembly.ts`（bridge 惰性单例，首分发执行 repair）。
- 接线：`worker-db-bridge` 的 legacy `config:agents:create/update` 改走 service（响应形状不变），新增 `bot:create/update/get/list` 四动作；Desktop `db-bridge` 同构（store 后端适配器 `bot-application.ts`）。Desktop 与 TUI 从此共用同一套 create/update/read 语义。
- 未新增第二调度器：Desktop wake dispatcher 仍是唯一调度 owner（S3 前置合同）。

**测试（22 例新增，全绿）**：service 14（canonical 视图合并、revision 冲突结构化拒绝、requestId 去重同进程+跨进程、崩溃窗口 repair 四态：create 补齐/确认已应用/冲突保留/torn tail 计数、软删过滤、内存端口同用例）+ bridge 8（legacy 形状回归 + bot:* 全契约）。

**过程中的实证教训**（已写进代码）：journal 意图行初版漏写 `v` 字段，被自己的加载守卫判为 corrupt，dedup/repair 全部静默失效——由测试暴露后修复 writer 而非放松 guard。Windows 瞬时文件锁的处理延续 S0 的 readImports 重试约定。

## S2 执行记录（2026-10-26）

已实现、已验证、未合并。分支 `codex/bot-framework-s2`（base＝S1 分支 `codex/bot-framework-s1` @ `9fdf40fe`，栈式 PR）。实现由子 agent 在专用 worktree 执行、协调者独立复核全部门禁。

**交付（S2 = packages/bot 领域包提取，纯移动）**

- `packages/bot`（name `@duya/bot`，managed）：`src/domain/`（BotIdentityEntry 及子形状、BotProfile 纯类型、applyIdentityPatch/buildUpsertedAgent/canonical 合并/bot-id 纯规则、BotServiceError；allocateBotId 的随机后缀改为注入 `randomSuffix`）；`src/journal/`（BotIdentityJournalState 纯状态机 + InMemoryBotIdentityJournal，文件格式与文件名不变）；`src/ports/`（IdentityStorePort/ProfilePort/JournalPort）；`src/application/`（createBotService，repair/revision/requestId 语义一字未改）。
- Host 侧 `host/src/bot/` 变薄为适配器：toml-config-store / fs-profile-store / file-journal + 组装；index.ts re-export S1 全部导出名——`apps/desktop` 零 diff（git diff 为空），`worker-db-bridge.ts` 一行未改。
- 接线：`architecture-policy.yaml` 声明 bot 模块（managed、requires [agent-protocol]、host.requires + bot）；`scripts/build-packages.mjs` BUILD_ORDER 插入 @duya/bot；vitest.config WORKSPACE_SOURCE_ALIASES + bot。三个 baseline JSON 一字未动。
- 测试：S1 的 22 例语义原样保留（host 文件后端 13 + bridge 8 + 内存 1），新增 21 例纯测试（注入式后缀、状态机接缝、100 次耗尽/截断/corrupt/seq 续号/dedup 仅对 applied 生效）。

**门禁翻转**：bot-boundary gate R1 由 PENDING 翻为 **MEASURED，9 个 bot 源文件 0 findings**（import 闭包仅 agent-protocol）——S0 预言的"包出现即受测"成立。R2 OK(336)、R3 OK(654)。

**验证**（协调者独立复核）：build:packages 0（bot 先于 host）；vitest 5 文件 43 例全绿；typecheck:all 0；architecture:check 新增违规 0（3 条既有 fingerprint 失效未 --write）；retirement ratchet 772/772；host 全量 2000 passed / 5 skipped；desktop diff 空；packages/bot/src 零 `node:*` 导入。

**裁量记录**（子 agent 报告，协调者认可）：randomSuffix 为可选注入（bot 内 Math.random 兜底，host 注入 crypto——保 desktop 零 diff）；worktree 内手工补 @duya/bot junction（junction-worktree.mjs 从主检出枚举包，看不见本 worktree 新包）；boundary-gates LAYERS 未动（host 本不在 LAYERS scope，bot 仅 import protocol 无 finding）。

## 关键决策

- 本次 master 从 `2baa95df` fetch 到 `270ba528`，master pull --ff-only 成功；原 `work` 分支保留。最新 tree 与旧会话时间点明显不同，全部迁移定位以最新源码为准。
- 目标一个 `@duya/bot` 领域包；Host 保留 I/O、工具和执行装配，data / memory 保持原所有权。先接缝、再门禁与提包、最后增强。
- Bot lifetime、Session、Run、AgentProfile、Responsibility 分别建模；不新增第二套任务 / Run 状态机。
- 现有 pending_wakes / Host CRUD 不足以证明可靠后台服务；Run dispatchKey 幂等 receipt 是生产切流硬前置。
- 四产品映射与官方链接已由用户确认。Muse 公开了部分安全架构，但四产品都没有提供本次所需的完整崩溃恢复 / 副作用重放合同；不能视为完整开源实现。旧助手正文仍无法读取。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 起始 `2baa95df` | Linux / Git | status、fetch、master pull --ff-only | 0；到 `270ba528`，master 与远端一致 | Git log / origin/master |
| 干净源码 `270ba528`，仅依赖链接 | Linux / Node 24.19.0 | junction-worktree dry-run / setup | 0；独立 workspace overlay | 54 links；不穿链接 install |
| 同上 | 默认 sandbox | architecture:check / typecheck:all | 2 / 1；child process spawn EPERM，尚非代码失败 | 已申请正常子进程权限重跑 |
| `270ba528`，文档新增；无代码修改 | Linux / Node 24.19.0，允许子进程 | `npm run architecture:check` | 0；2841 findings 全为既有 tolerated，新增违规 0 | 未改 baseline；不能据此声称历史债已清 |
| 同上；构建依赖为共享第三方目录 | 同上 | `npm run typecheck:all` 首次有效运行 | 2；capabilities build 的 TS7016：缺少 @types/picomatch | manifest / lock 已声明，当前共享安装未提供；只在独立 work 目录补齐后重试 |
| `270ba528` + 本次 7 文档 | Linux / Node 24.19.0 / TypeScript 5.9.3 | `npm run typecheck:all` 完整重跑 | 0；含全部 workspace 构建与类型 / ratchet / recorder checks | 同一 @types/picomatch 4.0.3 在独立 work deps 安装，仅为 capabilities / host 建本检出私有 overlay；共享依赖未写入。不是 clean install / 跨平台 CI 结论 |
| `270ba528` + 仅本次文档 | Linux / Node 24.19.0 / Vitest 3.2.4 | `node node_modules/vitest/vitest.mjs run packages/agent-core/test/profiles/bot-toolset.test.ts packages/host/tests/config-agents-write.test.ts packages/host/tests/agent-profile-config.test.ts` | 0；3 文件 / 25 用例通过 | 真实已有测试；复用当前安装，非 clean npm ci / CI 证明 |
| 同上 | 同上，Electron binary 缺失 | 先前 4 文件运行另含 Desktop wake-dispatcher、channel-ack-redrive 两 suite | 1；Host 14 用例通过，2 wake suite 在加载期失败：Electron failed to install correctly / fetch failed | 没有执行到 wake 断言；不下载或删除共享 Electron 安装，不将其写成回归通过 |
| 同上 | Python 3 / Git | 7 文档 UTF-8、相对链接、tracked/planned visibility 对照 base | 新断链 0；138 条本地链接中 1 条 base 已失效 | 原有 README→2026-10-24-dynamic-workflow-package.md 不在 base tree，本次未修改 |
| 同上 | Git | `git diff --check` / 三个新增文件 check-ignore | 0 / 未被忽略 | 本次只暂存 7 个具名文档 |
| `1618a909` + S0 三件套与接线 | win32 / Node 24.16.0 / Vitest 3.2.4 | `npx vitest run scripts/architecture/ --no-file-parallelism` | 0；19 文件 335 用例全绿（含本次新增 13 例与 wiring 断言） | 1 个 vitest worker RPC 超时噪音未影响结果；本机内存压力需单文件串行 |
| 同上 | 同上 | `npm run architecture:check` | 0；无新增违规 | 2 条既有 baseline fingerprint 失效为既有债务，未顺手 `--write` |
| 同上 | 同上 | `node scripts/architecture/bot-boundary-gate.mjs` 与 `--census` | 0；R1 pending / R2 OK(333) / R3 OK(652)，PASS | 消费者清单见 S0 执行记录 |
| 同上 | 同上 | 行为基线五组（见 S0 执行记录表） | 0；全绿 | 首次 identity 运行 1 文件加载失败，归因 C 盘 0 可用（工具 stdout 落 C:%TEMP%），清理后重跑全绿；本机 Electron 可加载，#483 记录的 Linux wake 加载失败未复现 |
| 同上 | 同上 | `npm run typecheck:all` | 0；含全部 workspace 构建与类型 / ratchet / recorder checks | 本检出 junction 依赖直接通过（@types/picomatch 已在树内），无需 #483 时代的私有 overlay |
| 同上 | Git | 暂存具名文件（gate 三件套、package.json、test.yml、wiring 测试、本计划、README 行） | — | 不入 Git：junction 链接、/e/tmp 日志 |
| `24590d10` 首推 | ubuntu 22.x CI | architecture job | 1；agent-retirement reference ratchet FAIL：773/772，测试断言字符串字面量新增 1 条退役层引用（`bot-boundary-gate.test.ts:333`） | ratchet 只减不增，禁 bump baseline；修法=断言去退役路径字面量，改钉结构性事实（成员/消费方数下限+desktop 接线），退役层身份由 census 输出与计划文档承载 |
| `c8946122`（ratchet 修复后 head） | win32 本地 | `node scripts/architecture/agent-retirement-gate.mjs`（pipefail 取真实退出码） | 0；ratchet PASS 772/772 / 0 new | 本地与门禁+retirement 测试 24 例全绿 |
| `c8946122` | ubuntu 22.x CI（PR #495） | architecture / build / typecheck / test / test scope 五检查 | 全 pass；test 8m33s 含新测试文件在 Linux 首跑 | CI 结论覆盖本机验证；PR 待 review 与集成授权 |
| S1 全量（host src/bot + protocol bot-api + 两 bridge + schema revision） | win32 / Node 24.16.0 / Vitest 3.2.4 | `npx vitest run packages/host/tests/ --no-file-parallelism` | 0；1984 passed / 5 skipped（含 S1 新增 22 例与既有 identity/prompt 基线） | host 全域回归 |
| 同上 | 同上 | `npm run build:packages` / `npm run typecheck:all` | 0 / 0 | workspace 全构建与类型门禁 |
| 同上 | 同上 | apps/desktop tsconfig.main tsc --noEmit | 206 errors＝base 基线逐条持平，本次 0 新增 | desktop main 预存错误按文件归因（base 对照） |
| 同上 | 同上 | `npm run architecture:check` / bot-boundary gate / agent-retirement ratchet | 0 / PASS（R3 652） / PASS 772/772 | 三门禁全绿；2 条既有 fingerprint 失效未顺手 shrink |

## 接续 / 结果

实施期的状态、已定合同与剩余切片的开工指引另见[交接报告](2026-10-26-personal-bot-framework-handoff.md)。

已完成源码调查、设计与文档验证，生产实现未开始。设计交付 commit：`eaf9d86d`；后续仅补本节的 PR 接续记录。只提交 7 个具名文档；依赖 symlink、私有 work deps / 日志不入 Git，构建未产生需提交的源码差异。外部副作用：任务分支已推送并创建 draft PR；未改用户 DB、未合并或发布产品。

PR：[draft #483](https://github.com/lava-chen/duya/pull/483)，待 review / CI；没有申请或执行合并。当前工具无法读取原 ChatGPT 完整线程；必要时由后续对话补全文，不阻塞有源码支撑的方案。
回收：保留 worktree 与分支，等待设计 review / PR 集成，不执行删除。

**S0 切片接续（2026-10-25 第二会话）**：`bot-boundary-gate` 三件套＋CI 接线＋census＋四域行为基线已在本节上方「S0 执行记录」落地并全量验证；PR：[#495](https://github.com/lava-chen/duya/pull/495)（base＝`1618a909`，目标 master；diff 含 #483 的 7 个文档祖先提交，review 面只有 S0 commit `24590d10`）。S0 的验收——Bot→Host / UI→Host 反向边变异红→绿、具名行为基线——已满足：门禁 13 例（3 规则变异＋live 树绿＋census）＋ 既有行为测试五组全绿。外部副作用：仅远端分支与 PR，未合并；worktree 保留待 review。**下一步**：S1 Host Bot 接口（`host/src/bot` facade / ports、protocol 最小 DTO、profile 写入接缝，旧 Desktop 调度作过渡 adapter）；进入前先核对 #483 与本 PR 的 review 状态，S1 的 facade 在 S3 durable 受理落地前只能委托旧调度器。

**S1 切片接续（2026-10-25 第三会话）**：Host Bot 接口已落地（见「S1 执行记录」），分支 `codex/bot-framework-s1`（base＝master `f24166ec`，S0 已合并后 rebase）。S1 验收——Desktop/TUI 同一 Bot 语义、revision 冲突结构化拒绝、requestId 跨进程去重、身份 journal 崩溃修复——已由 22 例具名测试满足；两 bridge legacy 形状回归全绿。**下一步**：S2 提取 `packages/bot` 领域包（domain/application/ports 下沉、host adapter、workspace/build/gates 接线、bot-boundary gate R1 由 pending 翻为 measured），前置＝S1 PR 集成或与 S0 同栈评审。

**S2 切片接续（2026-10-26 第四会话）**：packages/bot 提取已落地（见「S2 执行记录」），R1 门禁已翻 MEASURED。**下一步**：S3 持久唤醒与 resident——S3a 存储合同（bot_inbox + bot_dispatch_receipts + reserve/confirm receipt 操作）已派发；S3b 为 openRun 加 dispatchKey 幂等受理接缝（receipt 预留 runId，复用 Control Plane 的 reused 拒绝重派语义）+ Bot dispatcher + resident lease；S3c Desktop bot handler 转发切流。
