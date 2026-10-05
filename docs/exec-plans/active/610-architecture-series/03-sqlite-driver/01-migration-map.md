# 01 — 迁移地图

> Phase 0–3 的逐项做法。**Phase 0 不可跳过。**

---

## Phase 0:实测能力边界

> **在探针给出答案前,不写任何生产代码。**

### 0.1 唯一 next action

写**一个探针脚本**,在**两个运行时**里逐条验证:

- **本地 node**(v24.16.0)
- **Electron 主进程**(44.2.0 / 内置 Node v24.20.0)

两个都跑 —— 本地 node 可用**不代表** Electron 里可用。

### 0.2 探针必须覆盖的项

按风险从高到低:

| # | 待验项 | 为什么会推翻路线 |
| --- | --- | --- |
| 1 | **`db.close()` 语义** | `DatabaseSync` 无 `close()`。**98 处调用会静默变成 no-op** |
| 2 | **trigram tokenizer** | 若不支持,涉及它的 12 个文件的模糊搜索要重写 |
| 3 | **FTS5 `MATCH` 结果集** | 排序/分词差异会改变搜索结果 |
| 4 | **BigInt 边界** | 超出 `MAX_SAFE_INTEGER` 的 INTEGER 行为 |
| 5 | **`journal_mode=WAL` / `foreign_keys`** | 51 个 `.pragma(` 里最要紧的几个;错了不报错 |
| 6 | **嵌套事务 / savepoint** | 35 个 `.transaction(` 的语义 |
| 7 | **`.function()` 在 FTS5 触发器中** | 2 处自定义函数的可用上下文 |
| 8 | **BLOB / TEXT 类型往返** | Buffer 与字符串不得互串 |
| 9 | **回滚路径** | 新驱动写的文件,better-sqlite3 能否打开 |

### 0.3 探针的形态要求

**它必须是一个可复跑的脚本,不是一次性手动验证。**

理由:第 1–3 项任何一项在未来 Node/Electron 升级后都可能变化。
**没有可复跑的探针,这个计划就会退化成"我们曾经验证过一次"。**

放在 `scripts/sqlite-compat-probe.mjs`,两个运行时各跑一次,输出结构化结果。

### 0.4 决策点

| 探针结果 | 应对 |
| --- | --- |
| 全部通过 | 进 Phase 1 |
| trigram 不支持 | 评估:改用 FTS5 自带 tokenizer,或**路线改为 napi-rs** |
| `close()` 语义不可接受 | 评估:保留 better-sqlite3,**本计划终止** |
| 回滚路径不成立 | **阻断** —— 停下来重新设计 |

> **"回滚路径不成立"是唯一必须立刻停的项。**
> 其它项都有替代方案,这一项没有 —— 它意味着换驱动会**不可逆地**
> 改变用户数据文件的可读性。

---

## Phase 1:写兼容层

### 1.1 唯一 next action

创建 `apps/desktop/src/main/db/driver.ts`,对外暴露 better-sqlite3 的形状。

### 1.2 为什么必须是兼容层

**177 个文件。** 若直接把调用点改成 `node:sqlite` 原生形状,
每个 `.pragma()` / `.transaction()` / `.close()` 的写法都要重写。

兼容层把这件事从「重写 177 个文件的调用点」变成「改 177 个文件的 import」。

```ts
// Phase 2 之后,调用方长这样:
import { openDatabase } from './driver';   // 唯一改动
const db = openDatabase(path);
// 下面所有 db.prepare() / db.transaction() / db.close() 都不变
```

### 1.3 必须实现的 API

来自 [README §2.2](README.md#22-实际用到的-api-面) 的实测:

| 方法 | 备注 |
| --- | --- |
| `prepare()` | 返回带 `.get` / `.all` / `.run` / `.iterate` 的 Statement 包装 |
| `exec()` | 多语句执行 |
| `pragma()` | **51 个文件在用**,必须逐条对照 [00 §2.3](00-contracts.md#23-写入)验证 |
| `transaction()` | 35 个文件在用,含嵌套 |
| `close()` | **98 个文件在用 —— 必须存在,不许是空函数** |
| `function()` | 2 个文件在用 |
| `serialize()` | 1 个文件在用 |

### 1.4 `close()` 的实现要求

这是整个计划最需要小心的单点。

`DatabaseSync` 没有 `close()`,所以兼容层的 `close()` 必须**明确地做点什么**:

1. 尝试 `PRAGMA wal_checkpoint(TRUNCATE)` —— 让 WAL 落盘
2. 释放持有的语句引用
3. **明确记录:句柄本身靠 GC 回收**

**禁止**的实现:

- 空函数(`close() {}`)—— 假装成功,测试会假绿
- 抛错 —— 会打断 98 个调用点
- `process.exit()` —— 库不该决定进程生死

> **"空函数假装成功"是本计划最可能引入的静默缺陷。**
> 门禁 S2 与 [00 §2.4](00-contracts.md#24-生命周期--本计划最大的风险) 是它的防线。

### 1.5 兼容层自带测试

覆盖 [00 §2](00-contracts.md#2-语义等价判据) 全部条目,**不依赖任何真实业务数据**。
用 `:memory:` 与临时文件两种库。

---

## Phase 2:切换调用点

### 2.1 唯一 next action

177 个文件的 import 改为兼容层。**不改业务逻辑。**

### 2.2 切换顺序

按依赖从底向上,**每批一个提交,每批后跑一次测试**:

| 批次 | 范围 | 理由 |
| --- | --- | --- |
| 1 | `db/driver.ts` 自身 + 其测试 | 先让底座变绿 |
| 2 | `apps/desktop/src/main/db/**` | schema 与 store,底座正下方 |
| 3 | `apps/desktop/src/main/memory/**` | FTS5 + trigram,风险最高,**单独一批** |
| 4 | `packages/agent/src/session/**` | 含 FTS5 工具 |
| 5 | `packages/plugin-core/**` | 第二个声明依赖的 workspace 包 |
| 6 | `apps/desktop/src/main/agents/**` | worker / server 侧 |
| 7 | 其余(含测试文件) | 收尾 |

> **批次 3 单独拆出来。** 它是 FTS5 + trigram 的所在地,
> 也是唯一有可能在真实数据量下暴露性能差异的地方。
> 混在大批次里,失败时无法判断是"切换错了"还是"FTS5 行为变了"。

### 2.3 每批的验证

| 验证 | 说明 |
| --- | --- |
| `typecheck:all` | 编译面 |
| 该批次相关的包级测试 | **scope 明确** |
| **不做**全量 vitest | 根 scope 在本仓库不确定(见 [README §4.3](README.md#43-数字必须带-scope)) |

### 2.4 数据兼容验证

在批次 2 之后、批次 3 之前,做一次:

- 用**真实的存量数据库文件**的副本
- 新驱动打开 → 读关键表 → 跑一次 FTS5 查询
- better-sqlite3 打开**同一个副本** → 同样操作
- **两边结果必须一致**

> 这是 [00 §5](00-contracts.md#5-回滚要求) 的落地验证。
> **用副本,绝不用用户的真实库做实验。**

---

## Phase 3:删掉整条链路

### 3.1 唯一 next action

删除,并更新所有引用它的文档。

### 3.2 删除清单

| 对象 | 证据 |
| --- | --- |
| `scripts/ensure-sqlite-abi.mjs` | 286 行 |
| 14 个 `pre-` 钩子 | `package.json` 里 `preelectron:*` / `pretest*` / `pretest:e2e*`,其中 11 个调 ABI 脚本 |
| 根 `package.json` 的 `better-sqlite3` | — |
| `packages/agent/package.json` 的 `better-sqlite3` | — |
| `packages/plugin-core/package.json` 的 `better-sqlite3` | — |
| `@types/better-sqlite3` | devDep |
| `@electron/rebuild` | `package.json:105` devDep,`rebuild` 脚本(`:101`)依赖它 |
| `rebuild:node` 脚本 | `package.json:102`,指向 ABI 同步脚本 |
| `prebuild-install` | `package.json:134`,ABI 脚本用来下载预编译二进制 |
| `electron-builder.yml` 的 4 处引用 | `:27-28`(files)、`:52-53`(extraResources → `resources/better-sqlite3/`)、`:131`(`**/better-sqlite3/build/Release/*.node`) |
| `DUYA_BETTER_SQLITE3_PATH` 环境变量传递 | worker 侧,让 agent 找到主进程的原生模块 |
| `rebuild` / `rebuild:node` 脚本 | AGENTS.md 提到 |

> **`DUYA_BETTER_SQLITE3_PATH` 必须在打包配置删干净。**
> 留着它不会报错,只会让"还有原生模块"这个假设继续存在于文档和脚本里 ——
> **下一个读 AGENTS.md 的人会照着去跑一个已经不存在的修复流程。**

> **`electron-builder.yml` 的 4 处(见上表 `:27-28` / `:52-53` / `:131`)同样如此。**
> 留着 `files` 白名单里的一行不会让构建失败,只会让产物里继续躺着
> 一个没人用的原生模块 —— 而门禁 S1 正是要断言它不在。

### 3.3 文档同步(容易漏,但必须做)

| 文档 | 改什么 |
| --- | --- |
| `AGENTS.md` | **Footguns 一节的 better-sqlite3 整条删掉** |
| `AGENTS.md` | "Don't run `npm test` and `npm run electron:dev` at the same time" —— **这条禁令解除,删掉** |
| `AGENTS.md` | `npm run rebuild` / `rebuild:node` 命令说明 |
| `AGENTS.md` | Build System 表里 native 模块相关描述 |
| `ARCHITECTURE.md` | 若提到 ABI 同步机制,同步更新 |
| `docs/exec-plans/README.md` | 门禁表里若有 sqlite 相关行 |

> **AGENTS.md 是新 session 的第一份输入。**
> 一份描述已删除流程的 AGENTS.md,比没有文档更糟 ——
> 它会让人去跑一个不存在的脚本,然后困惑为什么没反应。

### 3.4 收尾验证

```bash
npm run check:encoding
npm run typecheck:all
npm run architecture:check
npm test                      # 记录数字,带 scope
npm run electron:build
npm run electron:pack
```

打包后确认 `release/win-unpacked/resources/` 下**不再有**
`better-sqlite3/` 目录。

---

## 门禁与本阶段的对应

| 门禁 | 落在哪一阶段 |
| --- | --- |
| **S2** 兼容层形状完整 | Phase 1 |
| **S3** FTS5 行为等价 | Phase 2 批次 3 |
| **S1** 无原生 sqlite | Phase 3 |
| **S4** 钩子已清 | Phase 3 |
| **S5** 无 ABI 报错 | Phase 3 后 |

**每条在合入前做变异证明。** 见 [README §4](README.md#4-门禁)。

---

## 明确不做的事

见 [README §5](README.md#5-本系列明确不做)。最容易违反的两条:

1. **不顺手解耦 `db/connection.ts` 的 Electron 依赖** —— 那是 601 的 Phase A
2. **不在同一个 PR 里改 SQL 查询** —— 无法归因
