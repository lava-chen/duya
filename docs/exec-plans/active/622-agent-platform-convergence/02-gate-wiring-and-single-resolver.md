# 02 — 两套解析器收敛 + 关键门禁接进 CI

状态：in progress · 负责人：Codex · 更新：2026-10-24
分支：`codex/622-02-gate-wiring` · worktree：`.claude/worktrees/622-02-gate-wiring`
base：`18a144e8ee25952cf19da3b45191cdc8a91e84bc` · owner：Codex
独占路径：`scripts/architecture/**`、`.github/workflows/test.yml`、`package.json` 的 script 行、`.architecture-baseline.json`、`docs/architecture/ARCHITECTURE_MAP.md`、本卡与 622 README 的状态记录

关联：[622 README](./README.md) · 前置：[01](01-import-graph-resolver.md)

---

## 目标与边界

**目标**：三件事合成一条线，因为它们是同一个问题的三个面：

1. **口径统一**：`audit-imports.mjs` 与切片图共用 workspace manifest 注册表和
   exports 读取函数；对共同扫描范围内的解析边，以 `(from, spec, to)` 多重集合逐条对账。
2. **门禁接线**：保留 PR #399 已接入 CI 的 `architecture:slice-graph`，新增
   `agent-retirement-gate` 的非增长门禁和 baseline 只减检查。
3. **豁免收缩**：`architecture:check` 的 baseline 里 **255 条已不再触发**的指纹要清掉，
   让"债务有多大"重新可见。

**边界**：

- **不改任何生产代码。** 只改 `scripts/architecture/**`、`.github/workflows/test.yml`、
  `package.json`（script 行）、`.architecture-baseline.json` 与层表事实源说明。
- **不加 baseline 指纹、不放宽断言换绿**（根 `AGENTS.md`）。
- 收缩 baseline 只允许**删**已不再触发的条目，**不许加**。
- 不改 `LAYERS` 层表（那是 [03](03-host-layer-verdict.md) / [04](04-remaining-unlayered-packages.md)）。
- 不动 610 的 `plan:sync` 追踪表。

---

## 验收

### 原始失败证据（2026-10-23，base `d9eb7dba`）

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

**当时跑它，红的形态是**：切片图算出的跨包边数（**0**）与 `audit-imports.mjs` 的
跨边界边数（**2593**）不相等 —— 断言里写的是 `expect(sliceCrossPackageEdges).toBe(auditCrossBoundaryEdges)`。

### PR #399 合并后的复核（2026-10-24，base `18a144e8`）

- `architecture:slice-graph` 已在 architecture job 执行。PR #399 加入的对账器比较共同
  `apps/` 与 `packages/` 范围内的已解析边：graph **2587**、audit **2587**、差异 **0**。
  audit 总数 **2593** 还包括 6 条 unresolved，不属于两边可逐条解析的集合。
- `agent-retirement-gate` 仍无 npm script，也未接进 CI。
- `architecture:check` 仍检查 **2608** 条，旧 baseline 有 **2785** 个指纹，其中 **255** 个已不再触发。
- 退役扫描为 **772** 条引用：production **19**、build tooling **86**、active config **13**、tests **654**；其中 **752** 条为确认引用，10 个 artifact selector 仍未验证。

### 验收命令与预期结果

```bash
# 1) 口径一致，两个调用方共用 manifest 注册表且边逐条一致
npx vitest run scripts/architecture/import-graph.test.ts scripts/architecture/workspace-packages.test.ts
npm run architecture:slice-graph
#    预期：2587 / 2587 个已解析三元组，tuple disagreements: 0

# 2) 门禁在 CI 里，并且已有 debt 不会让 CI 常红
npx vitest run scripts/architecture/architecture-ci-wiring.test.ts
npm run agent-retirement-gate
#    预期：772 current / 772 baseline / 0 new；状态仍可为 OPEN

# 3) 主门禁仍绿，且豁免只减不增
npm run architecture:check
#    预期：仍 "OK — no new boundary violations."；blocking 仍为 0
#    预期：baseline size 从 2785 降到 2530（= 2785 − 255）
npm run architecture:baseline-ratchet -- <base-sha>
#    预期：architecture 2785 -> 2530，255 removed，0 added

# 4) 边界门禁不被打破
npm run architecture:boundaries
#    预期：仍 "no new findings."；G1/G3/G4/G7/G8 known 0；G6 known 9；G9 known 5

# 5) 计划同步不被打破
npm run plan:sync
#    预期：plan-sync-check  OK
```

### 完成判据

- **口径**：同一个"跨包边"概念，两个工具给同一个数字。
  共同范围的 `(from, spec, to)` 多重集合完全相同；集合范围差异（如 6 条 unresolved）要明示。
- **接线**：切片图、退役引用 ratchet 和 baseline ratchet 在 CI 里执行；新增违规或豁免扩张会红。
- **收缩**：baseline 从 2785 降到 2530，**且没有新增任何指纹**。

### 变异证明（门禁卡必填）

- **变异 ①**：往 `packages/agent-protocol/src/index.ts` 加一行从 `@duya/agent-runtime` 的导入
  → `architecture:check` 必须红。当前 Host→Runtime 是 `duya-host` 明确声明的允许边，不能用它证明门禁拒绝违规。
  撤掉 → 绿。
- **变异 ②**：从 workflow 删除活跃的 `architecture:slice-graph` step → `architecture-ci-wiring.test.ts` 必须红。
- **变异 ③**：往 `.architecture-baseline.json` 加一条不存在的指纹 → `architecture:baseline-ratchet` 必须红。
  `architecture:check` 本身会忽略未触发指纹，因此只靠它不能证明 baseline 未被放宽。

---

## 进度

- [x] 共用 `workspace-packages.mjs` manifest 注册表和 `workspace-exports.mjs` exports 解析；保留 PR #399 的逐边对账
- [x] 保留 CI 中的 `architecture:slice-graph`；新增 `agent-retirement-gate` npm script 和 workflow step
- [x] 加入按总量与 scope 计数的退役 reference ratchet，已有 772 条不使 CI 常红
- [x] 加入 baseline ratchet，禁止架构指纹新增和退役计数增长
- [x] 从 architecture baseline 只删旧指纹 255 条，最终 **2530** 条；未加入 78 条新出现的 measurement-only 指纹
- [x] 跑验收命令和三组变异证明
- [x] 更新 `ARCHITECTURE_MAP.md`，指出 layer 表的执行门禁和唯一源文件

---

## 发现与决策

1. **共享解析事实源**：PR #399 修复了解析并加入逐边比较，但各自仍构建 package-name 注册表。
   本卡把 manifest name→package registry 抽到 `workspace-packages.mjs`，让两个解析器调用同一函数；
   `workspace-exports.mjs` 继续作为 exports 条件解析的共同实现。运行时比较器仍逐条检查两者结果。

2. **`architecture-policy.yaml` 的 `layers:` 块是装饰品，且它自己承认了。**
   文件在**仓库根**（不是 `scripts/architecture/`），`layers:` 在 `:78`。
   `:82-85` 的注释原文：「this line was DECORATIVE — `architecture-check.mjs`
   never reads the `layers:` block (verified: grepping it for `layer` returns zero matches)」。
   实测 `grep -n "layers" scripts/architecture/architecture-check.mjs` → **0 命中**。
   ⇒ **层表的唯一真实位置是 `scripts/architecture/boundary-gates.mjs:67-75`**，由
   `npm run architecture:boundaries` 执行。
   本卡与 [03](04-remaining-unlayered-packages.md) 都必须承认这一点；
   `ARCHITECTURE_MAP.md:49-50` 已经写对了，但同一文件 `:16` 的包数是错的
   （见 [10](10-retirement-and-doc-truth.md)）。
   ⇒ 决策：**不要**把 `layers:` 块接进主门禁（那是第三套口径）；
   **要**把它降级为注释，或者在它顶部加一行"本块不被任何工具读取"的显式标注。

3. **收缩 baseline 要保留旧集合的子集。**
   当前 `architecture-check --write` 重写会写入 2608 条指纹，其中有 78 条新出现的
   `module-dependency-permitted` measurement 项；该规则不阻塞，但把它们写进 baseline
   仍违反“只许删”的要求。本次以旧 baseline 与当前 findings 的交集生成 **2530** 条，
   只删除 255 条旧指纹、没有新增。`baseline-ratchet.mjs` 与 CI workflow 后续阻止任何新增。
   ⇒ 决策：**不要**顺手把 96 条 `module-dependency` / 14 条 `package-boundary-escape`
   的债务也"处理掉"——那是别的卡的事，且必须逐条修，不能靠重写 baseline。

4. **退役 gate 使用按 scope 计数 ratchet。**
   最新基线是 772 条（production 19 / build tooling 86 / active config 13 / test targets 654），
   其中 752 条确认引用、10 个 selector 未验证。默认 CI 只拦总数或任一 scope 增长，
   允许清理引用；`--strict` 仍保留作“退役闭合”验收。输出同时列出当前 OPEN debt 和新增数。

5. **`plan:sync` 已在 CI**，追踪表的 `done` 行需要具名测试和 commit 证据。
   PR #399 已合并，01 行和 02 行的状态更新均指向可复跑测试及提交；未完成卡继续保持 todo。

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
| `18a144e8` / base，未改 | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 · vitest 3.2.4 | `npm run architecture:check` | 0 | 检查 2608 / tolerated 2608 / baseline 2785 / **255** stale；无新违规 |
| `18a144e8` / base，未改 | 同上 | `node` retirement report summary | 0 | **772** references：19 / 86 / 13 / 654；752 blocking refs、10 unverified selectors |
| `18a144e8` + 02 | 同上 | `npm run architecture:slice-graph` | 0 | valueEdges **7739**；graph/audit 各 **2587** 个 resolved triples；disagreements **0** |
| `18a144e8` + 02 | 同上 | `npx vitest run scripts/architecture/agent-retirement-gate.test.ts scripts/architecture/baseline-ratchet.test.ts scripts/architecture/workspace-packages.test.ts scripts/architecture/architecture-ci-wiring.test.ts scripts/architecture/workspace-exports.test.ts scripts/architecture/import-graph.test.ts` | 0 | **6 files / 49 tests passed** |
| `18a144e8` + 02 | 同上 | `npm run architecture:check` | 0 | 检查 **2608** / tolerated **2608** / baseline **2530** / **0** stale / no new violations |
| `18a144e8` + 02 | 同上 | `npm run architecture:baseline-ratchet -- HEAD` | 0 | architecture **2785 → 2530** / 255 removed / 0 added；retirement baseline initialized at **772** |
| `18a144e8` + 02 | 同上 | `npm run agent-retirement-gate` | 0 | `OPEN` remains visible; **772 current / 772 baseline / 0 new** |
| `18a144e8` + 02 | Linux 6.18.55 x86_64 · Node v24.19.0 · npm 11.9.0 · isolated `npm ci` | `npm run typecheck:all` | 0 | 20 workspace packages built; all configured protocol, client-core, core, runtime, web, Electron, CLI, voice, eval typechecks passed; eval recorder **4/4** |
| `18a144e8` + 02 | 同上 | 变异 ①：`agent-protocol` 引用 `agent-runtime` | 1 | architecture check reported `forbidden-dependency` and `module-dependency`；源文件 SHA 恢复 |
| `18a144e8` + 02 | 同上 | 变异 ②：删掉活跃 slice-graph workflow step | 1 | `architecture-ci-wiring.test.ts` 失败；workflow 已恢复 |
| `18a144e8` + 02 | 同上 | 变异 ③：baseline 加不存在指纹 | 1 | baseline ratchet 报 `architecture additions=1`；baseline SHA 恢复 |

---

## 接续 / 结果

- **已实现 / 已验证**：共享 manifest registry、退役引用 ratchet、CI 接线和 baseline 收缩均完成；PR 尚未创建。
- **本地工作区**：`.claude/worktrees/622-02-gate-wiring`，分支 `codex/622-02-gate-wiring`。
- **基线变更**：`.architecture-baseline.json` 只删除 255 条旧指纹；baseline ratchet 证明新增为 0。
- **阻塞**：无。

**下一步**：提交分支并创建 PR，等待必需 review 和 CI。
**完成判据**：上述具名测试、architecture checks 与三组变异在 PR head 均通过；集成后重跑受影响门禁。

**回退**：只动 `scripts/architecture/**`、`.github/workflows/test.yml`、`package.json`
一行 script ⇒ 单提交 revert 即回原状。
**baseline 回退有额外要求**：若收缩了 baseline，回退提交必须**同时还原
`.architecture-baseline.json`**（该文件是 tracked 的），否则会留下"指纹被删"的假绿。
