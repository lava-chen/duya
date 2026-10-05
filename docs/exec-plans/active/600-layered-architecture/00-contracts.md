# 00 — 分层合同(唯一权威)

> 本文件定义 600 系列的职责边界、允许依赖与对象分类。与 [README](README.md) §2 配套。
> **冲突时以本文件为准。** 587 的 `00-contracts.md` 已被本文件接管,见 [10 接管](10-takeover-from-587.md)。
> 2026-10-04 决策覆盖 587 两处:Session 降级为投影(§C)、六个新包全部建立(§E)。
>
> **管辖范围(2026-10-05 裁决):本文件是"层与依赖方向"的唯一权威,不是"进程与网络边界"的权威。**
> 601 有一份同样自称"唯一权威"的 `00-contracts.md`,管的是 Client / Runtime / Control Plane
> 三角色与它们之间的进程、网络边界。两份文件的关系现在写死,避免以后各写各的:
>
> | 维度 | 权威 | 本文件是否管 |
> | --- | --- | --- |
> | 层、允许依赖、反向边、门禁 G1–G9 | **本文件** | ✅ |
> | 哪个模块属于 `apps/` 还是 `packages/` | **本文件 §A.2b** | ✅ |
> | 进程边界(控制平面是否独立成进程) | 601 | ❌ |
> | 网络边界(客户端契约、鉴权、runtime 注册) | 601 | ❌ |
>
> **不越界声明(双向):**
> - 601 **不发明分层**,不修改本文件的依赖禁令。601 `README.md:167-169` 自陈
>   "这条边界直接来自 600 的 CP / Runtime 分层 —— 601 不发明分层,只给它进程边界和网络边界"。
> - **本文件不规定进程拓扑。** §A.4 已经写了这条原则:"Runtime 包可以在 worker 进程执行,
>   server 负责管理。不要因为'它要跑在另一个进程'就把它挪进 host 包。" 601 正是把这条原则
>   用到了控制平面自身 —— 那是 601 的自由度,不是对本文件的修改。
>
> 出现分歧时的处理:**改本文件前先看 601 `00-contracts.md`,反之亦然。** 两边对同一件事各写一句
> 而不互引,就是下一次漂移的开始。

---

## A. 分层职责与允许依赖

### A.1 五层表

| 层 | 允许依赖 | 禁止 |
| --- | --- | --- |
| **protocol** | 确有必要的无 IO leaf | host、数据库、provider、工具 registry;Promise/Map/函数进入 wire |
| **core** | protocol、纯函数库 | 自行 FS/NET/PROC/数据库/clock;通过 AI client 间接 IO;import runtime |
| **runtime** | core、protocol、能力 adapter | Electron、renderer、Desktop logger/schema/migration;import CP;**知道 Project/Goal/Task/Session** |
| **CP services** | runtime、protocol、repository port | UI、worker 句柄、另造模型循环;直接写 SQL |
| **host** | 上述公开入口 | 让下层回 import host 实现 |

### A.2 箭头只指向依赖方向

```text
Host → CP → Runtime → Core → Protocol
```

**反向边一律违规**,由门禁 G1 检查。当前已知违规(实测,2026-10-04):

| 违规 | 位置 | 状态 |
| --- | --- | --- |
| `pkg:agent → electron-main` | 15 条边 | M5.2 已归零 |
| `electron-main → src-renderer` | 33 → 32 条 | 未归零 |
| `src-renderer → electron-main` | 4 → 2 条 | 未归零 |
| core 内 IO carve-out | 6 个文件 | 债务,退役条件见 §H |

### A.2b CLI 的归属:一个包,两个面(2026-10-04 裁决)

`@duya/cli` **留在 `packages/`** —— 它不是 `apps/` 的一部分。但它内部必须按本节的规则拆成两个面,否则它会成为一个既是 host 又是 runtime 依赖的混合体。

**为什么不能进 `apps/`:** 它有两个真实消费者。`packages/cli/src/index.ts` 被 `scripts/build-cli-bundle.mjs` 打成 `duya` 可执行文件,但 `packages/cli/src/contract/index.ts` 被 `@duya/agent` 的 `tool/DuyaCliTool/` 导入(实测 4 处,全部走 `@duya/cli/contract` 子路径)。**一个只服务 app 的东西不会有第二个包消费者。**

**为什么不能整体算 runtime:** `packages/cli/src/api/client.ts:64/83/172/213/304` 走 `http://127.0.0.1:{port}` + `fetch`,`commands/{agent,cron,session,projects-cleanup}.ts` 直接 `import ... from 'node:fs'`。**它有真实 IO,不能进 runtime。**

**因此按面拆:**

| 面 | 内容 | 依赖方向 | 归属层 |
| --- | --- | --- | --- |
| **contract 面** | `program/`(descriptors、registry、`buildAgentRunner`)、`contract/index.ts`、`api/format.ts` | 不 import agent runtime、不 import electron | **runtime 可依赖** |
| **app 面** | `api/client.ts`(HTTP 传输)、`commands/*`(真实 fs 操作)、`index.ts`(commander 入口) | 可依赖 contract 面 | **host 层** |

**contract 面的硬规则(已写在 `packages/cli/src/contract/index.ts:24-27`):**

> This module MUST NOT import any agent runtime (no `duyaAgent`, no `REPL`, no `loadSkills`, no `session/db.ts`). It is the boundary.

**这条规则目前成立** —— 实测 `@duya/cli` 的**全部** 4 处外部引用都走 `/contract` 子路径,没有任何一处 import 它的 app 面。所以 G1 报的 4 条 `@duya/agent → @duya/cli` 边**方向是对的,但门禁的层表把整个 `cli` 包归 host 是错的** —— 它把一个合法的 contract 依赖误报成反向边。

**G1 的修法:** 层判定必须**按子路径**,不是按包。`@duya/cli/contract` 归 runtime 可依赖面,`@duya/cli`(裸导入)归 host 面。

**App 与 package 的判据(通用):**

> 一个模块属于 `apps/` 还是 `packages/`,取决于它**有没有包外消费者**,不取决于它是不是"一个应用"。
>
> `apps/desktop` 在 `apps/` 因为它是 Electron 壳 + renderer,没有第二个包需要它。
> `@duya/cli` 在 `packages/` 因为 `@duya/agent` 需要它的 contract 面。
> 若某天 `duya` CLI 只剩 app 面、没有包消费者,它才该降进 `apps/`。

### A.3 Core 零 IO 的含义

**不是"core 没有 IO 函数",是 core 的输入只能是数据,输出只能是决策。**

- 需要异步端口的算法/loop → 放 runtime
- core 通过**输入**接收 clock / seed / 随机数,不自己 `Date.now()`
- `packages/ai` 混合包(既有 adapter 又有纯转换)需要拆分出口;**不得**靠改层名把一个能 `fetch` 的包"声明"成 core 可达

当前 carve-out 6 个文件(门禁 G2 报告,非推测):`utils/backoff.ts:119`、`utils/idle-timeout.ts:40`、`system-one/client.ts:188`,以及 `system-one/client.ts:166` 与 `api/google-generative-ai.ts:398` 证明的注入 transport 路径。

**每条 carve-out 的退役条件是注入 transport/signer/clock port**,不是改文件位置。

### A.4 模块边界 ≠ 进程边界

Runtime 包可以在 worker 进程执行,server 负责管理。**不要因为"它要跑在另一个进程"就把它挪进 host 包。**

---

## B. 身份、输入与 Manifest

- `projectId` 保持原 UUID 与私有配置归属,**不以路径重造**。Project 是逻辑 namespace,不等于文件夹。
- **`runId` 是 Run 的唯一根身份。** 由 CP/start 入口生成,贯穿 worker 命令、事件、审批、指标。
- `goalId` / `taskId` 是 Run 的**归属引用**,不是 Run 的根。
- `workspaceId` 是 device-local 持久 UUID;Root 也有稳定 ID。`cwd` 是 `(rootId, relativePath)` 对,不是需要重新解析的裸字符串。
- `workflowRunId` / `subagentTaskId` 另存关联,不与 `runId` 混用。

### B.1 RunManifest 是不可变的

Manifest = 本次解析后的**冻结配置**:roots/cwd、模型配置 ref、tool/catalog 版本、profile/modes、预算、permission policy 版本、connector binding、context source digests。

**Runtime 只吃 manifest。** 它不知道 Project 存在,不知道这是第几次重试,不知道谁在等 —— 那些是 CP 的事。

临时缺字段必须表达 unsupported/unknown 及来源,**不用空数组或 `unresolved` 声称完全可复现**。配置 hash 不是外部世界快照。

---

## C. Session 降级为投影(覆盖 587 §B)

**Session 是通信/对话投影,不再承担 Agent identity 和 durable execution identity。**

- Run / Goal / Task 以**自身 ID 为根**,不以 `session_id` 为外键
- Session 可以被重建、替换、归档,不改变任何 durable 实体
- 外部 channel(Telegram/Slack 等)另有地址 identity,不降格或替代 session

**为什么这条是所有边界的前提:** Runtime 只要还认 `sessionId`,就没法只吃 `RunManifest`。Session 是 UI 概念,把它漏进执行层,边界就漏了。

实测当前 schema 是反的 —— `runs.session_id NOT NULL`、`tasks.session_id`、`session_goals` 连表名都带 session。解耦方案与迁移顺序见 [01 §S1](01-migration-map.md#s1)。

---

## D. Run 生命周期与结果

逻辑生命周期:`created → starting → running → stopping/completing → terminal`。

- `result()` **只等**最终结果,**不得**调用 settle 推动终态
- 多次读取和 settle 共享同一个完成 Promise
- 终态只有一个 writer;必要事件确认后 CAS 提交
- **终态决策与存储确认分开**:内存可已决定,但 `result` 与 public 完成信号必须遵守 durable barrier
- DB 失败返回明确失败/降级 receipt,**不伪装 completed**
- executor 退出无终态、dispatch 失败、hardkill → 合成明确 terminal 事件

CAS/idempotency:相同 `runId` + 相同 manifest/input 返回既有句柄;不同内容拒绝。同 seq 同 payload 重试允许,不同 payload 冲突报错。

---

## E. 六个新包

**覆盖 587 §2「不提前建立通用 tools/memory/storage/ui 包」的禁令。**

理由:codex-rs 用 170+ crate 的细粒度分层证明了这条路可行。587 的顾虑是"造空包",所以本系列的要求是**每个包必须有真实代码迁入**。

| 包 | 装什么 | 明确不装 |
| --- | --- | --- |
| `capabilities` | Files / Shell / Browser / MCP / ComputerUse | 不知道 Goal / Task / Session |
| `connectors` | **App Connectors** | 不装 MCP server、不装 plugin marketplace |
| `memory` | **Memory V2** | 不装 transcript、不装 compaction |
| `tooling` | 扩展契约 + 细粒度 contributor + 装配 | **不做万能注册表** |
| `data` | SQLite / JSONL / filesystem 实现 | 不含业务决策 |
| `ui` | 共享 UI 组件 | 不含 renderer 状态逻辑 |

`capabilities` / `connectors` / `memory` 三者的能力**不知道 Goal / Task / Session 生命周期** —— 这是它们共同的边界纪律。

**Workspace 不独立成包**,作为 `control-plane/workspace/` 内部模块。

---

## F. Tooling:扩展契约,不是注册表

参考 codex-rs `ext/extension-api` + `ext/*`。见 [02 文件](02-tooling-and-extensions.md) 的完整对照。

三条硬规则:

1. **每个 contributor 是独立窄接口**,不是一个大 `register(plugin)`。加新能力 = 加新接口,不改既有接口。
2. **贡献点是数据 + 决策,不是行为接管。** 扩展往 runtime 既有循环里**注入片段**,不自己实现循环。
3. **`tooling` 依赖 protocol/tools,不被 runtime 依赖成环。**

**不抄 codex-rs 的一点:** `codex-core` 的 `Cargo.toml` 依赖了 `codex-mcp`、`codex-file-system`、`codex-login`、`codex-client` 等大量有 IO 的 crate。本系列的 **Core 不允许这样**(§A.3)。

---

## G. Storage 边界

原则:**`Domain Object → Repository interface → SQLite / JSONL / filesystem implementation`。**

- 上层**禁止**到处直接写 SQL
- CP service 依赖 repository **interface**,实现由 host 注入
- `data` 包只装实现,不含业务决策
- 同一个领域**只能有一个 live writer owner**(门禁 G5)

---

## H. 固定的质量约束

- Core 通过输入提供 clock/seed 数据;Runtime 注入 clock/telemetry/执行端口
- production ledger **不能**从 `/testing` 导入
- 所有 `unknown` / `supported: false` 可被消费者读取
- eval 用**同一套公开 API**,deterministic offline 与 stochastic live 分开
- **每项任务实现后才能勾选**;Moved / Typechecked / Tested / Merged / RuntimeVerified 分别记录,不合并
- 敏感值不进公开 manifest / event / artifact / 日志
- 默认 pause/resume/determinism **unsupported** 直到验收通过;`UNPROVEN_CAPABILITIES` 不得被静默移除
- 门禁必须**变异可证**(见 [README §5](README.md#5-门禁每条边界都要能变红))
