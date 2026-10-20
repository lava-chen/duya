# @duya/data

Electron 无关的数据根解析、SQLite 连接与迁移、持久化 store。拥有 `duya-main.db` / `duya-core.db` / `memory-state.db` 的路径解析与前两者的 schema 与迁移。

## 1. 负责 / 不负责

**负责**

- 数据根与三个 DB 文件路径的解析（含测试 namespace 隔离）。
- 主库（main）与核心库（core）的连接、schema 初始化、迁移执行、WAL checkpoint。
- 持久化 store：session / task / goal / run / research / conductor / message-log 等。

**不负责**

- `memory-state.db` 的**表与迁移** → 桌面 app（`apps/desktop/src/main/memory-state/migrations/index.ts:42`）；本包只负责解析它的**路径**（`packages/data/src/data-paths.ts:43`）。
- 业务领域逻辑（记忆领域是另一个域）→ `@duya/memory`（`packages/memory/src/index.ts:17`）。
- Electron 主进程的 IPC 与生命周期 → 桌面 app。
- 协议类型 → `@duya/agent-protocol`（本包唯一声明依赖）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/data/src/data-paths.ts:24` | `resolveDataRoot()`（`DUYA_DATA_ROOT` / `DUYA_TEST` namespace 优先）；`resolveDatabasePaths:37` 返回 main `:38` / core `:42` / memory-state `:43` 三条路径。 |
| `packages/data/src/main-database.ts:13` | `MainDatabase`；`:26` 调 `initializeSchema`。 |
| `packages/data/src/main-schema.ts:23` | `initializeSchema()`——主库迁移注册表；迁移账本表 `_schema_migrations` 在 `:903`。 |
| `packages/data/src/core-database.ts:69` | `CoreDatabase`——核心库；WAL checkpoint 调度 `startWalCheckpoint:26`（每 60 s，`:22`）。 |
| `packages/data/src/core-stores.ts:1170` | `createCoreDataStores()`——组装核心库 store；迁移汇总 `collectCoreDataMigrations:1197`（**核心库的迁移注册表**）。 |
| `packages/data/src/database-host.ts:10` | `DatabaseHost`；`CoreDataHost` 在 `packages/data/src/core-data-host.ts:23`。 |
| `packages/data/src/database-migration.ts:29` | `migratePreviousDefaultDatabases()`——旧默认位置的数据迁移。 |
| `packages/data/src/message-log.ts:294` | `MessageLog`——rollout JSONL（`:4-5`）+ `message_index` 表（`:302`）；迁移 `:296`。 |
| `packages/data/src/run-store.ts:351` | `RunStore`。 |

公共面：`packages/data/src/index.ts`（barrel）+ `packages/data/src/data-paths.ts`、`packages/data/src/database-migration.ts`、`packages/data/src/core-database.ts`、`packages/data/src/run-store.ts` 等子路径导出（`packages/data/package.json` 共 55 个）。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 迁移不匹配 / 缺列 | `packages/data/src/main-schema.ts:903` + `packages/data/src/core-stores.ts:1197` + `apps/desktop/src/main/memory-state/migrations/index.ts:42` | **三套迁移注册表**，先确认是哪个库。 |
| 找不到数据库文件 / 写到了别的目录 | `packages/data/src/data-paths.ts:24` + `packages/data/src/data-paths.ts:37` | 测试 namespace 与 `DUYA_DATA_ROOT` 都会改路径。 |
| 数据库被锁 / WAL 膨胀 | `packages/data/src/core-database.ts:22` + `packages/data/src/database-owner-lock.ts:28` | checkpoint 周期与 owner 锁。 |
| 旧版本的库没被接管 | `packages/data/src/database-migration.ts:29` | 默认路径迁移只在这里做。 |
| 消息查不到 / 索引与 rollout 对不上 | `packages/data/src/message-log.ts:302` + `packages/data/src/message-log.ts:4` | 载荷在 JSONL，索引在 SQLite，两层要一起看。 |

## 4. 边界约束

- `architecture-policy.yaml:213-223`：模块 `data`，`managed: true`，`requires: [agent-protocol]`——只能依赖协议包。
- **三套迁移注册表别混**：(1) 主库 `packages/data/src/main-schema.ts:23`；(2) 核心库 `packages/data/src/core-stores.ts:1197`（由 `packages/data/src/core-database.ts:69` 执行）；(3) `memory-state.db` 由**桌面 app** 拥有（`apps/desktop/src/main/memory-state/migrations/index.ts:42`），不归本包。
- **已知表名重复**：`research_*` 同时出现在 `packages/data/src/main-schema.ts:1627`（主库）与 `packages/data/src/research-store.ts:434`（核心库）；`conductor_*` 同理（`packages/data/src/main-schema.ts:288` vs `packages/data/src/conductor-store.ts:257`）。两套都在本包内，别按表名猜库。
- 本包依赖原生 `better-sqlite3`；Electron 与本地 Node 的 ABI 不同，切换运行时要用 `scripts/ensure-sqlite-abi.mjs`（见根 `AGENTS.md` 的 Footguns）。
