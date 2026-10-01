# Duya 架构设计文档（阶段一：调查与设计）

> 生成日期 2026-10-01 · 状态：**阶段一完成，未修改任何产品代码**
> 目标：为 Duya 设计可长期演进的 Monorepo / Agent Harness 架构，并给出可安全执行的迁移方案。

> 📌 **顶层 RFC 见 [`MONOREPO_RFC.md`](../../MONOREPO_RFC.md)** —— 包含
> **Persistent Agent Architecture** 章节（Project / Workspace / Goal / Task / Run / Session / AgentIdentity、
> Agent Control Plane 边界、RunManifest 提案、durable vs ephemeral、checkpoint/resume、multi-host、evals）。
> 本目录是它的证据基础与实施细节。

---

## 阅读顺序

| # | 文档 | 回答什么问题 |
|---|---|---|
| 01 | [现状审计](01-current-state-audit.md) | 现在到底是什么形状？（8 张实测图 + 6 类违规） |
| 02 | [参考仓库边界分析](02-reference-repo-boundaries.md) | ZCode / codex / grok-build 为什么这样分？哪些该抄、哪些是坑？ |
| 03 | [目标结构设计](03-target-structure.md) | 应该长成什么样？每个 package 该建/该拆/该合？ |
| 04 | [Agent Harness 设计](04-agent-harness-design.md) | Run API / 事件 / 权限 / 取消恢复 / evaluator 怎么定义？ |
| 05 | [架构治理](05-architecture-governance.md) | 怎么强制执行，而不是靠自觉？ |
| 06 | [迁移方案](06-migration-plan.md) | 按什么顺序做？每步怎么验收、怎么回滚？ |
| 10 | [技术债台账](10-tech-debt-tracker.md) | 目标状态与仓库实际状态之间还差什么？谁来还？ |

---

## 核心结论（十条）

1. **问题不是包太少，是没有任何一层被强制执行。**
   568 条跨边界 import，其中 **117 条 deep import**（绕过 public entrypoint）
   与 **161 条相对路径穿透**（全部来自 Electron Main，`src/` 为 0）。
2. **`packages/agent` 内部有 18 个循环依赖 SCC，最大 42 文件**，
   横跨 `modes`/`hooks`/`tool`/`process`/`agent`。
   这条环正好压在 `agent-core` 与 `agent-runtime` 的切口上 ——
   **拆包前必须先解耦，否则编译不过。**

3. **缺失的不是包，是三样东西**：一个 protocol package、一个 agent entrypoint 收敛、一条 CI 边界检查。

4. **最高 ROI 的一步：conductor 解耦。** 改 **2 个 import**，
   就能删掉 `build:agent` 里 `|| echo conductor-pass1-errors-ignored` + `clean` + 二次 build 的整段 hack。

5. **`@duya/plugin-core` 无 build step 是加重因素，不是根因。**
   `"main": "src/index.ts"` ⇒ `exports` 字段从不参与解析。
   但 `exports` 对**相对路径**本就无效，而真正的量级是 **161 条相对路径穿透**
   （其中 125 条指向 `packages/agent`）—— 收紧 `exports` 之前必须先改这些引用。

6. **最大的单一边界问题是 `electron → src/`（57 条）**，其中 provider 层独占 24 条。
   方向是反的：Main 依赖 Renderer 的类型，Renderer 又要能独立 typecheck。

7. **`@duya/conductor` 名不副实。** 实际是 React canvas UI 包（`renderer/` 下 100+ React 文件），
   与 agent 仅 2 条依赖。它当前拖慢 agent 构建纯属位置偶然。

8. **三家参考仓库都没有真正的 Agent Harness。**
   ZCode 30 包 4 个测试文件，codex 无 evaluator/打分/跨 run 比较，grok 有 test-support 但无评分。
   **这是 Duya 的差异化机会，不是可以抄的东西。**

9. **治理机制必须修正 ZCode 的两个致命弱点**：它的 checker 只解析相对 import
   （因此从未检查过任何跨包 import），且没有 CI —— 那是"看起来有治理"。
   Duya 必须让 resolver 看得见 workspace 包名，并**第一天就接进 CI**。

10. **可直接抄的三条单点机制**：
    - codex `verify_tui_core_boundary.py`（~90 行，一条边一个脚本 + 具名逃生舱）
    - grok `clippy.toml` 禁裸 `Command::spawn`，强制走 `ProcessScope`（Duya 已有真实 bug 佐证）
    - ZCode 的 `managedOnly: true` 分级 + 指纹式 baseline（让遗留仓库渐进接入）

---

## 目标结构一览

```
apps/desktop/{src/{main,preload,renderer}}     ← 分阶段搬迁（M7）
packages/
  agent-protocol/    ★ 新建  真叶子，零 IO，CI 强制
  agent-core/        ★ 新建  纯 reasoning
  agent-runtime/     ★ 新建  进程/生命周期
  agent-tools/       ★ 新建  选择性可复用工具
  shared/            ★ 新建  跨进程 contract + 平台 port
  ai/ plugin-core/ computer-use/ conductor/ gateway/ voice/ cli/   ← 保留
harness/agent/       ★ 新建  非 workspace member
```

**8 包 → 13 包**（+5 新建，1 重定位，4 个假设项被否决）。
否决的假设项：`packages/mcp`（已有 owner）、`packages/memory`（先解耦所有权）、
`packages/storage`（44 处触达分散在 7 个 owner）、`packages/ui`（UI 的问题是边界泄漏不是缺包）。

---

## 下一步

阶段一**到此结束**。执行阶段二前需要：

1. 用户确认目标结构与阶段顺序
2. 从 **M0（架构检查）** 开始 —— 它是唯一"必须先做"的阶段，
   且必须让 `--self-test` 能数出全部已知违规。
   基线由上述脚本直接复现：

   ```
   ── audit-imports.mjs ──
   cross-boundary edges 568 · deep imports 117
   package escapes 161 (src/ 0 · electron/ 161) · unresolved 34
   ── audit-modules.mjs ──
   cyclic groups 18 (largest 42) · agent/src mods 36 · LOC 156994
   ```

3. **C1（解耦循环 SCC）** —— M5 的前置。最大的 42 文件 SCC 横跨
   `agent-core`(modes) 与 `agent-runtime`(tool/process/hooks) 的切口，
   不先解环就拆包会编译失败。
4. 每个阶段走 `AGENTS.md` 的 **Worktree → PR workflow**，独立可回滚

---

## 数据可复现性

本目录的**全部数字**由 `scripts/architecture/` 下的解析器生成：

```bash
node scripts/architecture/audit-imports.mjs          # 跨边界 import 图
node scripts/architecture/audit-modules.mjs          # 循环 SCC + agent 模块指纹
node scripts/architecture/audit-modules.mjs --json   # 完整边集
node scripts/architecture/validate-scc.mjs           # 用独立 BFS 交叉验证 SCC
node scripts/architecture/verify-cycle.mjs <a> <b>   # 打印具体环路路径
```

`audit-imports.mjs` 读取每个 workspace 包的真实 `exports` 字段来判定 public / deep / escape。

**审计经过两轮修正**，逐条记录在 `01-current-state-audit.md` §9。
其中最重要的一条：初版报告"模块级循环依赖 0"是脚本路径拼接 bug 造成的假阴性，
真实值为 **18 个 SCC（最大 42 文件）** —— 这一条改变了整个迁移的阶段顺序（新增 C1）。
