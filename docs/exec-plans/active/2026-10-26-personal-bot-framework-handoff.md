# Bot 框架 S0–S7 交接报告（2026-10-26）

本文是 [个人长期 Bot 框架](2026-10-25-personal-bot-framework.md) 实施期的交接材料：写到哪、哪些已合并/待合并、每片验证到什么程度、剩下的切片怎么开工、以及不该重犯的坑。计划本体维护目标、边界与切片表；本文只讲交接。

## 一句话状态

S0 已合并进 master；S1、S2、S3a 三个切片已实现并开了 PR，处在 CI/review 阶段；S3b–S7 未开工，S3b 的契约已调研完毕可直接开工。生产调度路径未改，Desktop wake dispatcher 仍是唯一调度 owner。

## 切片状态表

| 切片 | 内容 | 状态 | PR / 分支 | 验证到什么程度 |
| --- | --- | --- | --- | --- |
| S0 | 边界与行为基线：`bot-boundary-gate`（R1/R2/R3）、`--census` 消费者清单、CI 接线、四个行为域具名基线 | **已合并** | #495 → master `f24166ec` | CI 五检查全绿；census 记录退役层是 host bot prompt 最大消费方 |
| S1 | Host Bot 身份 facade：protocol DTO、revision 语义、身份 journal、应用服务、两 bridge 接线 | 已实现，待 review/CI | #500，`codex/bot-framework-s1`（base=master `f24166ec`） | host 全量 2000 passed、typecheck:all 0、desktop tsc 与 base 持平、门禁全绿 |
| S2 | 提取 `packages/bot` 纯领域包，Host 变适配器 | 已实现，待 review/CI | #502，`codex/bot-framework-s2`（base=master，diff 含 S1，**合并顺序 #500 → #502**） | 43 例绿、typecheck:all 0、R1 门禁由 PENDING 翻 **MEASURED**、desktop 零 diff |
| S3a | Bot inbox 与 dispatch receipt 存储合同（`bot_inbox` + `bot_dispatch_receipts` 两表） | 已实现，待 review/CI | #503，`codex/bot-framework-s3a`（base=master） | data+protocol 568 例绿、typecheck:all 0、architecture 无新增违规 |
| S3b | `openRun` dispatchKey 幂等受理 + Bot dispatcher + resident | **未开工**（契约已就绪，见下） | — | — |
| S3c | Desktop bot handler 转发切流 | 未开工 | — | — |
| S4 | 投递与渠道：outbox + Telegram + Feishu | 未开工 | — | — |
| S5 | 记忆与 prompt 快照 | 未开工 | — | — |
| S6 | 责任与自主性策略 | 未开工 | — | — |
| S7 | 旧路径退役 | 未开工 | — | — |

## 已实现的关键合同（接手方不要重新发明）

**身份 revision**：`config.toml` 的 `[agents.<id>]` 增加 `revision`。facade 创建=1，每次 facade 更新 +1，0 = 前 facade 时代的条目。facade 是唯一 revision 权威，legacy writer 不动它。冲突以 `bot_revision_conflict` 结构化拒绝，`details` 带 `storedRevision` / `expectedRevision`。

**身份 journal**：`<agentsRoot>/.identity-journal.jsonl`，追加式。create/update 意图先写、applied 标记后写；`requestId → receipt` 去重跨进程存活；尾部撕裂行计为 `corruptLines` 不炸加载。`repair()` 在服务打开时把 pending 意图补齐：create 补写、已应用则确认、id 被别的条目占用则保留并报告（绝不覆盖）。**写者必须带 `v` 字段**——初版漏写导致自家守卫把行判为 corrupt，dedup 与 repair 双双静默失效，修复方向是补 writer 而不是放松守卫。

**一个 update 意图覆盖两处身份写入**：config entry 与 runtime `profile.json` 必须一起改，canonical 视图（profile 优先、config 兜底、id 最后）不能出现分裂状态。repair 同样补齐 profile。

**Bot inbox 状态机**：`pending → claimed → dispatched → settled`（旁路 `dead_letter`）。`dedup_key` = owner␀bot␀source␀binding␀sourceEventId，列级 UNIQUE。`lease_epoch` 单调递增作 fence。`reserve(dispatchKey, candidateRunId)` 预绑 run id，重放时**丢弃候选 run id**，调用方必须用返回值——S3b 的幂等受理建在这上面。

## S3b 开工指引（契约已调研，直接可用）

1. **幂等受理接缝**：`packages/host/src/run-orchestrator.ts` 的 `openRun`（约 638 行）目前每次 `randomUUID()`，没有 dispatchKey 受理语义——设计文档 §6 不变量 4 点名它是生产切流的硬前置。做法：调用前 `reserve(dispatchKey, candidateRunId)`，命中既有 receipt 就直接用其 runId 且**不派发**（Control Plane 已有 `reused` 拒绝重派语义可复用，见 `run-receipt.ts` 的 applied/reconciled/conflict 三态）。
2. **Bot dispatcher**：消费 `bot_inbox`，用 S3a 的 `claim` 抢占、派发后 `recordDispatch`，Run 终态后 `settle`。租约到期只做机械回队（`requeueExpired`），"租约到期不证明可重跑"的判断留给 reconciler。
3. **resident**：`packages/host/src/client-lease.ts` 现在是纯存在信号，最后一个客户端离开即 idle 停机。Bot 在途工作需要顶住停机；参考 `scripts/` 侧既有 drain 约定（idle 停机 drain 120s 的先例在 TUI lease GC 那条线）。
4. **顺序**：先存储合同（已交付）→ 再 Host 接线 → 最后切流，S3b 与 S3c 分两个 PR。

## 别重犯的坑

- **bundle 必须随源码重建**：worker bundle 是被 track 的产物。S1 改了 host 源码没重建 bundle，CI 的 `bundle-verify` 直接 STALE 失败。改 host 源码后跑 `npm run build:packages -- --target @duya/host` + `npm run bundle:worker` 并提交 `packages/host/bundle`。
- **retirement ratchet 只减不增**：`agent-retirement-gate` 的引用计数不能新增，基线不可 bump。测试里**不要硬编码退役包路径字符串**（如 `packages/agent/`）——它会被计为新引用。改钉结构性事实（成员数/消费方数下限），退役层身份写在 census 输出与计划文档里。S0 修过一次，PR #495 的 CI 首推就是这样红的。
- **shell cwd 会被重置**：本机多次出现命令跑在主检出而不是 worktree 的情况。每次 git 命令前先 `git branch --show-current` 确认所在检出。
- **C 盘满会让 Bash 全挂**：工具 stdout 落在 `C:%TEMP%`。重活先 `export TEMP=E:/tmp TMP=E:/tmp`；C 盘 0 可用时清 `%TEMP%` 里 6 小时前的条目。
- **Windows 瞬时文件锁**：`readFileSync` 偶发 UNKNOWN 错误。门禁扫描器重试一次，仍失败计入 `unreadable` 上报——不许静默跳过（那正是假绿的来源）。
- **路径拼接**：Mimosa 钩子会拦 `path.join(ROOT, 动态片段)` 的写入。测试里的临时路径要显式校验不越出根目录。
- **新 workspace 包要补两处，否则 CI 必红**：①根 `package-lock.json`（`npm install --package-lock-only`，否则 `npm ci` 报 "Missing: @duya/x from lock file"）；②**消费方 package.json 的 dependencies 声明**（本地能过是因为 worktree 里手工补了 junction，CI 的 `npm ci` 不会建那个链接，症状是 `Cannot find module '@duya/x'`）。
- **CI 只对 `pull_request: branches: [master]` 触发**：栈式 PR（base 指向另一个特性分支）不跑 CI，会给人"全绿"的错觉。要 CI 信号就把 base 改成 master，并在 PR 正文写明合并顺序；改 base 本身不触发 workflow，需要再推一次（空提交亦可）。
- **master 自身可能 bundle STALE**：别的 PR 合入后没重建被 track 的 worker bundle，后续所有基于 master 的 PR 都会在 `bundle-verify` 上红。修法是本 PR 内重建并提交 `packages/host/bundle`（`npm run build:packages -- --target @duya/host` + `npm run bundle:worker`）。

## 协作方式（本轮已验证可行）

主会话做协调：定契约、建 worktree、验收门禁、提交与开 PR。实现派 general-purpose subagent，各占独立 worktree：

- `.claude/worktrees/bot-framework-s0`（分支 `codex/bot-framework-s1`，当前活跃）
- `.claude/worktrees/bot-framework-s2`（分支 `codex/bot-framework-s2`）
- `.claude/worktrees/bot-framework-s3a`（分支 `codex/bot-framework-s3a`）

subagent 报告必须**独立复核**再采信：本次 S2 子 agent 报告全绿，协调者重跑门禁（bot-boundary R1 MEASURED、retirement 772/772、`git diff apps/desktop` 为空、43 例绿）后确认无虚报。S3a 子 agent 曾用 Bash `sed` 改源码（违反 Write/Edit 规则）并自报，最终文件已自检干净——派工时要重申写文件只用 Write/Edit。

## 接手的第一步

1. 看 #500 / #502 / #503 的 review 与 CI；用户已授权合并后再集成（合并顺序：#500 → #502 → #503，它们是栈式依赖）。
2. 集成后从 S3b 开始：先 `openRun` 的 dispatchKey 接缝（先写具名故障测试：在 receipt 落定后响应丢失，重试不得开第二个 Run），再 Bot dispatcher，最后 resident。
3. 每个切片仍按计划的门禁走：Bot→Host / UI→Host 反向边、revision 冲突、具名行为夹具、真实 fixture 冒烟。

## 相关文件

- 计划本体（含 S0/S1/S2 执行记录与验证表）：[2026-10-25-personal-bot-framework.md](2026-10-25-personal-bot-framework.md)
- 设计合同：[personal-bot-framework.md](../../design-docs/personal-bot-framework.md)
- 产品对照依据：[personal-agent-products.md](../../references/personal-agent-products.md)
- 边界门禁实现：`scripts/architecture/bot-boundary-gate.mjs`；测试 `bot-boundary-gate.test.ts`
- S1 服务与 journal：`packages/host/src/bot/`、`packages/bot/src/`
- S3a 存储：`packages/data/src/bot-inbox.ts`、`packages/agent-protocol/src/bot-inbox-api.ts`
