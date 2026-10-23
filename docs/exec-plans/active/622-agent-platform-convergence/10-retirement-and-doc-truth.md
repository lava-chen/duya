# 10 — 退役收尾 · 残留目录 · 文档事实源

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-10-retirement-and-doc-truth`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 独立线
**退役序列由既有 [12](../610-architecture-series/12-agent-retirement-coordination.md) /
[13](../610-architecture-series/13-agent-retirement-consumers.md) 拥有，本卡不重写。**

---

## 目标与边界

**目标**：三件互不依赖、但都属于"治理事实源"的事排成一条线。

1. **退役收尾 + CI 守卫**：`packages/agent` 退役到**可验证的完成**，
   且门禁进 CI 使其**不再倒退**。
2. **残留目录处置**：`packages/{computer-use,computer-use-demo,conductor}`
   三个未跟踪构建残留目录清掉。
3. **文档事实源更正**：`ARCHITECTURE_MAP.md` 的包清单与层清单改成真实口径；
   其它文档里的已删除路径一并清理。

**边界**：

- **不重写退役序列**。消费者清单、迁移顺序、验收条件由
  [12](../610-architecture-series/12-agent-retirement-coordination.md) 与
  [13](../610-architecture-series/13-agent-retirement-consumers.md) 拥有。
  本卡只做**收尾**（门禁进 CI、目录删除、静态门禁关闭）与**文档事实源**。
- **不改** `packages/agent/**` 的实现——只做**删除**与**消费者迁移**，
  且迁移按既有计划的 owner 归属。
- **不删**任何 Git 跟踪的文件（`packages/agent` 本身的删除由退役计划决定）。
- 文档改动只碰**明确列出的文件**。

---

## 验收

### 首个失败证据（今天长什么样）

**(1) 退役门禁 OPEN**

```
$ node scripts/architecture/agent-retirement-gate.mjs
agent-retirement: OPEN
scope: 3772 active source/config files across [apps, packages, scripts, evals, .github]
legacy package directory: present
references: 770 (750 confirmed old-package, production-source=19, build-tooling=84, active-config=13, test-target=654)
artifact/build selectors: 10 mapped to Host, 10 unverified
bounded synthetic fixture references: 51
runtime acceptance remains separate: production worker must build and load with packages/agent absent
```

⇒ **门禁不在 CI**（`grep -c "agent-retirement-gate" .github/workflows/test.yml` → **0**），
也不在 npm scripts（`package.json` 里没有它的 script 行）。
⇒ **停下来不会红。**

**(2) 三个残留目录**

```bash
$ ls packages/ | wc -l          # → 23（共享检出）
$ git ls-files packages/computer-use     | wc -l   # → 0
$ git ls-files packages/computer-use-demo | wc -l   # → 0
$ git ls-files packages/conductor        | wc -l   # → 0
```

磁盘内容（共享检出实测）：

| 目录 | 内容 |
| --- | --- |
| `packages/computer-use/` | `dist/` `node_modules/` `tsconfig.tsbuildinfo` |
| `packages/computer-use-demo/` | `dist/` `tsconfig.tsbuildinfo` |
| `packages/conductor/` | `dist/` `node_modules/` |

**每一个文件都被现有 ignore 规则命中**（`.gitignore:2` `node_modules/`、
`:6` `dist/`、`:10` `*.tsbuildinfo`）⇒ `git status` 对这三个目录**完全沉默**，
`git ls-files` 为 0。

⇒ **它们不是 Git 状态，是纯构建残留。删除零 Git 风险。**

**必须先写的用例**：

```text
scripts/architecture/agent-retirement-gate.test.ts   （已有，需扩）
  it('is wired into CI so the retirement cannot silently regress', ...)
```

**今天跑它，红的形态是**：断言"退役门禁在 CI workflow 里有入口"失败，
失败信息显示 `.github/workflows/test.yml` 里命中 **0** 次。

**(3) 文档事实源**

- `docs/architecture/ARCHITECTURE_MAP.md:16`：「**23 workspace packages.** Each has its own `AGENTS.md`.」
  ⇒ 真实值：**20 个带 `package.json` 的包**（实测 `ls packages/*/package.json | wc -l` → **20**）
  **+ 2 个 app**（`apps/desktop`、`apps/web`）。
- `ARCHITECTURE_MAP.md:33`：把 `computer-use` 列为在册包，给调试入口 `src/access.ts:136`
  ⇒ **master 上不存在 `packages/computer-use`**（该目录只剩未跟踪残留）。
- `ARCHITECTURE_MAP.md:60-62`：「12 packages (`host`, `ui`, `data`, `client-core`, `tooling`,
  `sandbox`, `plugin-core`, `command-catalog`, `input-completion`, `computer-use`, `voice`, `web`)
  are in **no layer**」
  ⇒ 实测无层的是 **10 个**：`client-core` `command-catalog` `data` `host`
  `input-completion` `plugin-core` `sandbox` `tooling` `ui` `voice`。
  ⇒ 清单里的 `computer-use`（master 无此包）与 `web`（是 app 不是包）**两个都不是包**。
- `docs/architecture/ARCHITECTURE.md`：**3 处**指向已删除的 `packages/computer-use/src/**`
  （`:958` `packages/computer-use/src/decide/`、`:979` `packages/computer-use/`、
  `:988` `packages/computer-use/src/cua/`）。
- `docs/development/test-inventory.json`：**162 处**指向已删除文件
  （`packages/computer-use/src/**`、`packages/conductor/src/**`）
  ⇒ 它是**生成物**（`npm run test:inventory:write`，生成器在 `scripts/test-inventory.mjs`），
  **重跑即可修**。

**必须先写的用例**：

```text
scripts/architecture/doc-truth-gate.test.ts   （新建）
  it('states the real workspace package count', ...)
```

**今天跑它，红的形态是**：断言"`ARCHITECTURE_MAP.md` 写的包数等于
`packages/*/package.json` 的实际个数 + app 数"失败，
实际值 23 ≠ 22（20 包 + 2 app）。

### 验收命令与预期结果

```bash
# 1) 退役门禁
node scripts/architecture/agent-retirement-gate.mjs
#    预期：agent-retirement: CLOSED（目录已删、无引用）
#    若只做"不倒退"：预期 引用数 ≤ 基线，且新增为 0

grep -c "agent-retirement-gate" .github/workflows/test.yml
#    预期：≥ 1

grep -c "agent-retirement" package.json
#    预期：≥ 1（现在没有 script 行）

# 2) 残留目录
ls packages/ | wc -l
#    预期：21（20 包 + node_modules），或按 .gitignore 口径的等价数
git ls-files packages/computer-use packages/computer-use-demo packages/conductor | wc -l
#    预期：0（不变）

# 3) 文档事实源
npm run test:inventory:write
git diff --stat docs/development/test-inventory.json
#    预期：只有删除与更新，无"新增指向不存在文件"

npx vitest run scripts/architecture/doc-truth-gate.test.ts
#    预期：全部 passed

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **退役门禁在 CI 里**，且它的形态是"**不前进**"而不是"必须为零"
   （今天 770 处引用是既有债，直接接进 CI 会立刻红一次——
   见 [02 §发现 4](./02-gate-wiring-and-single-resolver.md#发现与决策)）。
2. **残留目录清零**：`ls packages/` 的结果与 `git ls-files` 一致。
3. **`ARCHITECTURE_MAP.md` 的包数与层清单与代码逐字一致**：
   「**20 packages + 2 apps**」，无层包清单与 [04](04-remaining-unlayered-packages.md) 的结果一致。
4. **`ARCHITECTURE.md` 与 `test-inventory.json` 里不再有指向已删除文件的路径。**

### 变异证明（门禁卡必填）

- **变异 ①**：往 `packages/agent/src/` 加一个被 import 的文件（临时）
  → 退役门禁的引用数**必须上涨**，CI **必须红**
  （证明门禁有牙齿，不是一路 PASS）。
- **变异 ②**：把 `ARCHITECTURE_MAP.md:16` 的包数改成 21
  → "states the real workspace package count"那条用例**必须红**。
- **变异 ③**：手动改 `test-inventory.json` 加一条指向不存在文件的记录
  → 文档事实源门禁**必须红**（或 `npm run test:inventory` 报 drift）。

---

## 进度

- [ ] 写 `it('is wired into CI so the retirement cannot silently regress')`，确认红
- [ ] 写 `doc-truth-gate.test.ts` 的包数用例，确认红（23 ≠ 22）
- [ ] 给退役门禁加 npm script + CI 入口；形态是"引用数不前进"
- [ ] 证明三个残留目录无活路径指向它们（跑 `git grep "packages/conductor\|packages/computer-use"`，
      逐条看引用是注释还是代码）
- [ ] 删除三个残留目录（**在共享检出上要先确认没人正在用**）
- [ ] `npm run test:inventory:write` 重跑生成物；核对 diff 只删不增
- [ ] 改 `ARCHITECTURE_MAP.md`：`:16` 包数、`:33` 删 `computer-use` 行、`:60-63` 无层清单
- [ ] 改 `ARCHITECTURE.md` 的 3 处 `packages/computer-use/src/**` 引用
- [ ] 跑 §验收 的 4 组命令 + 3 组变异
- [ ] 按 [12](../610-architecture-series/12-agent-retirement-coordination.md) /
      [13](../610-architecture-series/13-agent-retirement-consumers.md) 的验收条件核对退役完成度

---

## 发现与决策

1. **退役门禁的计数与 13 号文件的快照不一致，说明退役在推进。**
   [13](../610-architecture-series/13-agent-retirement-consumers.md) 记的快照是
   2026-10-13：**382** 处引用、**3,008** 个文件。
   今天实测：**770** 处引用、**3,772** 个文件。
   ⇒ 引用数**上涨**了。这是**预期的**（门禁扫的文件集变大了：
   `apps/` 与 `evals/` 的新增测试引用了退役包），
   **不是**退役倒退。**不能拿"引用数"当退役进度指标**——
   真正的指标是**分母里的 production-source 类别**（今天 19 处）。
   ⇒ 裁决：CI 门禁的基线**按类别分**（production-source / build-tooling /
   active-config / test-target），**只对 production-source 与 active-config 拦新增**；
   test-target 的增长（测试还在迁）是正常的。
   ⇒ **这条是本卡最容易做错的一步**：用一个总数做基线，会让 CI 在
   "测试迁移导致引用数自然变化"时误报。

2. **残留目录的来源可查，是两次迁移的尾巴。**
   - `packages/conductor/`：`conductor` 迁到 `packages/ui` 之后的构建残留
     （`ARCHITECTURE_MAP.md:34` 现在写 `client-core`、`:35` 写 `ui` 整个 renderer）。
   - `packages/computer-use/` 与 `packages/computer-use-demo/`：
     [外置能力迁移计划](../2026-10-22-external-capability-migration.md) 的尾巴。
   ⇒ **裁决**：删之前先跑 `git grep "packages/conductor\|packages/computer-use"`，逐条分类：
   - **代码引用**（会真的解析到那个路径）→ 必须先改掉。
   - **注释 / 文档 / 架构策略注释**（`architecture-policy.yaml:1717` 就是一条注释，
     用过去时描述历史）→ 可以留着，但**文档事实源**类引用要清。
   实测 `git grep` 命中 162+ 处，但绝大部分在
   `docs/development/test-inventory.json`（**生成物**）与历史计划文档里。

3. **文档事实源的漂移不止 `ARCHITECTURE_MAP.md`。**
   实测至少四处：
   - `ARCHITECTURE_MAP.md:16`（23 包）、`:33`（`computer-use` 在册）、`:60-62`（12 个无层包）。
   - `ARCHITECTURE.md:958` / `:979` / `:988`（`packages/computer-use/src/**`）。
   - `test-inventory.json`（162 处，**生成物**，重跑可修）。
   - `ARCHITECTURE_MAP.md:49-50` 说层表在 `boundary-gates.mjs:67-75`、
     "`architecture-policy.yaml` 的 `layers:` 块主检查器从不读"——**这条是准确的**
     （实测 `grep -n "layers" scripts/architecture/architecture-check.mjs` → 0 命中）。
     ⇒ **不要**在清理时把这条一起删掉。
   ⇒ 裁决：**手写文档逐条核对，生成物重跑**。两者用不同手段。

4. **`ARCHITECTURE_MAP.md` 的「每包都有 `AGENTS.md`」这句话也要核。**
   `:16` 的原文是「23 workspace packages. Each has its own `AGENTS.md`.」
   ⇒ 核对动作：数 `packages/*/AGENTS.md` 的实际个数。
   若不是 20，**整句要改**，不是只改数字。

5. **不要在本卡里删除 `packages/agent`。**
   退役的完成判据由
   [12](../610-architecture-series/12-agent-retirement-coordination.md) 定义：
   静态门禁 CLOSED **且**真实 worker 在该目录缺席时能构建并加载。
   ⇒ 本卡做**门禁接线 + 文档**，删除动作按既有计划的节奏走。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `node scripts/architecture/agent-retirement-gate.mjs` | 0 | `agent-retirement: OPEN`；**3772** 文件；**770** 引用（production-source **19** / build-tooling **84** / active-config **13** / test-target **654**）；selectors 10 mapped + 10 unverified |
| `d9eb7dba` / 干净 | 同上 | `grep -c "agent-retirement-gate" .github/workflows/test.yml` | 1 | **0** 命中 |
| `d9eb7dba` / 干净 | 同上 | `grep -n "agent-retirement" package.json` | 1 | **0** 命中（无 script 行） |
| `d9eb7dba` / 干净 | 同上 | 共享检出 `ls packages/ \| wc -l` | 0 | **23** |
| `d9eb7dba` / 干净 | 同上 | `git ls-files packages/{computer-use,computer-use-demo,conductor} \| wc -l` | 0 | **0**（三者均无跟踪文件） |
| `d9eb7dba` / 干净 | 同上（共享检出） | `git check-ignore -v packages/computer-use/dist packages/conductor/dist` | 0 | `.gitignore:6 dist/` 命中两者；`node_modules/` → `.gitignore:2`；`*.tsbuildinfo` → `.gitignore:10` |
| `d9eb7dba` / 干净 | 同上 | `ls packages/*/package.json \| wc -l` | 0 | **20**（真实包数） |
| `d9eb7dba` / 干净 | 同上 | `grep -n "23 workspace packages\|computer-use\|12 packages" docs/architecture/ARCHITECTURE_MAP.md` | 0 | `:16`「23 workspace packages」；`:33` `computer-use` 在册 + `src/access.ts:136`；`:60-62`「12 packages … in no layer」 |
| `d9eb7dba` / 干净 | 同上 | `git grep -c "packages/conductor\|packages/computer-use"` | 0 | `docs/development/test-inventory.json` **162** 处；`ARCHITECTURE.md` **3** 处；`architecture-policy.yaml` **1** 处（注释） |
| `d9eb7dba` / 干净 | 同上 | `grep -n "test:inventory" package.json` | 0 | `:108` `test:inventory`；`:109` `test:inventory:write` → `scripts/test-inventory.mjs --write` |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无（本卡尚未执行任何删除）。
- **阻塞**：无。**但删除残留目录前必须确认共享检出上没有别的 session 正在用**
  （`packages/computer-use` 与 `packages/conductor` 都是迁移过的路径）。

**下一步**：认领本卡，先做两件零风险的事——
(1) 写 `doc-truth-gate.test.ts` 的包数用例，确认红（23 ≠ 22）；
(2) 跑 `git grep "packages/conductor\|packages/computer-use"`，把命中逐条分类成
「代码引用 / 注释 / 生成物 / 历史文档」。
**完成判据**：分类表完整，且能指出**哪些命中会真的解析到那个路径**。

**回退**：
- 残留目录删除**不可逆**（不在 Git 里）⇒ 删除前先确认它们只含 `dist/` /
  `node_modules/` / `*.tsbuildinfo`，且**没有活路径指向它们**。
  删错了只能重建（成本 = 一次 `npm install` + 一次 build）。
- 文档改动是 Git 跟踪的 ⇒ 单提交 revert 即回原状。
- `test-inventory.json` 是**生成物** ⇒ 回退用 `git checkout` 该文件即可，
  但**不要**手改它（下次 `test:inventory:write` 会覆盖）。
