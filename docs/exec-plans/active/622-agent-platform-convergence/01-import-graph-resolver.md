# 01 — 修 `import-graph` 的裸 `@duya/*` 解析

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-01-import-graph-resolver`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

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

### 首个失败证据（今天长什么样）

**今天的失败形态**：`scripts/architecture/import-graph.test.ts` 里
**没有任何一条**针对裸 `@duya/*` 的用例——该文件现有的 `resolveTarget` 断言只有两条，
都是**相对路径**（`:231` 解析 `./index.js`、`:236` 断言不存在的路径返回 `null`）。
所以这条缺陷今天**连一个会红的用例都没有**。

第一条必须先写的用例：

```text
scripts/architecture/import-graph.test.ts
  it('resolves a bare @duya specifier to the file that declares it', ...)
```

**今天跑它，红的形态是**：断言 `resolveTarget('@duya/agent-protocol', 'packages/host/src/x.ts')`
应返回 `packages/agent-protocol/src/index.ts`，**实际返回 `null`**。

**全量证据**（2026-10-23 实测，`d9eb7dba`）：

- 唯一 `@duya/*` 说明符 **755 个**，`resolveTarget` 返回 `null` 的 **755 个**，命中的 **0 个**。
- 仓库里**没有任何包**在根目录放 `index.ts`（`ls packages/*/index.ts` → No such file）；
  20/20 个包都是 `packages/<pkg>/src/index.ts`。
- 裸 `@duya/*` 的 import 出现总次数：**3178**（tracked、非 `dist/`/`bundle/`）。

### 验收命令与预期结果

```bash
# 1) 新增用例先红
npx vitest run scripts/architecture/import-graph.test.ts
#    预期（修前）：新增用例红，失败信息指向返回值 null

# 2) 修后绿，且旁边两条不许坏
npx vitest run scripts/architecture/import-graph.test.ts
#    预期：全部 passed

# 3) 下游不许坏
npx vitest run scripts/architecture/slice-cut-list.test.ts
#    预期：16/16 passed（今天实测 16/16）

npx vitest run scripts/architecture/slice-classification.test.ts
#    预期：30/30 passed（今天实测 30/30）

# 4) 图里出现跨包边，且数字与正确解析器一致
npm run architecture:slice-graph
#    预期：新增跨包维度，跨包 value 边 > 0

node scripts/architecture/audit-imports.mjs | sed -n '/cross-boundary edges/p'
#    预期：cross-boundary edges 2593（今天的真值），两边的跨包数字必须对得上
```

### 完成判据

**不是"新边出现了"，是"测完并逐条更新声明"**（T19 已写明，本卡继承）。

resolver 一动，下列声明必须**逐条重测并更新**，不能留旧数字：

- `slice-cut-list.ts` 的每条 `edges` 与 `CUT_LIST_INVARIANTS.requiredPairs`
  （其中 `main-to-agent-value` 现在的 `cut` 字段写着"另外 59 条是否真的消失要等
  `resolveTarget` 学会这个解析才能回答"——**本卡就是那个答案的产出点**）。
- `slice-classification.ts:45` 的 owner 分类（现在看不见跨包边）。
- `packages/agent-protocol/test/02-cycle-budget.test.ts` 的 SCC 计数，
  以及它对 `audit-modules.mjs` 的交叉校验断言。

### 变异证明（门禁卡必填）

- **变异 ①**：候选表建好后，删掉 `packages/<x>/src/index.ts` 那一条
  → 新增用例**必须红**。
- **变异 ②**：`main-to-agent-value` 的声明边数必须**退回今天的失真值**
  （证明这条断言今天靠"少算"通过，不是靠"算对"通过）。
- 还原后按字节校验（SHA-256 逐字节回原值），**共享检出上的脏文件一律不走 `git checkout --`**。

---

## 进度

- [ ] 写 `import-graph.test.ts` 的裸 `@duya/*` 用例，确认红（失败形态是返回值 `null`，不是"文件不存在"）
- [ ] 给 `resolveTarget` 加候选：`packages/<pkg>/src/index.ts`、
      `packages/<pkg>/src/<subpath>.ts`、`packages/<pkg>/src/<subpath>/index.ts`
      ——**按子路径拼接，不是按第一段**
- [ ] 用 `audit-imports.mjs` 的 `exports` 映射做**权威回退**：
      读各包 `package.json` 的 `exports`，把 `.` 与 `./<sub>` 映射到 `./src/...`
      （`audit-imports.mjs:165` 的 `workspaceExportTargets` 已有这个形状，可直接复用而不是重写）
- [ ] 逐条重测并更新 `slice-cut-list.ts` / `slice-classification.ts` / SCC 计数的声明
- [ ] 跑 §验收 的 4 组命令
- [ ] 做变异 ① ②，按字节还原

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

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无（本卡未开工）。
- **副作用**：无。
- **阻塞**：无。
- **回收**：不回收（本卡未开工）。

**下一步**：认领本卡，先只做"写一条红用例"这一步——
在 `import-graph.test.ts` 加 `it('resolves a bare @duya specifier to the file that declares it')`，
确认它红且失败信息是返回值 `null`。
**完成判据**：该用例在 base 上红、在修好的树上绿，且 `slice-cut-list.test.ts`
与 `slice-classification.test.ts` 仍全绿。

**回退**：本卡只动 `scripts/architecture/**` 与 `packages/agent-protocol/test/**`，
无生产代码、无数据迁移、无 schema 变更 ⇒ 单提交 revert 即回原状。
若已把新边写进 baseline，**回退要同时 `git checkout` baseline 文件**，
不允许留下"新指纹"（根 `AGENTS.md`）。
