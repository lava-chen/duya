# 02 — Phase 0 实测结果(C1)

> 计划 610 / 切片 C1。Phase 0 的能力边界实测。
> 探针:`scripts/sqlite-compat-probe.mjs` + `scripts/sqlite-compat-probe.electron.cjs`。
> **本文件所有数字均为本轮当场实测,不是从计划文档抄的。**

---

## 0. 结论先行

| 项 | 结论 |
| --- | --- |
| **建议** | **GO —— 可以进 Phase 1。** 9 项全绿,两个运行时一致 |
| **阻断项(第 9 项 回滚路径)** | **成立。** 双向可读可写,文件头一致 |
| **`close()` 语义** | **可用,而且比计划文档写的更好** —— 见 §3 |
| **必须带进 Phase 1 的差异** | 3 条,见 §4。都不是阻断,但都需要兼容层处理 |

> **本轮推翻了计划文档的一条核心前提。**
> `01-migration-map.md` 与 `README §2.2` 都断言「`DatabaseSync` 没有 `close()`」。
> **实测:有,而且是真关闭。** 这直接改变了 01 §1.4「兼容层 close() 必须靠 GC」的设计要求
> —— 不必再靠 GC,也不必再"明确记录句柄靠 GC 回收"。

---

## 1. 两个运行时的实测身份

| 项 | 本地 node | Electron 主进程 |
| --- | --- | --- |
| 运行时 | node **24.16.0** | Electron **44.2.0** / node **24.20.0** |
| `process.versions.modules`(ABI) | **137** | **149** |
| 启动方式 | `node scripts/sqlite-compat-probe.mjs` | `npx electron scripts/sqlite-compat-probe.electron.cjs` |
| `node:sqlite` 内置 SQLite | **3.53.0** | **3.53.4** |
| better-sqlite3 | 13.0.3(可加载) | 13.0.3(可加载) |
| 结果 | **10/10 通过,exit 0** | **10/10 通过,exit 0** |

> **两个运行时用的是不同的 `node:sqlite` SQLite 版本(3.53.0 vs 3.53.4)。**
> 不是笔误 —— Electron 44.2.0 内置的 Node 打包了不同版本的 SQLite。
> **这说明"在本地 node 上验证过"确实不蕴含"Electron 里也成立"**,
> 计划 [01 §0.1](01-migration-map.md#01-唯一-next-action) 要求跑两个运行时是对的。

> **ABI 陷阱实测未复现。** 两个运行时 `modules` 分别是 137 / 149,
> 而 better-sqlite3 在**两个运行时里都能加载并产出真实结果**
> (第 3、9 项的跨驱动比较都拿到了真实数据,不是降级桩)。
> 这与 `README` 的「前提更正」一致:13.0.3 是 N-API 插件,`prebuilds/` 里
> **没有任何一个 `.node` 带 ABI**,所以不存在"换驱动要换二进制"这件事。
> **AGENTS.md Footguns 里那条「不能同时跑 `npm test` 和 `electron:dev`」在当前依赖版本上不成立。**

---

## 2. 九项结果表(两个运行时)

`10/10 in scripts/sqlite-compat-probe.mjs`(含探针自身的完整性检查项 0)。

| # | 待验项 | node 24.16.0 | Electron 44.2.0 | 实测值 |
| --- | --- | --- | --- | --- |
| 0 | 探针自检:每条断言都有两个独立来源 | **PASS** | **PASS** | 10/10 项来源互不相同 |
| 1 | `db.close()` 语义 | **PASS** | **PASS** | `close` 是函数;close 后 `prepare` 抛 `ERR_INVALID_STATE`;**持有句柄时 OS 文件锁生效(重命名 EBUSY),close 后可重命名** |
| 2 | trigram tokenizer | **PASS** | **PASS** | `tokenize='trigram'` 建表成功;3 字 CJK 子串 `"数据库"` 命中 rowid `[3,5]` |
| 3 | FTS5 `MATCH` 结果集 | **PASS** | **PASS** | 4 条查询(含 bm25 排序)在两个驱动间**逐字节一致**,且与手写字面量一致 |
| 4 | BigInt 边界 | **PASS** | **PASS** | 超 `MAX_SAFE_INTEGER` 读回**抛 `ERR_OUT_OF_RANGE`**;`setReadBigInts(true)` 下精确返回 `9007199254740993` |
| 5 | `journal_mode=WAL` / `foreign_keys` | **PASS** | **PASS** | 读回 `journal_mode="wal"`、`foreign_keys=1`;**孤儿插入被拒**、合法插入被接受 |
| 6 | 嵌套事务 / savepoint | **PASS** | **PASS** | 内层 savepoint 回滚后最终行集 `[1,3]`,与 better-sqlite3 `.transaction()` 嵌套一致 |
| 7 | `.function()` 在触发器中 | **PASS** | **PASS** | UDF 在 INSERT / UPDATE 触发器内均被调用;归一化结果可被 `MATCH` 命中 |
| 8 | BLOB / TEXT 往返 | **PASS** | **PASS** | TEXT 返回 `string` 且逐字相等;BLOB 字节精确;`typeof()` 为 `text`/`blob`,未互串 |
| 9 | **回滚路径(唯一硬停)** | **PASS** | **PASS** | 双向:node 写的文件 better 能读能写;better 写的文件 node 能读能 MATCH;文件头 `SQLite format 3` / pageSize 4096 / write&read version 2 一致 |

---

## 3. `close()`:本轮最重要的发现

**计划文档的前提是错的。** 原文([01 §0.2](01-migration-map.md#02-探针必须覆盖的项) /
[README §2.2](README.md#22-实际用到的-api-面))写的是:

> `DatabaseSync` **没有 `close()`**。98 处调用会静默变成 no-op。

**实测(Node 24.16.0 与 Electron 44.2.0 内置 24.20.0 一致):**

| 断言 | 实测 |
| --- | --- |
| `typeof db.close` | `"function"` |
| close 后 `db.prepare(...)` | 抛 `ERR_INVALID_STATE: database is not open` |
| close 后已有的 Statement | 抛 `ERR_INVALID_STATE: statement has been finalized` |
| close 后 `db.exec(...)` | 抛 `ERR_INVALID_STATE: database is not open` |
| **持有句柄时重命名 db 文件** | **`EBUSY`**(OS 层面确实锁着) |
| **close 后重命名 db 文件** | **成功** |

**所以第 1 项的风险不是"无法实现",而是"实现得太容易,容易被写坏"。**
兼容层如果图省事写 `close() {}`,没有任何编译器会报错 ——
所以探针把 **OS 文件锁**作为判据,而不是"另一个驱动还能不能写"。
原因见 §5。

> **仍然需要 Phase 1 注意的一个真实差异:**
> **重复 close 的行为不同。**
> `node:sqlite` 抛 `ERR_INVALID_STATE`;better-sqlite3 **静默 no-op**(`close()` 返回 db 自身)。
> 现有代码里若有"关两次"的路径(如 teardown 后再兜底关一次),
> 换驱动后会从静默变成抛错。**这是本次迁移唯一一处"原来不报错、换完会报错"的语义变化。**

---

## 4. 必须带进 Phase 1 的三条差异

不是阻断,但兼容层必须显式处理,**否则会以静默行为变化的形式出现**。

### 4.1 `BLOB` 读回是 `Uint8Array`,不是 `Buffer`

| 驱动 | 构造器 | `Buffer.isBuffer()` |
| --- | --- | --- |
| better-sqlite3 | `Buffer` | `true` |
| **node:sqlite** | **`Uint8Array`** | **`false`** |

字节完全一致(探针已断言),**但 `Buffer.isBuffer(row.blb)` 会从 `true` 变 `false`**。
任何 `.toString('base64')` / `.toString('utf8')` / `.equals()` 的调用点都要在兼容层包一层 `Buffer.from()`。
**只做字节比较的测试会全绿,只有真正调用 Buffer 方法的代码才会炸** —— 这是典型的静默陷阱。

### 4.2 超 `MAX_SAFE_INTEGER` 的 INTEGER 行为**变严格了**

| 驱动 | 读回 `9007199254740993` |
| --- | --- |
| better-sqlite3 | **`9007199254740992`(静默丢精度)** |
| node:sqlite(默认) | **抛 `ERR_OUT_OF_RANGE`** |
| node:sqlite + `setReadBigInts(true)` | `9007199254740993n`(精确) |

**新驱动在这一点上比旧驱动更符合 [00 §2.1](00-contracts.md#21-值) 的要求。**
但**行为是变的**:以前静默丢精度的调用点,换完之后会抛错。
好在 SQLite 主键不会到这个量级,风险集中在 `json_extract` 之类可能返回大整数的路径。
**兼容层必须显式决定:是否默认 `setReadBigInts` 全开,还是保持抛错。**
建议保持抛错 + 提供开关,不要静默改语义。

### 4.3 触发器里调用的 UDF **必须在每个连接上各自注册**

写入一个"触发器引用了 UDF"的文件后,better-sqlite3 可以**读**,但**写**会报:

```
SQLITE_ERROR: no such function: fts_normalize
```

在 better-sqlite3 连接上注册同名 UDF 后,写入成功。

**这不是换驱动引入的问题 —— 这是 SQLite UDF 的固有语义**,
仓库已经在 `apps/desktop/src/main/db/schema.ts:543-547` 写明了
("SQLite UDFs are per-connection, so each process must register independently")。
**记在这里是因为它一度让第 9 项变红**:如果只测"能读"就下结论,会漏掉"写不进去"。
探针的第 9 项因此同时断言了读、写、和写后可回读。

---

## 5. 回滚路径 verdict(单独陈述)

> **第 9 项成立。阻断条件没有触发。**

实测覆盖(两个运行时都跑了):

| 方向 | 断言 | 结果 |
| --- | --- | --- |
| node:sqlite 写 → better-sqlite3 读 | 5 行全部读出,内容一致 | **通过** |
| node:sqlite 写 → better-sqlite3 读 FTS5 | `MATCH "quick"` → `[1,2,4]`(标题索引) | **通过** |
| node:sqlite 写 → better-sqlite3 看 journal mode | `wal` | **通过** |
| node:sqlite 写 → better-sqlite3 **写** | 写入 id=99 成功 | **通过** |
| node:sqlite 回读 better 的写入 | `written-by-better-sqlite3` | **通过** |
| better-sqlite3 写 → node:sqlite 读 | 5 行全部读出 | **通过** |
| better-sqlite3 写 → node:sqlite 读 FTS5 | `MATCH "quick"` → `[1]` | **通过** |
| 文件头 | 两边都是 `SQLite format 3` / pageSize 4096 / writeVer 2 / readVer 2 | **一致** |
| WAL 落盘 | close 后 `-wal` 侧车文件不存在 | **通过** |

**为什么这个断言不是恒等式:**写入方和读取方**是两个不同的实现**。
一个驱动能读自己写的文件,不构成任何保证;
因此探针把"新驱动写的文件被**旧驱动**打开并正确读写"作为通过条件,
并且反向也测了一遍。**没有让驱动自己给自己打分。**

---

## 6. 变异证明

**目标:证明探针真的能测出失败,而不是永远绿。**
共注入 **12 个回归**,逐个完全回退。

| # | 注入的回归 | 结果 |
| --- | --- | --- |
| M1 | `close()` 调用删除(模拟计划担心的空函数 close) | **第 1 项 FAIL,exit 1** |
| M2 | trigram 换成不存在的 tokenizer | **第 2 项 UNSUPPORTED** |
| M3 | better-sqlite3 对某条查询返回不同结果集 | **第 3 项 FAIL** |
| M4 | node:sqlite 的 `quick` 结果集丢掉 row 4 | **第 3 项 FAIL** |
| M5 | BigInt 往返值被改小 1(模拟静默截断) | **第 4 项 FAIL** |
| M6 | 去掉 `REFERENCES` 子句(FK 无法生效) | **第 5 项 FAIL** |
| M7 | 去掉 savepoint 回滚 | **第 6 项 FAIL** |
| M8 | 触发器不再调用 UDF(INSERT 路径) | **第 7 项 FAIL** |
| M9 | 触发器不再调用 UDF(UPDATE 路径) | **第 7 项 FAIL** |
| M10 | BLOB 读回变成 base64 字符串 | **第 8 项 FAIL** |
| M11 | node 写完不 close(WAL 不落盘) | **第 9 项 FAIL,exit 1** |
| M12 | 覆写 SQLite 文件头(旧驱动打不开) | **第 9 项 FAIL,exit 1** |
| M13 | 把某项的两个比较来源塌缩成一个(退化成恒等式) | **第 0 项 FAIL** |

**12/12 全部变红**(`12/12 applied and detected`),每次回退后都恢复 `10/10`。
**最终文件与变异前逐字节一致。**

### 6.1 变异过程暴露的两个真实缺陷(已修)

**这才是变异证明的价值 —— 它找出了两个我自己写的假绿。**

1. **第 7 项原本测不到东西。**
   原实现里第 7 项的判据包含 `quickMatch`,而那是**第 3 项已经证明过的结论**;
   另一个值 `storedTitle` 被测出来了但**从未参与判定**。
   结果:把触发器里的 `fts_normalize()` 删掉,第 7 项**依然全绿**。
   已改为只断言第 7 项自己独有的 `proof` 数据库(INSERT / UPDATE 两条触发器路径 + `MATCH` 可达性)。

2. **第 3 项有两条查询只有跨驱动比较、没有手写字面量。**
   把跨驱动分支短路后第 3 项仍然全绿 —— 意味着那两条查询实际上只被测了一次。
   已给 4 条查询**全部**补上手写字面量。

### 6.2 一个"看起来该红但不该红"的记录(如实记)

| 注入 | 结果 | 解释 |
| --- | --- | --- |
| 在文件**末尾**追加垃圾字节 | **第 9 项仍绿** | SQLite 容忍尾部冗余字节,文件仍然可读。**不是探针漏检**,是这种损坏不构成"打不开" |
| 覆写**文件头**前 16 字节 | **第 9 项 FAIL** | 这才是真正的"旧驱动打不开" |
| 只放宽判据(如去掉 `!truncatedSilently`) | **第 9 项仍绿** | 放宽判据不等于驱动行为改变。**能测出回归的注入是伪造行为,不是放宽标准** |

---

## 7. 可复跑性

| 项 | 实测 |
| --- | --- |
| 连续两次 node 运行 | 均 `10/10`,`startedAt` 不同,结论相同 |
| 连续 node + Electron 运行 | 均 `10/10`,exit 0 |
| 临时目录残留(未变异) | **0** |
| 临时目录残留(变异导致句柄未关) | 7 个 —— **已改为 WARN 级别显式报告**,不再静默 |

> 变异期间出现的临时目录残留,原因是被注入的"不 close"回归让句柄保持打开,
> Windows 上 `rmSync` 因此失败。**未变异的正常路径不产生任何残留。**
> 该情况现在会打 WARN 日志并给出错误码,不再被 `safe()` 吞掉。

---

## 8. 与计划文档不一致的地方(逐条)

> 计划文档里的数字本轮**全部重新实测**。以下为不一致项。

| # | 计划文档写的 | 本轮实测 | 口径 |
| --- | --- | --- | --- |
| 1 | `DatabaseSync` **没有 `close()`** | **有,且是真关闭** | 推翻了 01 §0.2 / 01 §1.4 / README §2.2 的前提 |
| 2 | 「98 处 `db.close()` 会静默变成 no-op」 | **98 处仍然成立,但不会静默** —— 有真 `close()` 可用 | 计数口径:`git ls-files '*.ts' '*.tsx'` 中含 `better-sqlite3` 的文件里 `\bdb\.close\(\)` 的匹配数 |
| 3 | `.transaction(` **35 个文件** | **34 个文件** | 同上口径(`*.ts`/`*.tsx`,单文件计一次) |
| 4 | `.prepare(` 138 / `.exec(` 120 / `.close(` 157 | **139 / 129 / 163** | 同上口径 |
| 5 | `.pragma(` 51 / `.function(` 2 / `.serialize(` 1 | **51 / 2 / 1** ✓ 一致 | 同上口径 |
| 6 | 引用 better-sqlite3 的源文件 **177 个** | **162 个**(`*.ts`/`*.tsx`);含 `*.mjs`/`*.cjs`/`*.js` 则 **188 个** | 计划未说明是否含脚本文件 |
| 7 | FTS5 与 trigram **同时**涉及的文件 **12 个** | **交集 9 个,并集 12 个** | 计划把并集当成了交集 |
| 8 | ABI:需要按 runtime 换二进制 | **不需要**。137 与 149 同时加载同一份 N-API prebuild | 与 README「前提更正」一致,不是新结论 |
| 9 | 第 9 项「唯一必须立刻停」 | **成立,未触发** | — |

> **第 2–7 项的计数差异不影响本轮结论**(风险是量级判断,不是精确计数),
> 但既然本轮重新测了,就把口径和数字一起留档,避免下一个人再去猜。
> **没有任何一项是靠"计划文档说"来下的结论。**

### 8.1 一条需要下一轮注意的既有缺陷(顺带发现,未修)

`apps/desktop/src/main/db/schema.ts:575` 用
`db.prepare("SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'").get()`
来探测 FTS5。在 **better-sqlite3** 下这条查询会抛
`TypeError: Do not know how to serialize a BigInt`;
在 **node:sqlite** 下正常返回 `{ '1': 1 }`。
**换驱动后这条既有逻辑会从"抛错"变成"正常"** —— 属于行为变化,不是修复。
**本轮未改任何生产代码**,仅记录。

---

## 9. 门禁实测

| 门禁 | 命令 | 结果 | scope |
| --- | --- | --- | --- |
| 编码 | `npm run check:encoding` | **通过**,exit 0 | 全仓 tracked 文本文件 |
| 架构 | `npm run architecture:check` | **通过**,exit 0 | 全仓;932 条全部命中 baseline,**新增 0 条** |
| 类型 | `npm run typecheck:all` | **通过**,exit 0 | `src/` + 全部 workspace 包 |
| 探针(node) | `node scripts/sqlite-compat-probe.mjs` | **10/10**,exit 0 | 本文件 §2 |
| 探针(Electron) | `npx electron scripts/sqlite-compat-probe.electron.cjs` | **10/10**,exit 0 | 本文件 §2 |

> **架构门禁基线未被改写。** 新增两个 `scripts/` 文件**未产生任何新 finding**
> (变更前后均为 `total 932 / tolerated 932`)。

> **未运行根 `npm test`。** 该命令在本仓库不可靠(见 README §4.3),
> 本切片也没有改动任何被测试覆盖的代码路径,报告它只会引入一个不可判读的数字。

---

## 10. 给 Phase 1 的交接

**可以进 Phase 1。** 但兼容层必须显式处理这四件事,否则会以静默行为变化出现:

| # | 事项 | 依据 |
| --- | --- | --- |
| 1 | `close()` 直接映射到 `DatabaseSync.close()`,**不要写成空函数**,也不要依赖 GC | §3 |
| 2 | `close()` 重复调用会从静默变抛错,需要决定是否吞掉以保持旧行为 | §3 |
| 3 | BLOB 读回要包 `Buffer.from()`,否则 `Buffer.isBuffer()` 从 true 变 false | §4.1 |
| 4 | 超安全整数范围的行为要显式决策(抛错 / `setReadBigInts`),不要静默改语义 | §4.2 |

**UDF 每连接注册的约束不变**,不是本次迁移引入的(§4.3)。

**探针怎么复跑:**

```bash
node scripts/sqlite-compat-probe.mjs                          # 本地 node
npx electron scripts/sqlite-compat-probe.electron.cjs         # Electron 主进程
```

两者输出同一份 JSON(带 `@@SQLITE_COMPAT_PROBE_JSON_BEGIN@@` 哨兵),
**第 1 或第 9 项失败时 exit 非零**,可直接接进 CI。

---

## 11. 本轮做了什么 / 没做什么

**做了:**

- 新增 `scripts/sqlite-compat-probe.mjs`(探针本体,含探针自检项 0)
- 新增 `scripts/sqlite-compat-probe.electron.cjs`(Electron 主进程启动器)
- 本文件

**没有做(明确不做):**

- **没有写任何生产数据库代码**
- **没有修改任何 better-sqlite3 调用点**
- **没有碰 `scripts/architecture/`、`architecture-policy.yaml`、`packages/`**
- **没有改门禁基线**
- **没有 push,没有开 PR**
