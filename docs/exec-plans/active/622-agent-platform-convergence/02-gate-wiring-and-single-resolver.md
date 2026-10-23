# 02 — 两套解析器收敛 + 关键门禁接进 CI

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-02-gate-wiring`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[01](01-import-graph-resolver.md)

---

## 目标与边界

**目标**：三件事合成一条线，因为它们是同一个问题的三个面：

1. **口径统一**：`architecture:check`（`audit-imports.mjs`）与切片图
   （`import-graph.mjs`）对"什么是一条跨包边"给出**同一个答案**。
   两套解析器并存时，两份数字不能互相印证——**它们今天给的是两个世界**。
2. **门禁接线**：`architecture:slice-graph` 与 `agent-retirement-gate` 进 CI，
   停止下来会红。
3. **豁免收缩**：`architecture:check` 的 baseline 里 **255 条已不再触发**的指纹要清掉，
   让"债务有多大"重新可见。

**边界**：

- **不改任何生产代码。** 只改 `scripts/architecture/**`、`.github/workflows/test.yml`、
  `package.json`（script 行）。
- **不加 baseline 指纹、不放宽断言换绿**（根 `AGENTS.md`）。
- 收缩 baseline 只允许**删**已不再触发的条目，**不许加**。
- 不改 `LAYERS` 层表（那是 [03](03-host-layer-verdict.md) / [04](04-remaining-unlayered-packages.md)）。
- 不动 610 的 `plan:sync` 追踪表。

---

## 验收

### 首个失败证据（今天长什么样）

三条，全部实测于 `d9eb7dba`：

**(a) 两个关键门禁不在 CI。**

```bash
grep -c "architecture:slice-graph" .github/workflows/test.yml   # → 0
grep -c "agent-retirement-gate"  .github/workflows/test.yml     # → 0
```

CI 实际跑的 `npm run` 全集（`grep -rhoE 'npm run [a-z:-]+' .github/workflows/`）：

```
architecture:boundaries  architecture:browser-closure  architecture:check
architecture:client-closure  architecture:headless  architecture:self-test
bundle:verify  bundle:worker  ci:test-scope  electron:build  electron:pack:mac
plan:sync  test:e  test:rules  typecheck:all
```

⇒ `architecture:slice-graph` 与 `agent-retirement-gate` **都不在**。

**(b) `architecture:slice-graph` 是 npm script，但不在 CI。**
`package.json:70` 有 `"architecture:slice-graph": "node scripts/architecture/import-graph.mjs"`，
所以它**能被人手动跑**，但没有任何东西在 PR 上跑它。
⇒ 审计原话「两个关键门禁不在 CI，也不在 npm scripts」**只对 `agent-retirement-gate` 成立**；
`architecture:slice-graph` 在 npm scripts 里。**本卡以实测为准。**

**(c) `architecture:check` 100% 豁免。**

```
$ npm run architecture:check
=== architecture boundary check ===
cycle                            1
module-dependency               96
module-dependency-permitted   2497
package-boundary-escape         14
total                         2608
tolerated (baselined)         2608
baseline size                 2785

255 baseline fingerprint(s) no longer triggered. Re-record with --write to shrink the debt.

OK — no new boundary violations.
```

- 检测 **2608** / tolerated **2608** / blocking **0**。
- baseline **2785** 条指纹，其中 **255** 条已不再触发。
- 96 条 `module-dependency` + 14 条 `package-boundary-escape` 债务整体被 grandfathered。

**本卡必须先写的用例**：

```text
scripts/architecture/slice-graph-gate.test.ts   （新建）
  it('the slice graph and the import audit agree on how many cross-package edges exist')
```

**今天跑它，红的形态是**：切片图算出的跨包边数（**0**）与 `audit-imports.mjs` 的
跨边界边数（**2593**）不相等 —— 断言里写的是 `expect(sliceCrossPackageEdges).toBe(auditCrossBoundaryEdges)`。

### 验收命令与预期结果

```bash
# 1) 口径一致
npx vitest run scripts/architecture/slice-graph-gate.test.ts
#    预期：1/1 passed —— 两套数字相等

# 2) 门禁在 CI 里
grep -c "architecture:slice-graph" .github/workflows/test.yml     # 期望 ≥ 1
grep -c "agent-retirement-gate"  .github/workflows/test.yml       # 期望 ≥ 1

# 3) 主门禁仍绿，且豁免收缩
npm run architecture:check
#    预期：仍 "OK — no new boundary violations."；blocking 仍为 0
#    预期：baseline size 从 2785 降到 2530（= 2785 − 255）

# 4) 边界门禁不被打破
npm run architecture:boundaries
#    预期：仍 "no new findings."；G1/G3/G4/G7/G8 known 0；G6 known 9；G9 known 5

# 5) 计划同步不被打破
npm run plan:sync
#    预期：plan-sync-check  OK
```

### 完成判据

- **口径**：同一个"跨包边"概念，两个工具给同一个数字。
  差异只允许来自**集合定义**（如 type-only 边是否计入），且差异必须被**写进断言**，
  不允许"差不多"。
- **接线**：两道门禁在 CI 里**真的会红**（往里塞一个违规 → job 失败 → 撤掉 → 恢复绿）。
- **收缩**：baseline 从 2785 降到 2530，**且没有新增任何指纹**。

### 变异证明（门禁卡必填）

- **变异 ①**：往 `packages/host/src/` 里加一行 `import { x } from '@duya/agent-runtime'`
  → `architecture:check` 必须红（如果它不红，说明它压根没在看这条边）。
  撤掉 → 绿。
- **变异 ②**：把 `architecture:slice-graph` 从 workflow 里删掉 → CI 必须不再跑它
  （证明接线是**真的**而不是注释里的）。
- **变异 ③**：往 baseline 里**加**一条不存在的指纹 → `architecture:check` 必须红
  （证明"只许删不许加"这条契约本身有牙齿）。

---

## 进度

- [ ] 写 `slice-graph-gate.test.ts`，确认红（数字 0 vs 2593）
- [ ] 让 `import-graph.mjs` 复用 `audit-imports.mjs` 的包注册表
      （[01](01-import-graph-resolver.md) 已铺路），两个工具给同一个数字
- [ ] 在 `.github/workflows/test.yml` 的 `architecture` job 里加
      `npm run architecture:slice-graph` 与 `node scripts/architecture/agent-retirement-gate.mjs`
- [ ] 给 `agent-retirement-gate` 加 npm script 入口（现在它**没有**）
- [ ] 用 `--write` **只删**已不再触发的 255 条指纹，**复核 diff 里没有新增**
- [ ] 跑 §验收 的 5 组命令 + 3 组变异
- [ ] 更新 `docs/architecture/ARCHITECTURE_MAP.md` 里"层表在哪"的描述（口径变了）

---

## 发现与决策

1. **两套解析器的口径差不是"谁更对"的问题，是"谁被信"的问题。**
   `architecture-check.mjs:260` 跑 `audit-imports.mjs`（按 `package.json` 的
   `name`/`exports` 建注册表）⇒ `@duya/*` 在主门禁里**看得见**；
   `import-graph.mjs` 的 `resolveTarget` ⇒ 看不见。
   **同一个仓库、同一个概念、两个答案。**
   ⇒ 裁决：**切片图必须复用主门禁的注册表**，不许维护第二份解析逻辑。
   这是 [01](01-import-graph-resolver.md) 的后半段在本卡落地。

2. **`architecture-policy.yaml` 的 `layers:` 块是装饰品，且它自己承认了。**
   文件在**仓库根**（不是 `scripts/architecture/`），`layers:` 在 `:78`。
   `:82-85` 的注释原文：「this line was DECORATIVE — `architecture-check.mjs`
   never reads the `layers:` block (verified: grepping it for `layer` returns zero matches)」。
   实测 `grep -n "layers" scripts/architecture/architecture-check.mjs` → **0 命中**。
   ⇒ **层表的唯一真实位置是 `scripts/architecture/boundary-gates.mjs:67-75`**。
   本卡与 [03](04-remaining-unlayered-packages.md) 都必须承认这一点；
   `ARCHITECTURE_MAP.md:49-50` 已经写对了，但同一文件 `:16` 的包数是错的
   （见 [10](10-retirement-and-doc-truth.md)）。
   ⇒ 决策：**不要**把 `layers:` 块接进主门禁（那是第三套口径）；
   **要**把它降级为注释，或者在它顶部加一行"本块不被任何工具读取"的显式标注。

3. **收缩 baseline 是一次性动作，不是持续动作。**
   `architecture-check.mjs` 的 `--write` 会把当前全部 finding 重写进 baseline。
   本卡只允许用它**删**已失效的 255 条 ⇒ 执行后**必须逐行看 diff**，
   确认只有删除、没有新增。任何一行新增 = 违规被洗白 = 立刻回退。
   ⇒ 决策：**不要**顺手把 96 条 `module-dependency` / 14 条 `package-boundary-escape`
   的债务也"处理掉"——那是别的卡的事，且必须逐条修，不能靠重写 baseline。

4. **两道门禁进 CI 的失败形态要事先想清楚。**
   `agent-retirement-gate` 今天输出 `agent-retirement: OPEN`（770 处引用）。
   若直接把它的原始输出接进 CI，**它会立刻红**——而这是**既有债**，不是新回归。
   ⇒ 决策：门禁的 CI 形态必须是**"相对基线不前进"**而不是"必须为零"：
   把 770 处引用做成**计数基线**（或指纹基线），门禁只拦**新增**，
   并在输出里打印"距退役还差 N 处"。这与 `architecture:check` 的
   "只拦新增违规"是同一形状，可以复用它的 fingerprint 机制。
   **这是本卡最容易做错的一步**：不加区分地把一个 OPEN 门禁接进 CI，
   等于把 CI 变红一次然后所有人都不看它。

5. **`plan:sync` 已经在 CI 里**，且它是本系列追踪表格式的强制者
   （610 §4 规则 4：状态只认具名测试 + commit）。
   ⇒ 本系列追踪表里的每个 `done` 行都必须能被 `plan-sync-check --strict` 校验。
   **当前本系列所有行都是 `todo`，不触发校验**——这是对的。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `grep -c "architecture:slice-graph" .github/workflows/test.yml` | 1 | **0** 命中 |
| `d9eb7dba` / 干净 | 同上 | `grep -c "agent-retirement-gate" .github/workflows/test.yml` | 1 | **0** 命中 |
| `d9eb7dba` / 干净 | 同上 | `grep -rhoE 'npm run [a-z:-]+' .github/workflows/ \| sort -u` | 0 | 15 个 npm run；两道门禁均不在其中 |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:check` | 0 | 检测 **2608** / tolerated **2608** / blocking **0** / baseline **2785** / **255** 条已失效 / `OK — no new boundary violations.` |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:boundaries` | 0 | G1/G3/G4/G7/G8 known **0** new **0**；G6 known **9**；G9 known **5** → `no new findings.` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "layers" scripts/architecture/architecture-check.mjs` | 1 | **0** 命中（`architecture-policy.yaml:82-85` 自述的装饰性属实） |
| `d9eb7dba` / 干净 | 同上 | `npm run plan:sync` | 0 | `plan-sync-check  16 done rows · 28 file refs · 14 test-name refs` → `OK` |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：无。

**下一步**：认领本卡，先做第一步——写 `slice-graph-gate.test.ts` 的
`it('the slice graph and the import audit agree on how many cross-package edges exist')`，
确认它红，且红的信息是 `0 !== 2593`。
**完成判据**：该用例在 base 上红、在 [01](01-import-graph-resolver.md) 落地后绿。

**回退**：只动 `scripts/architecture/**`、`.github/workflows/test.yml`、`package.json`
一行 script ⇒ 单提交 revert 即回原状。
**baseline 回退有额外要求**：若收缩了 baseline，回退提交必须**同时还原
`.architecture-baseline.json`**（该文件是 tracked 的），否则会留下"指纹被删"的假绿。
