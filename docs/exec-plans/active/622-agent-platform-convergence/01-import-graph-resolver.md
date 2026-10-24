# 01 — 修 `import-graph` 的裸 `@duya/*` 解析

状态：completed（merged） · 负责人：lava-chen · 更新：2026-10-24
分支：`codex/622-01-import-graph-resolver` · PR：[#399](https://github.com/lava-chen/duya/pull/399)（已合并）
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：lava-chen（Codex 续接）

关联：[622 README](./README.md) · 根因记录在 [610 T19](../610-architecture-series/19-fast-track-queue.md)（**不重述**）

---

## 目标与边界

**目标**：`scripts/architecture/import-graph.mjs` 的 `resolveTarget` 能解析裸 `@duya/*` 说明符，
使 `architecture:slice-graph` 产出的图里出现跨包边。

**用户能观察到什么变化**：`npm run architecture:slice-graph` 的输出多出跨包维度，
且该数字与 `audit-imports.mjs` 的同一事实一致。

**边界**：

- 只改**切片图这一条测量链**（`import-graph.mjs` → `slice-cut-list.ts` → `slice-classification.ts`）。
- **不改** `architecture:check` 的判定（那是 [02](02-gate-wiring-and-single-resolver.md)）。
- **不改** `audit-imports.mjs`——它已经是正确的那个（按各包 `package.json` 的 `name`/`exports` 建注册表，
  `audit-imports.mjs:74` 起）。本卡是让切片图**追上**它，不是反过来。
- **不改** `boundary-gates.mjs` 的层表（那是 [03](03-host-layer-verdict.md)）。
- 不动 `packages/agent-protocol/test/02-cycle-budget.test.ts` 的**断言意图**——
  只允许因 SCC 计数真实变化而更新数字，不允许放宽断言。

**关联**：T19 已完整记录根因（`resolveTarget` 把 `@duya/<rest>` 映射到 `packages/<rest 第一段>`，
**子路径被丢弃不是拼接**；本仓没有任何包在根目录放 `index.ts`）。
本卡**只补执行细则与验收**，不重复根因论证。

---

## 验收

### 修复前的失败形态（基线）

**修复前的失败形态**：`scripts/architecture/import-graph.test.ts` 里
**没有任何一条**针对裸 `@duya/*` 的用例——该文件现有的 `resolveTarget` 断言只有两条，
都是**相对路径**（`:231` 解析 `./index.js`、`:236` 断言不存在的路径返回 `null`）。
所以基线对这条缺陷**没有会红的用例**。

第一条必须先写的用例：

```text
scripts/architecture/import-graph.test.ts
  it('resolves a bare @duya specifier to the file that declares it', ...)
```

**基线预期红的形态**：断言 `resolveTarget('@duya/agent-protocol', 'packages/host/src/x.ts')`
应返回 `packages/agent-protocol/src/index.ts`，**实际返回 `null`**。

**全量证据**（2026-10-23 实测，`d9eb7dba`）：

- 唯一 `@duya/*` 说明符 **755 个**，`resolveTarget` 返回 `null` 的 **755 个**，命中的 **0 个**。
- 仓库里**没有任何包**在根目录放 `index.ts`（`ls packages/*/index.ts` → No such file）；
  20/20 个包都是 `packages/<pkg>/src/index.ts`。
- 裸 `@duya/*` 的 import 出现总次数：**3178**（tracked、非 `dist/`/`bundle/`）。

### 验收命令与预期结果

```bash
# 基线返回 null 的证据见上；变异 ① 验证候选缺失会让同一根断言失败
npx vitest run scripts/architecture/import-graph.test.ts
# PR CI：26/26 passed

npx vitest run scripts/architecture/slice-cut-list.test.ts
# PR CI：18/18 passed

npx vitest run scripts/architecture/slice-classification.test.ts
# PR CI：30/30 passed

npm run architecture:slice-graph
# PR CI：valueEdges 7729；共同范围 2587 条 cross-owner triples 与 audit-imports 一致，差异 0
```

### 完成判据

**不是"新边出现了"，是"测完并逐条更新声明"**（T19 已写明，本卡继承）。

resolver 一动，下列声明必须**逐条重测并更新**，不能留旧数字：

- `slice-cut-list.ts` 的每条 `edges` 与 `CUT_LIST_INVARIANTS.requiredPairs`
  （`main-to-agent-value` 旧 `cut` 曾把另外 59 条列为未知；现已更新为它们改写到其他包，主进程到 workspace 的 337 条边由图可见）。
- `slice-classification.ts:45` 的 owner 分类：已重测，分类规则按路径判定，本次 resolver 变化不改变 owner 值。
- `packages/agent-protocol/test/02-cycle-budget.test.ts` 的 SCC 计数与 `audit-modules.mjs` 交叉校验：全量 Vitest 通过，断言不需改数。

### 变异证明（门禁卡必填）

- **变异 ①（自动化）**：在隔离 fixture 中复制 resolver 和依赖，删除 `src/index.ts` 候选；复用裸包根断言后必须抛错。临时副本在 `finally` 中删除，并核对仓库 resolver 的 SHA-256 前后相同。
- **变异 ②（自动化）**：把 `main-to-agent-value.edges` 在内存副本改回历史失真值 60；相同的 whole-pair mismatch 检查必须报告 `{ stated: 60, measured: 1 }`。真实声明仍为 1。
- 变异不写入仓库源文件；① 的临时树清理后，原 resolver SHA-256 保持不变，② 只修改内存对象。

---

## 进度

- [x] 写裸 `@duya/*` 根与子路径用例；变异 ① 证明移除 `src/index.ts` 候选会令相同根断言失败
- [x] 给 `resolveTarget` 加候选：`packages/<pkg>/src/index.ts`、
      `packages/<pkg>/src/<subpath>.ts`、`packages/<pkg>/src/<subpath>/index.ts`
      ——**按子路径拼接，不是按第一段**
- [x] 用 `audit-imports.mjs` 的 `exports` 映射做**权威回退**：
      读各包 `package.json` 的 `exports`，把 `.` 与 `./<sub>` 映射到 `./src/...`
      （`audit-imports.mjs:165` 的 `workspaceExportTargets` 已有这个形状，可直接复用而不是重写）
- [x] 重测 cut-list、分类与 SCC 交叉校验；边数声明保持实测的 28 / 1，分类和 SCC 计数未变化
- [x] 跑 §验收命令；CI 全量 Vitest、架构门禁、typecheck 和 build 均通过
- [x] 变异 ① ② 均通过；只改临时副本或内存数据，工作树源文件 SHA-256 不变

---

## 发现与决策

1. **`resolveTarget` 的注释已经写着它应该做什么**（`:275-278`：候选表"mirrors
   `audit-imports.mjs:resolveFile`"）。也就是说这不是"缺少设计"，是**实现与自己的注释不符**——
   注释说镜像，`audit-imports.mjs` 用 `exports` 映射，实现只试了 `<pkg>.ts` / `<pkg>/index.ts`。
   ⇒ 修法是**让实现追上注释**，不是重新设计解析策略。

2. **`dist/` 的孪生路径救不回来**（T19 已写）：`distToSourceTwin`（`:322-326`）只在
   **候选已经构造出来之后**才参与孪生；`packages/<pkg>/dist` 不是候选之一，
   所以 `dist` 写法不参与候选构造，救不回来。

3. **不要用"再加一条候选"的最小补丁**。755/755 全 null 说明候选表整体缺失，
   不是缺一条。最小补丁的形状是：**把 `audit-imports.mjs` 的包注册表
   （`name` + `exports`）搬进 `import-graph.mjs`**，两边共用一份。
   这也顺带为 [02](02-gate-wiring-and-single-resolver.md) 的"两套解析器收敛"打底——
   **本卡是那件事的前半段**。

4. **T18 的失败形态已过期，不要按它写预期**。T18 记录 `slice-classification.test.ts`
   在 2026-10-20 是 `8 failed | 22 passed`；但 `c62fdf60`（2026-10-23，删死规则）与
   `1ce23ce3`（对齐 census）已把它修绿。**今天实测 30/30 passed**。
   ⇒ 本卡的下游声明以**今天实测的绿**为起点，不是 T18 记录的红。

5. **本卡不动 `architecture:check`**。`architecture:check` 走 `audit-imports.mjs`
   （`architecture-check.mjs:260`），本来就看得见 `@duya/*`；它的问题是**豁免**
   （[02](02-gate-wiring-and-single-resolver.md)），不是**解析**。两件事混在一起会
   让"改了解析器"和"改了门禁判定"互相掩护。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 · vitest 3.2.4 | `node scripts/architecture/import-graph.mjs` + 自写探针扫描 tracked 源文件 | 0 | 唯一 `@duya/*` 说明符 **755**；`resolveTarget` → `null` **755**；命中 **0** |
| `d9eb7dba` / 干净 | 同上 | `ls packages/*/index.ts` | 1（No such file） | 无包在根目录放 `index.ts`；`packages/*/src/index.ts` 命中 **20/20** |
| `d9eb7dba` / 干净 | 同上 | `git ls-files '*.ts' '*.tsx' '*.mts' '*.js' '*.mjs'` \| grep -v `/dist/` \| xargs `grep -oh "@duya/[^'\"]*"` | 0 | 裸 `@duya/*` 出现总次数 **3178** |
| `d9eb7dba` / 干净 | 同上 | `npx vitest run scripts/architecture/slice-cut-list.test.ts` | 0 | 1 file / **16 passed** |
| `d9eb7dba` / 干净 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts` | 0 | 1 file / **30 passed** |
| `9837f576` / PR merge tree `b2a56a39` | GitHub Actions · Ubuntu 26.04.1 · Node v22.23.3 · npm 10.9.9 | 全量 Vitest（workflow unit scope: full） | 0 | **1132** test files passed / 2 skipped；**12761** passed / 2 expected fail / 21 skipped；import-graph 26、slice-cut-list 18、slice-classification 30 passed；变异 ① ② 的自动证明通过 |
| `9837f576` / PR merge tree `b2a56a39` | 同上 | `npm run architecture:slice-graph`（含 `compare-import-graphs.mjs`） | 0 | graph valueEdges **7729**；共同扫描范围 cross-owner triples **2587**，audit-imports resolved triples **2587**，tuple disagreements **0**；audit 总 cross-boundary **2593**（另含 6 条 unresolved） |
| `9837f576` / PR merge tree `b2a56a39` | 同上 | `npm run architecture:check`、架构 self-test / boundary gates、typecheck、build | 0 | architecture、typecheck、build jobs 全部 success（Actions run [39991011384](https://github.com/lava-chen/duya/actions/runs/39991011384)） |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：PR #399 于 2026-10-24 合并，merge commit `bb87d484ddac4dfd3e2d2413973402b0a38f1c03`；解析器、回归测试、逐条对账和两项变异证明已完成。
- **未提交路径**：无。
- **副作用**：无；变异只在临时 fixture 和内存中进行。
- **阻塞**：无。
- **回收**：无临时文件遗留。

**完成判据**：新解析器的根/子路径/exports 回退用例通过；cut list 与分类声明对齐当前扫描；共同文件范围内 `(from, spec, to)` 三元组与 `audit-imports` 完全相等；变异 ① ② 都能击中相同断言。所有验收均在 PR CI 通过。

**回退**：本卡动 `scripts/architecture/**`、`package.json`、`.github/workflows/test.yml` 与本计划文件；
无生产代码、无数据迁移、无 schema 变更 ⇒ revert 本卡提交即可回原状。
若以后把新边写进 baseline，回退时也要还原 baseline，不能遗留新指纹（根 `AGENTS.md`）。
