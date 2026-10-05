# 602 — 干掉 ABI 同步

> **把 `better-sqlite3` 换成 Node 内置的 `node:sqlite`。**
> 删掉 `ensure-sqlite-abi.mjs`、14 个 `pre-` 钩子,以及"不能同时跑测试和 Electron"这条禁令。

## 0. 决策(2026-10-05)

> **ABI 问题不是被绕过,是被删除。**

今天 `better-sqlite3` 是 **V8-ABI 原生模块**,Node 和 Electron 的
`process.versions.modules` 一旦不同,那份 `.node` 就加载不了。

`node:sqlite` **不是原生模块** —— 它编译进 Node 运行时本身。
**换过去之后,根本不存在"ABI"这个东西。** 没有重编,没有 `prebuild-install`,
没有按平台选二进制,没有 `resources/better-sqlite3/`。

关键前提已实测:**Electron 44.2.0 内置 Node v24.20.0**,而 `node:sqlite`
要求 Node ≥ 22.5。**前提成立,且余量充足。**

---

## 1. 为什么不是换 Rust 驱动

2026-10-05 的讨论里,路线 A 被描述为「`better-sqlite3` → `napi-rs` + `rusqlite`」。
**那条建议是错的,已被本文件推翻。**

| 方案 | 之后还需要按平台发二进制吗 | `ensure-sqlite-abi.mjs` 能删吗 |
| --- | --- | --- |
| napi-rs + rusqlite | 需要(N-API 只保证 **ABI** 稳定,仍需每个平台/架构各编一份) | 能,但打包链路仍要维护 prebuild |
| **`node:sqlite`** | **不需要** | **能,连 `resources/better-sqlite3/` 一起删** |

N-API 确实比 V8-ABI 好 —— 它让"编一次、跨 Node 大版本可用"
([Node 文档](https://nodejs.org/download/release/v25.6.0/docs/api/n-api.html):
"ABI stable across versions of Node.js")。**但它解决的是 ABI,不是"要发二进制"这件事。**

`node:sqlite` 解决的是后者。**既然目标是删掉整条链路,就该选那个真正删掉的方案。**

> 这也回答了"要不要引入 Rust"这个问题:**这一个痛点不需要 Rust。**
> 引入 Rust 只是把"要发二进制"换成"要发二进制 + 要维护 Cargo 构建"。

---

## 2. 实测基线

全部在 `origin/master @ 46c36d9d` 上测得。

### 2.1 依赖与引用面

| 项 | 实测 |
| --- | --- |
| 声明的依赖 | `better-sqlite3 = ^13.0.3`(根 `package.json`) |
| workspace 声明者 | `packages/agent`、`packages/plugin-core`,各 `^13.0.3` |
| 引用它的源文件 | **177 个** |
| ABI 同步脚本 | `scripts/ensure-sqlite-abi.mjs`,**286 行** |
| `package.json` 里的 `pre-` 钩子 | **14 个**,其中 11 个调用 ABI 同步脚本 |

### 2.2 实际用到的 API 面

按 `.ts` 文件计数(同一文件内多次只计一次):

| API | 命中文件数 | 备注 |
| --- | --- | --- |
| `.close(` | 157 | 其中 **`db.close()` 73 次** —— 真实的 DB 生命周期 |
| `.prepare(` | 138 | |
| `.exec(` | 120 | |
| `.pragma(` | 51 | |
| `.transaction(` | 35 | |
| `.function(` | 2 | 自定义 SQL 函数 |
| `.serialize(` | 1 | |
| `.aggregate(` | 0 | |
| `.backup(` | 0 | |

> **`.close()` 是本计划最大的风险点,不是 `.prepare()`。**
> 73 次 `db.close()` 是真实的资源释放意图。
> `node:sqlite` 的 `DatabaseSync` **没有** `close()` 方法 ——
> 它靠 GC 回收。**这是真实的语义差异,不是改名问题。**

### 2.3 SQLite 特性依赖

按 `fts5|FTS5|trigram` 匹配:**12 个文件**同时涉及 FTS5 与 trigram。

主要位置:

- `apps/desktop/src/main/db/schema.ts`
- `apps/desktop/src/main/db/core/session-store.ts`
- `apps/desktop/src/main/memory/rag_index.ts` / `rag_search.ts` / `rag_snippet.ts`
- `packages/agent/src/session/db.ts`
- `packages/agent/src/tool/SessionSearchTool/SessionSearchTool.ts`

另:`json_extract` 1 个文件,`json_each` 0 个。

`node:sqlite` **带 FTS5**([photostructure 特性矩阵](https://github.com/photostructure/node-sqlite/blob/master/doc/library-comparison.md):
"FTS5, JSON functions, R*Tree, sessions/changesets, and more")。
**trigram 需在 Phase 0 实测确认** —— 见 [01 §1](01-migration-map.md#phase-0实测能力边界)。

### 2.4 环境事实

| 项 | 实测 |
| --- | --- |
| Electron | 44.2.0(`package.json` 声明 `^44.0.0`) |
| Electron 44.2.0 内置 Node | **v24.20.0**([releases.electronjs.org](https://releases.electronjs.org/release/v44.2.0)) |
| `node:sqlite` 要求 | Node ≥ 22.5.0 |
| 本地 node | v24.16.0 —— `require('node:sqlite')` **实测可用** |
| 导出符号 | `DatabaseSync`、`StatementSync`、`Session`、`constants`、`backup` |

---

## 3. 阶段与唯一 next action

| 阶段 | 文件 | 唯一 next action |
| --- | --- | --- |
| **0** 能力实测 | [01 §1](01-migration-map.md#phase-0实测能力边界) | 写一个探针脚本,在**两个运行时**(本地 node + Electron 主进程)里逐条验证 `node:sqlite` 能否满足 §2.2 的 API 面与 §2.3 的特性 |
| **1** 兼容层 | [01 §2](01-migration-map.md#phase-1写兼容层不逐个改调用点) | 写 `db/driver.ts`,对外暴露 better-sqlite3 形状的 `Database` / `Statement` |
| **2** 切换调用点 | [01 §3](01-migration-map.md#phase-2切换调用点) | 177 个文件改为从兼容层 import,**不改业务逻辑** |
| **3** 删链路 | [01 §4](01-migration-map.md#phase-3删掉整条链路) | 删 `ensure-sqlite-abi.mjs`、14 个 `pre-` 钩子、`resources/better-sqlite3/` 打包配置 |

> **Phase 0 不可跳过。** §2.2 的 `.close()` 语义差异和 §2.3 的 trigram
> 都是**可能推翻路线**的未知项。**在探针给出答案前,不要写任何生产代码。**

### 3.1 顺序纪律

```mermaid
flowchart LR
  P0["0 实测能力边界"] --> P1["1 兼容层"] --> P2["2 切调用点"] --> P3["3 删链路"]
```

**顺序不可颠倒,尤其不能先删再补。**
若 Phase 0 证明 trigram 或 `.close()` 不可满足,正确的应对是**回到 Phase 0 改路线**,
不是"先删了再说"。

---

## 4. 门禁

| 门禁 | 检查 | 变异证明 | 状态 |
| --- | --- | --- | --- |
| **S1** 无原生 sqlite | `node_modules` 与 `resources/` 下无 `better_sqlite3.node` | 把一个 `.node` 拷回去 | 待做 |
| **S2** 兼容层形状完整 | 兼容层实现了 §2.2 列出的**全部**已用 API | 删掉 `transaction` | 待做 |
| **S3** FTS5 行为等价 | FTS5 建表 / 插入 / `MATCH` 查询结果与换驱动前一致 | 去掉一个 tokenizer | 待做 |
| **S4** 钩子已清 | 14 个 `pre-` 钩子与 `ensure-sqlite-abi.mjs` 均已删 | 把一个钩子加回去 | 待做 |
| **S5** 无 ABI 报错 | 全量测试与打包后日志无 `NODE_MODULE_VERSION` | 换回 better-sqlite3 | 待做 |

### 4.1 门禁必须做变异证明

> 600 的纪律:守卫报告事实却不检查任何东西,比红测试更危险。
> 每条门禁合入前**故意制造它要防的回归,确认变红,然后完全回退**。

**S1 与 S5 尤其危险**,因为它们可能在"文件还在但没人用"的情况下变绿。
**变异证明是唯一能区分"真的没了"和"扫描没找到"的手段。**

### 4.2 拒绝恒等式断言

比较的两侧必须来自**不同来源**(声明 vs 实测、预期 vs 真实输出)。
拿测量值比测量值 = 永远通过。

**具体到本计划:** S1 必须断言"**文件系统枚举结果为空**",
不能断言"我的过滤逻辑返回了 0 条"。

### 4.3 数字必须带 scope

`<通过>/<总数> in <scope>`,例如 `563/563 in packages/agent-runtime/test`。
裸数字不可判读。

> 根 `npx vitest run` 在本仓库**不是可靠门禁** ——
> 它在同一个 pristine HEAD 上两次运行给出不同的失败文件集。
> **用包级 scope**,或先测出该 scope 在 pristine HEAD 上的真实基线。

---

## 5. 本系列明确不做

| 不做 | 理由 |
| --- | --- |
| 引入 Rust / napi-rs | §1:解决不了"要发二进制"这个真问题 |
| 改 SQLite 文件格式 | 换驱动不改磁盘格式;**必须证明旧库能被新驱动打开且能回滚** |
| 顺带改 `packages/agent` 的 DB 层 | 那是 600 的 Session data contract 范围 |
| 改 schema / 迁移逻辑 | 换驱动不是换 schema |
| 动 600 的门禁 baseline | 门禁是事实报告,不是待办清单 |
| 优化 SQL 性能 | 换驱动同时改查询 = 两个变量,无法归因 |

> **性能必须单独量、单独判。** 已知 `node:sqlite` 与 better-sqlite3
> 在不同查询形态上互有胜负(better-sqlite3 在约 1000 行批量读上更快,
> 两者在单行查询上接近)。**不许在换驱动的同一个 PR 里改查询。**

---

## 6. 完成定义

> 按 600 的教训重写:"文件搬走了"不是落实。

Phase 3 完成 = 同时满足:

1. **S1–S5 全绿**,且每条都做过变异证明
2. `better-sqlite3` **从 `package.json`、workspace 依赖、打包配置里彻底消失**
3. `ensure-sqlite-abi.mjs` 与 14 个 `pre-` 钩子已删
4. **"不能同时跑 `npm test` 和 `npm run electron:dev`"这条禁令已解除** ——
   AGENTS.md 的 Footgun 一节要同步改
5. **存量数据库文件能被新驱动正常打开**,且有一个**显式的回滚步骤**
6. 全量测试通过,**数字带 scope**

第 4 条是本系列的**实际收益指标**。若做完仍然不能同时跑,
说明痛点没有真正消除,只是换了个地方。

---

## 7. 支持资料

| 文件 | 内容 |
| --- | --- |
| [00 合同](00-contracts.md) | 语义等价判据、不可协商的边界。**唯一权威** |
| [01 迁移地图](01-migration-map.md) | Phase 0–3 的逐项做法与逐文件切换顺序 |
| [90 执行日志](90-execution-log.md) | 每轮实测数字与未决问题 |

外部依据:

- [Electron v44.2.0 release](https://releases.electronjs.org/release/v44.2.0) —— Node v24.20.0
- [Node-API 文档](https://nodejs.org/download/release/v25.6.0/docs/api/n-api.html) —— ABI 稳定性边界
- [node:sqlite 特性矩阵](https://github.com/photostructure/node-sqlite/blob/master/doc/library-comparison.md) —— FTS5 / JSON / 版本要求
