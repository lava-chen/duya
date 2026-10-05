# 90 — 执行日志

> 每轮追加。**数字必须带 scope**(`<通过>/<总数> in <scope>`)。

---

## 2026-10-05 — 计划撰写轮

### 本轮性质

**纯计划文档。** 未改生产代码,未运行 typecheck / test / build,未执行门禁
(602 的门禁尚未写),未 commit 生产代码。

### 事实基线:`origin/master @ 46c36d9d`

在 worktree `.claude/worktrees/602-sqlite-abi` 上实测,分支
`docs/602-sqlite-abi`。共享检出零改动。

**601 的 PR #211 在本轮开始时仍为 OPEN**,未合。602 与 601 正交,互不阻塞。

### 实测清单

| # | 断言 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 仓库有 Rust 足迹吗 | `git ls-files` 匹配 `Cargo.toml` / `*.rs` | **0 个** |
| 2 | 依赖声明 | 读 `package.json` | `better-sqlite3 = ^13.0.3` |
| 3 | workspace 声明者 | 遍历 packages/apps 的 package.json | `packages/agent`、`packages/plugin-core`,各 `^13.0.3` |
| 4 | 引用文件数 | 逐文件 Select-String | **177 个** |
| 5 | ABI 同步脚本 | `(Get-Content).Count` | `scripts/ensure-sqlite-abi.mjs` **286 行** |
| 6 | `pre-` 钩子数 | 匹配 `package.json` 的 `"pre` | **11 个** |
| 7 | Electron 版本 | 读 package.json + node_modules | 声明 `^44.0.0`,实装 **44.2.0** |
| 8 | `node:sqlite` 可用性 | `node -e "require('node:sqlite')"` | **可用**,本地 node v24.16.0 |
| 9 | 导出符号 | 同上 | `DatabaseSync` `StatementSync` `Session` `constants` `backup` |

### API 使用面(按 `.ts` 文件计数,单文件内多次只计一次)

| API | 文件数 |
| --- | --- |
| `.close(` | 157(其中 `db.close()` **98**) |
| `.prepare(` | 138 |
| `.exec(` | 120 |
| `.pragma(` | 51 |
| `.transaction(` | 35 |
| `.function(` | 2 |
| `.serialize(` | 1 |
| `.aggregate(` | 0 |
| `.backup(` | 0 |

### 特性依赖

`fts5|FTS5|trigram` 匹配 **12 个文件**(两者高度重合),`json_extract` 1 个,`json_each` 0 个。

---

## 本轮推翻的两个结论

### ① 上一轮给的路线 A 建议是错的

上一轮我把路线 A 描述为「`better-sqlite3` → **napi-rs + rusqlite**」。

**错。** N-API 解决的是 **ABI 稳定性**,不是"要不要发二进制"。
Node 文档原文:Node-API "is ABI stable across versions of Node.js",
但 add-on 仍需**按平台/架构分别编译**。

目标是"删掉整条打包链路",那答案就是 **`node:sqlite`** ——
它编译进 Node 运行时,**根本不是原生模块**。

> **推翻了 Rust 路线,也顺带回答了"要不要引入 Rust"这个问题:**
> 这一个痛点不需要 Rust。引入 Rust 只是把"要发二进制"
> 换成"要发二进制 + 要维护 Cargo 构建"。

### ② `Measure-Object -Line` 又踩了一次(修正后写法)

测脚本行数时用了 `Get-Content | Measure-Object -Line`,得到 266 —— **与 `.Count` 的 286 不符**。
交叉验证时发现该 cmdlet **把空行计为 0**。

> 这是本会话第二次遇到(第一次在 601 的 `cli-api-server.ts` 979→841)。
> 正确写法:`(Get-Content $f).Count`。
> 这次是**当场对账才发现的** —— 若不做交叉验证,266 会带着"实测"的标签进计划。
>
> **已在本文件固定使用 `.Count`。**

### ③ 对账机制本轮失效:602 里一个 `path:line` 引用都没有

沿用 601 的对账脚本(提取 `` `path:line` `` 并与真实文件比对),跑出来:

```
=== unique refs: ok=0  bad=0 ===
```

**`ok=0` 不是"全部通过",是"什么都没检查到"。** 601 有 44 条引用,对账
抓到过 `Measure-Object` 的错数字;602 一条都没有,说明**引用式没命中**。

**根因:602 写的是结论型计划**(依赖怎么换、语义风险在哪),引用的是
§2.2 那种汇总表,不是具体行号。这在 602 是合理的表达方式。

> **但它带来一个真实的风险:没有 `path:line`,就没有可机器对账的锚点,
> 汇总表里的数字就只能靠人相信。** 而人刚才已经错了 4 次。

**因此改用另一道检查:把 §2 的 9 个关键数字逐个当场重测。**

### ④ 重测抓到 4 处数字错误

| # | 计划里写的 | 实测 | 错因 |
| --- | --- | --- | --- |
| 1 | `db.close()` **98 次** | **73** | 用了"变量名恰好是 db"的粗匹配,把 `memoryDb.close()` 等也算进去了 |
| 2 | 脚本 **266 行** | **286** | 又是 `Measure-Object -Line`(见 ②) |
| 3 | `pre-` 钩子 **11 个** | **14** | 我数的是"调 ABI 脚本的",漏了另外 3 个 `pre-` |
| 4 | FTS5 11 / trigram 10 | **合计 12** | 把两个条件的**并集**当成了各自的数字 |

**四处全部已修正。**

> **这一轮的核心教训:数字错误的来源不是"没测",是"测了就信"。**
> 4 个数字全部来自真实执行 —— 没有一个是编造的。
> 但其中 3 个的**度量方式或口径本身是错的**。
>
> **看起来是实测的错数字,比明显的假数字危险得多** ——
> 它带着"已验证"的权威感进入计划,然后被人引用成基线。
> 这与 600 记的 `vacuous-guard-tells` 是同一类:
> **报告了事实,但那个事实没有回答你以为它回答的问题。**
>
> **How to apply:**
> - 数字必须**当场重测**,不能从上一轮对话记忆里抄(我确实是这么错的)
> - 计数类断言要写清**口径**(是"调 X 的钩子"还是"所有 X 钩子")
> - 同一量**用两种方式测一次**,不一致时查为什么矛盾
> - 差异本身是线索,不该被解释掉(601 的 841 vs 931 也是这么发现的)

---

## 外部事实核实(带来源)

| 断言 | 来源 |
| --- | --- |
| Electron 44.2.0 内置 Node v24.20.0 | [releases.electronjs.org](https://releases.electronjs.org/release/v44.2.0) |
| Node-API ABI 稳定但仍需按平台编译 | [Node 文档](https://nodejs.org/download/release/v25.6.0/docs/api/n-api.html) |
| `node:sqlite` 需 Node ≥ 22.5.0,带 FTS5 / JSON 函数 | [photostructure 特性矩阵](https://github.com/photostructure/node-sqlite/blob/master/doc/library-comparison.md) |
| `node:sqlite` 与 better-sqlite3 性能互有胜负 | [photostructure 基准](https://github.com/photostructure/node-sqlite/blob/master/benchmark/README.md) |

**Electron 44 = Node 24.20.0 远高于 22.5 的门槛,是整个计划成立的前提。**
若日后 Electron 大版本回退到 Node 22.5 以下,本计划的前提消失。

---

## 未决

| # | 问题 | 归属 |
| --- | --- | --- |
| 1 | **`DatabaseSync` 没有 `close()`,而 `db.close()` 被调 73 次。** 会静默变成 no-op | **Phase 0 第 1 项** |
| 2 | trigram tokenizer 是否支持 | Phase 0 第 2 项 |
| 3 | FTS5 `MATCH` 结果集是否与现驱动一致 | Phase 0 第 3 项 |
| 4 | INTEGER 超 `MAX_SAFE_INTEGER` 的行为 | Phase 0 第 4 项 |
| 5 | 新驱动写的文件 better-sqlite3 能否打开(**唯一不可逆风险**) | Phase 0 第 9 项 |
| 6 | `.function()` 能否在 FTS5 触发器/索引表达式中调用 | Phase 0 第 7 项 |
| 7 | 根 `npx vitest run` 在本仓库不确定,需先测出可信 baseline | Phase 3 |
| 8 | PR #211(601)未合,602 与其正交 | 不影响 602 |

> **第 1 项与第 5 项是可能推翻整个计划的两项。**
> 第 1 项有替代方案(评估后可能终止计划);
> **第 5 项没有替代 —— 它涉及用户数据文件的可读性。**

---

## 门禁实测

**本轮无。** 602 的 5 条门禁(S1–S5)尚未写,状态见
[README §4](README.md#4-门禁)全部"待做"。

**Phase 0 的探针脚本就是本系列第一个门禁载体** ——
它必须可复跑,而不是一次性手动验证。

---

## 下一步

[01 §0.1](01-migration-map.md#01-唯一-next-action):写探针脚本
`scripts/sqlite-compat-probe.mjs`,**在本地 node 与 Electron 主进程两个运行时**
里跑完 §0.2 的 9 项,输出结构化结果。
