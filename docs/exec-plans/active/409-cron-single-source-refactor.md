# Cron 单一来源重构（Plan 409）实施记录

> **Goal:** 把 cron 从多轮补丁堆出的复杂架构（config.toml `cron.jobs` + `automation_cron_state` + `automation_cron_runs` 三处存储、双状态源合并、setTimeout 链 + 伪队列、`runInSession` 复制整条 agent 启动链路、`mode='automation'` 特殊身份）收敛为**单一 `~/.duya/cronjob.toml` + 普通 agent 会话执行**。

## 核心洞察（用户拍板）

**cron 本质 = "系统到点向一个普通 agent session 主动发一条 prompt"。** 因此：

1. **单一来源**：独立 `~/.duya/cronjob.toml`（定义 + 运行时状态 `last_run_at/last_error/retry_count` 写回），不嵌 config.toml。
2. **走主 agent HTTP 通道**：执行 = 创建普通 session（`mode='chat'` + `extensions.source='cron'`）→ `POST /sessions/:id/chat`（renderer 聊天与 gateway 同一条路）。删除 `runInSession` 的进程池复制。
3. **cron session 完全普通化**：历史 = session 自己的 rollout；删除 `automation_cron_runs`/`automation_cron_state` 表；删除 4 处 `mode='automation'` 过滤（db-handlers / db-bridge / session-store ×2 / eligibility）。
4. **保留 headless deny 集**（`cron` agent profile：AskUserQuestion/show_widget/Agent/canvas:*/mode-switch + `disableSections:['rules']`）作为通用安全网——无人在场的交互工具会挂起，deny 是唯一抑制机制。
5. **60s 轮询 tick** 替代 setTimeout 链：每次重读 cronjob.toml，由 `(schedule, lastRunAt, now)` 计算 nextRunAt，到期执行。崩溃恢复天然。
6. **合并已修 bug**：`'default'` 模型占位符 → provider 默认（provider.ts `resolveCronProvider`）、provider fallback（getDefault ?? first）、MiniMax-M3 adaptive thinking 挂死（`effort:'off'` + `llmRequestTimeoutMs`）、异步 runCronNow（eager 返回 `CronRunHandle`）。

## 数据模型 —— `~/.duya/cronjob.toml`

```toml
version = 1

[[jobs]]
id = "..."                # 可选，缺省生成
name = "daily report"
prompt = "summarize yesterday"
enabled = true
schedule = { kind = "every", every = "1d" }
# kind "once":  { kind = "once", at = "2026-12-31T23:59:00Z" }
# kind "cron":  { kind = "cron", expr = "0 9 * * *", tz = "Asia/Shanghai" }
working_directory = "~/.duya/workspace"
model = "minimax-cn:MiniMax-M3"   # 可选 → provider 默认
concurrency = "skip"              # skip | parallel | replace（删伪 queue）
max_retries = 3
last_run_at = 0                   # 运行时状态写回
last_error = null
retry_count = 0
```

`next_run_at` 不持久化 —— 每次 tick 由 `computeNextRunAt(schedule, lastRunAt, now)` 计算。

## 文件结构

```
electron/automation/
├── cron-file.ts      # CronFileStore：cronjob.toml 读写（@iarna/toml + write-file-atomic 0o600 + 校验）
├── schedule.ts       # 纯函数：parseEveryDuration/formatEveryDuration/assertValidSchedule/computeNextRunAt（croner）
├── provider.ts       # resolveCronProvider()：'default'→provider 默认 + getDefault ?? first + 硬编码 fallback
├── agent-run.ts      # createCronSessionRow（幂等）/ runPromptInSession（HTTP+SSE）/ runCronInSession / interruptCronSession
├── Scheduler.ts      # 60s tick + running 集合 + 并发 skip/parallel/replace + 重试 backoff（重写）
├── types.ts          # 简化类型：嵌套 CronSchedule union、AutomationCron(camelCase)、CronRunHandle、CronSessionSummary
├── workspace.ts      # 保留
└── template-loader.ts# 保留（defaultSchedule 兼容新旧字段）
```

删除：`cron-store.ts`、`automation_cron_state`/`automation_cron_runs` 表（migration 50 drop）、死字段（`session_target`/`delivery_mode`/`workflow_id`/`input_params`/`tags`/`description`）、`queue` 并发策略、`CronRunStatus`。

## 迁移

- `migrate.ts` `migrateCronJobsToFile(db, {configPath, cronFilePath})`：合并 legacy `automation_crons` 表 + config.toml `cron.jobs`（plan 405 interim）→ cronjob.toml（扁平 schedule → 嵌套），幂等，写后从 config.toml 移除 `cron.jobs`。main.ts 在 `migrateConfig` 后调用。
- `schema.ts`：fresh schema 移除 `automation_cron_runs` CREATE + index；新增 **migration 50 `drop_automation_cron_tables`**（DROP IF EXISTS 两表）。
- 历史数据不迁移：每次 cron run 本来就创建了 session（带 `session_id`），历史已存在于 session 的 rollout。

## 决策（已锁定）

- 定义 + 运行时状态 = cronjob.toml 单文件；`next_run_at` 派生不落盘；历史 = session rollout（append-only 台账，不入 TOML）。
- cron session：`mode='chat'`、`extensions.source='cron'` + `cron_job_id`、id 前缀 `cron:<jobId>:<ts>:<runId>`（历史查询 `sessions.listByPrefix('cron:<jobId>:')`）。
- 交互工具抑制保留 cron profile deny 集（工程必需，非 cron 身份）。
- CLI wire DTO（冻结）保持：`crons.ts` 加薄 mapper（once→'at'、everyMs→every、status→enabled），独立 CLI 零改动。

## 验证

1. `npm run typecheck:web` / `typecheck:agent` / `typecheck:cli` / `typecheck:conductor` 全过；`npx tsc --noEmit -p electron/tsconfig.json`（我引入的错误已清零，剩余为 electron 既有积压错误，非本次范围）。
2. 52 个非 DB 测试通过：`electron/automation/*`（schedule/cron-file/Scheduler/workspace）、`electron/cli/handlers/crons.test`、`electron/config/__tests__/migrate.test`、`src/components/automation/cron-schedule.test`、`packages/agent/tests/unit/automationScheduler.test`。
3. **环境阻塞**：`session-store`/`eligibility`/`db-handlers` 等 DB 测试因 better-sqlite3 ABI 不匹配无法运行（Electron dev 进程锁着 `better_sqlite3.node`，`npm run rebuild:node` EBUSY）。需在无 Electron 进程占用时 `npm run rebuild:node` 后跑全量 `npm run test` 验证。

## Lessons

- 前端 `src/types/automation.ts` 是后端 `electron/automation/types.ts` 的镜像副本，需锁步修改。
- 定时 run 与手动 run（runCronNow）共用 `executeCron(job, manual, existing)`：`existing` 携带 eager 创建的 `{runId, sessionId}`，手动 run 绕过并发策略。
- 到期 run 的 "claim"（先 `markRunResult(lastRunAt=now)` 再执行）保证 at-least-once：崩溃后不无限补跑。
- `SessionStore.listByPrefix` 内部 escapeLike(前缀)+追加 `%`，调用方传字面前缀（`cron:<jobId>:`）。
- Electron 侧代码不在 `typecheck:all` 内（根 tsconfig 排除 `electron/**`）—— 需单独 `npx tsc -p electron/tsconfig.json`，且该目录有大量既有错误积压。
