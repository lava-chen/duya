# 01 — 迁移地图:从哪迁、迁到哪、什么时候算完

> 每行是**文件级**迁移源。状态为实测(2026-10-04,`master` 工作树),不是计划声称。
> 原则:**不为了树形对称搬文件。** 分类按代码**做的事**分,不按它当前在哪个包。

---

## S0 — 边界门禁(唯一 Ready 阶段)

**不搬任何生产代码。** 只写门禁并做变异证明。

为什么先做这个:587 M5 的所有切片门禁都是绿的,但 #175 自己写"The headline moves are not done"。**门禁不检查真实边界,后面每个切片都建立在一句承诺上。**

### S0.1 门禁(已实现,commit `60899d49` / `2f5992e0` / `ef36afc1` / `00372fe2`)

运行方式:`npm run architecture:boundaries`(纯 node,无新依赖)。

| 门禁 | 实现 | 当前结果 |
| --- | --- | --- |
| **G1** 分层依赖方向,按导出路径 | `findReverseEdges` | PASS |
| **G2** core 零 IO | 已有 `layer-purity.ts` | 6 carve-out 债 |
| **G3** runtime 无 host | `findRuntimeHostLeaks` | PASS |
| **G4** worker 侧 ExecutionChannel | `findWorkerSeamBypasses` | **3 findings** |
| **G6** Session 非 durable 根 | `findSessionRootedTables` | **6 findings**(3 活 / 3 死) |

**已知红 baseline 策略:** 门禁只对 **baseline 之外**的 finding 退出 1。fingerprint 形状 `gate|file|line|identity`,与既有 `.architecture-baseline.json` 一致。位置参与 key,所以 `session_id` 挪位置 = 新 finding;baseline 条目不再产生时报告为 `FIXED`,须**显式** prune 而不是顺手重录。

```bash
npm run architecture:boundaries              # 检查,新增 finding 则 exit 1
npm run architecture:boundaries -- --write   # 重录 baseline,必须 review diff
```

**重录后必须审查 diff:** 条目变少 = 真修复;条目不变 = 什么都没动。

### S0.2 G4 的具体证据

```ts
// packages/agent/src/process/agent-process-entry.ts:75
import { duyaAgent } from '../agent/DuyaAgent.js';
// :1923
agent = new duyaAgent({ ... });
```

该文件**全文无** `ExecutionChannel` / `ExecutionSink` / `RunController` 引用。Runtime 在 Desktop 侧包住了旧循环(`run-orchestrator.ts:1353` `createWorkerExecutionChannel` 发 `chat:start`),但 **worker 侧没有实现那条 seam**。

唯一的 `HeadlessRunHost`(`packages/agent/src/process/headless-run-host.ts`)用了真实 `RunController`,但**唯一生产调用方是 CLI**(`cli/index.ts:479/612/824`),Desktop 只在注释里提到它。

### S0.2.1 `tasks` 表有两份定义,只有一份是活的(2026-10-04 实测)

| 定义 | 库 | 状态 | 证据 |
| --- | --- | --- | --- |
| `db/core/stores.ts:103` | `duya-core.db` | **LIVE** | 20+ prepared statement;`db-bridge.ts:1432` 的 `task:create` 走 `getCoreStores().tasks.create(...)` |
| `db/schema.ts:163/402/415` | `duya-main.db` | **DEAD** | `initializeSchema` 每次启动都建(`connection.ts:160/221`),但**零读写**。587 §08 已判 DEAD |

**S1 迁移必须改 live 的那份。** 门禁的 finding 带 `database` 与 `live` 字段区分,`databaseOfFile()` 按文件路径判定而非按表名 —— 按表名会把死的那份标成 core.db(这个 bug 被新测试抓到并修掉了)。

### S0.3 G1 当前的反向边

| 反向边 | 数量 | 说明 |
| --- | --- | --- |
| `pkg:agent → electron-main` | 0 | M5.2 已归零 |
| `electron-main → src-renderer` | 32 | S2 收敛 |
| `src-renderer → electron-main` | 2 | S2 收敛 |
| `pkg:agent → @duya/agent-runtime` | 5 文件 | **合法**(runtime → agent 方向待 S3 建立) |
| `@duya/agent/tool/allowedRoots` | 2 | 后门,见 §S2.4 |
| `pkg:agent → @duya/cli/contract` | 4 | **合法,已从误报中移除** — 见下 |

### S0.3.1 `@duya/cli` 归属裁决(2026-10-04)

`@duya/cli` **留在 `packages/`**,但按两个面拆。依据:

- **有包外消费者** → 属于 package。实测 `@duya/cli` 的**全部** 4 处外部引用都在 `packages/agent/src/tool/DuyaCliTool/`,全走 `/contract` 子路径。`apps/desktop` 一次都没引它。
- **有真实 IO** → 不能整体算 runtime。`api/client.ts:64/83/172/213/304` 走 `http://127.0.0.1:{port}` + `fetch`;`commands/{agent,cron,session,projects-cleanup}.ts` 直接 `import ... from 'node:fs'`。

| 面 | 内容 | 归属层 |
| --- | --- | --- |
| contract | `program/`(descriptors、registry、`buildAgentRunner`)、`contract/index.ts`、`api/format.ts` | **runtime 可依赖** |
| app | `api/client.ts`、`commands/*`、`index.ts`(commander) | **host** |

`contract/index.ts:24-27` 已经写死了边界规则:*MUST NOT import any agent runtime*。这条规则是那条依赖合法的根据,不是容忍。

**G1 相应改为按导出路径分层**(`SUBPATH_LAYERS`,commit `2f5992e0`):`@duya/cli/contract` → runtime,`@duya/cli` → host。修完后 G1 从 4 findings 变 0。

**若哪天 `duya` CLI 只剩 app 面、没有包消费者,它才该降进 `apps/`。**

### S0.4 变异证明清单(合入前逐条执行)

每条门禁写完后:

1. 制造它要防的回归 → 确认**红**
2. 完全回退 → 确认**绿**
3. `git status` 干净

**拒绝平凡恒等式**:断言里出现 `a === a` 形状的比较就是红旗。比较的两个量必须来自**不同来源**(声明 vs 实测、预期 vs 真实输出)。

---

## S1 — Session 身份解耦(2026-10-04 降级:不再是 S3 的前置)

> **原计划把 S1 列为最高优先、且让 S3 依赖完整 S1。这个排序错了,已改。**
> Session 身份迁移会拖整个执行改造进入大范围数据迁移,而它**不是执行改造的前提**。

### 1.0 关键纠正:`session_id NOT NULL` ≠ Session 是根身份

原文的推理链是"三个 durable 表都以 `session_id` 为外键 → Session 是身份根 → 必须先解耦"。**中间那一步不成立。**

实测(run-store.ts:172 起):

- `runs.id` 已经是 `TEXT PRIMARY KEY`
- 事件已有 `(run_id, seq)` 主键
- **问题不在"有没有关联列",而在创建、查询、清理和恢复行为是否依赖 Session**

`session_id NOT NULL` 是一个**约束**,不是**身份声明**。`workspace-store.ts:31-35` 记过一次教训:那条注释说明 binding 必须比 session 行活得久,否则会静默 mint 不同的 Workspace —— 同样的风险,不同的表现。

### 1.1 最小解耦先行(新 S1a,先做)

不碰 schema,只改边界:

- runtime 以 `runId` 接收命令、产生事件
- host adapter **暂时保留** `sessionId → runId` 的路由映射
- 历史、附件、执行上下文通过**明确的输入或端口**提供

**这一步就能解除 S3 对 S1 的依赖**,且可回退。

### 1.2 补持久 Conversation/Transcript 身份(新 S1b)

如果坚持 Session 全部降为投影,**必须先回答替代实体是谁**:

| 问题 | 当前状态 |
| --- | --- |
| 多轮历史由谁持有? | 未定义 |
| fork 从哪来? | 未定义 |
| compaction 的来源上下文指向什么? | 未定义 |
| 恢复时从哪里重建? | 未定义 |

**原计划对这个替代实体定义不足。** 这是 S1b 的核心工作,不是实现细节。

### 1.3 原迁移步骤的四个具体缺陷

| 缺陷 | 说明 |
| --- | --- |
| `tasks.run_id` 表达力不足 | **一个 Task 可以产生多次 Run**,单列装不下。需要 `runs.task_id` 而不是反向 |
| 不能统一设 NOT NULL | **普通聊天不一定拥有 Goal/Task**,新列必须 nullable |
| "纯加列"说法不成立 | 改 nullable、改表名**不属于** expand/contract 的 expand 阶段 |
| 缺三样东西 | 历史数据回填、过渡读路径、关联校验 + 旧版本兼容方案 |

### 1.4 当前 schema(实测)

```sql
-- apps/desktop/src/main/db/core/run-store.ts:171
CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ...);

-- apps/desktop/src/main/db/core/stores.ts:103
CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ...);

-- apps/desktop/src/main/db/core/stores.ts:632
CREATE TABLE session_goals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ...,
  UNIQUE(session_id)          -- ← 表名和唯一键都锁死在 session
);
```

`sessions` 表本身(`session-store.ts:171`)带 `working_directory` / `project_name` / `parent_session_id` / `agent_type` / `rollout_path` —— **它是执行身份和展示身份混在一起**。

### 1.2 影响面

`packages/agent/src` 中 `sessionId` 出现 **1549 次 / 145 个文件**。`agent-process-entry.ts` 单文件 197 次。

### 1.3 迁移顺序(expand / contract)

**Phase 1 — expand**(纯加列,可回退)

- `runs` 加 `root_task_id` / `root_goal_id`;保留 `session_id` 但**改为可空**
- `tasks` 加 `run_id`;`session_goals` 改名 `goals` 并加 `project_id`
- 双写:所有写入同时填新旧两套
- 读路径仍走旧列,**不改行为**

**Phase 2 — 验证**(门禁 G6 变绿的前置)

- 统计新旧列不一致的行数,必须为 0
- 真实 round-trip:创建 Run → 关闭 Session → 重开 → Run 仍可读
- 备份 + 回退脚本就绪

**Phase 3 — contract**(不可回退,需单独决策)

- 新列 NOT NULL,旧列删除
- 读路径切到新列
- **前置:Phase 2 的不一致计数为 0 且有备份**

### 1.4 回退点

Phase 1/2 可 `git revert`(**数据是 additive 的,回退代码不影响已写数据**)。
Phase 3 之后 `git revert` **不撤销数据变更** —— 这是 587 §G 反复强调的纪律,必须单独评审。

### 1.5 未决问题(实施前必须回答)

1. Session 关闭时正在跑的 Run 怎么办?(本方案的答案:Run 不受影响,它已经不属于 Session)
2. `session_goals.UNIQUE(session_id)` 去掉后,一个 Session 能否有多个 Goal?**能** —— Goal 以 `project_id` 为根。
3. `sessions.working_directory` 归谁?**归 Workspace**。Session 不再持有执行上下文。

---

## S2 — Control Plane 建域

### 2.1 目标 11 域 vs 当前

| 目标域 | 当前位置 | 状态 |
| --- | --- | --- |
| `projects/` | `main/db/core/project-store.ts` | 需迁入 CP |
| `workspace/` | `main/db/core/workspace-store.ts` | **已就位**(C6.2),位置正确 |
| `goals/` | `session_goals` 表 + `agent/src/modes/goal/` | **两个 owner,需收归** |
| `tasks/` | `stores.ts` TaskStore + `agent/src/session/task-store.ts` | **两个 owner,需收归** |
| `runs/` | `control-plane/run-control-plane.ts` 等 | 部分覆盖 |
| `scheduler/` | — | **无** |
| `wake/` | `agent/src/wake/` | 需迁入 |
| `steering/` | — | **无** |
| `approvals/` | `control-plane/permission-coordinator.ts` | 部分,**生产构造调用为 0** |
| `checkpoints/` | — | **无**(checkpoint 在 runtime 侧) |
| `storage/` | `main/db/` | 归 `packages/data` |

### 2.2 现有 control-plane 文件归位

```
control-plane-service.ts      → 组合根,保留
run-control-plane.ts          → runs/
run-receipt.ts                → runs/
manifest-factory.ts           → runs/(RunManifest 生成)
permission-coordinator.ts     → approvals/
permission-decision-record.ts → approvals/
permission-vocabulary.ts      → approvals/
command-receipt.ts            → runs/
repository-port.ts            → storage/(interface)
sqlite-repository.ts          → 归 packages/data
spawned-workers.ts            → approvals/ 或 runs/
```

### 2.3 两个 owner 的裁决(引用 587 §08 裁决)

`tasks` 有**三个不同 subject**,不是重复:

| subject | 实现 | substrate | 归属 |
| --- | --- | --- | --- |
| A. TODO 清单 | `stores.ts` TaskStore | SQLite core.db | CP `tasks/` |
| B. 后台 subagent 注册表 | `BackgroundAgentLifecycle` | 内存 Map | Runtime |
| C. 后台 bash 命令 | `bash-task-store.ts` | JSON | Runtime |

**三者不合并**,但 A 归 CP、B/C 归 Runtime,并在类型上明确区分(587 §08 建议的 discriminated subject)。

### 2.4 `@duya/agent/tool/allowedRoots` 后门

`apps/desktop/src/main/core/media-allowlist.ts:34` 与 `ipc/system-handlers.ts:27` 深 import agent 内部文件。它**不在** `packages/agent/package.json` 的 exports 里,靠 `tsconfig.main.json` 的 `paths` + `scripts/build-electron.mjs:82` 的 esbuild alias 双重手工接线。

**裁决:升为正式子路径导出**,或**下沉到更低层共享包**。它是纯路径归一化,不需要 agent 的任何上下文。任一侧漏改就是运行时解析失败。

### 2.5 `@duya/agent` 死导出

`package.json` 声明 `./file-parser` → `dist/file-parser/index.js`,但 **`src/file-parser` 目录不存在**。当前 4 个子路径中:

| 子路径 | 消费者 | 状态 |
| --- | --- | --- |
| `.` | 3(全 type-only) | 活 |
| `./file-parser` | 0 | **死导出,应删** |
| `./message` | 18(desktop main) | 活 |
| `./context/os-context` | — | 活 |

---

## S3 — Runtime 拿执行

见 [04 文件](04-runtime-owns-execution.md)。核心:`agent-process-entry.ts` 不再 import `DuyaAgent`,改实现 `ExecutionChannel`。

---

## S4 — Core 与纠偏

见 [05 文件](05-core-and-runtime-correction.md)。

---

## S5 — 六个新包

见 [06 文件](06-six-new-packages.md)。

---

## S6 — 退役

见 [07 文件](07-retirement.md)。

---

## 附:`packages/agent` 顶层区域现状(实测)

890 文件 / 7.7 MB。按 587 `migration-map.md` §2 的 40 行表格逐行核对,**没有一行满足"旧位置退出条件"**。

| 区域 | 文件数 | 体积 | 目标 |
| --- | --- | --- | --- |
| `tool/` | 25 | 261 KB | capabilities + tooling |
| `tool/BrowserTool/` | 40 | 402 KB | capabilities |
| `tool/CanvasConductor/` | 25 | 153 KB | capabilities |
| `tool/SubagentTool/` | 15 | 137 KB | runtime |
| `tool/BashTool/` | 8 | 83 KB | capabilities(第二 bundle 入口) |
| `agent/` | 20 | 368 KB | runtime + core |
| `process/` | 15 | 418 KB | runtime + host |
| `modes/` | 8(+子目录 60) | ~700 KB | core(声明)+ runtime(行为) |
| `prompts/` | 7(+子目录 60) | ~450 KB | core(渲染)+ tooling(loader) |
| `compact/` | 14 | 124 KB | core |
| `context/` | 2 | 15 KB | core |
| `skills/` | 16 | 127 KB | capabilities |
| `mcp/` | 11 | 107 KB | capabilities |
| `memory-state/` | 15 | 143 KB | **memory** |
| `memory-rollout/` | 9 | 133 KB | **memory** |
| `session/` | 12 | 193 KB | CP(session/tasks) |
| `hooks/` | 14 | 158 KB | tooling |
| `permissions/` | 6 | 133 KB | core(policy)+ CP(审批) |
| `cli/` | 10 | 112 KB | tooling |
| `ipc/` | 1 | 52 KB | host |
| `security/` | 1 | 26 KB | host |
| `mentions/` | 1 | 17 KB | core |
| `journal/` | 2 | 15 KB | CP(checkpoints) |
| `decisions/` | 6 | 29 KB | core |
| `wake/` | 7 | 35 KB | CP |
| `sandbox/` | 7 | 31 KB | capabilities |
| `channels/` | 3 | 29 KB | host |
| `lifecycle/` | 7 | 34 KB | runtime |
| `observability/` | 1 | 9 KB | runtime |
| `providers/` | 1 | 3 KB | 复用 `@duya/ai` |
| `config/` | 5 | 10 KB | host |
| `abort/`,`queue/`,`types/`,`constants/`,`utils/` | 30 | ~140 KB | 按 consumer 归位 |
