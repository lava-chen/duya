# Duya 架构设计文档（阶段一：调查与设计）

> 生成日期 2026-10-01（第二轮追加：08 / 09 两份专项裁决）
> 状态：**阶段一完成，未修改任何产品代码**
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
| 07 | [`agent-protocol` 接口规格](07-agent-protocol-spec.md) | **protocol 到底怎么规定？** 文件布局、闭合事件注册表、三种 transport、错误分类、14 条 drift test、M0–M11 迁移顺序 |
| 08 | [重复实现裁决](08-duplicate-implementation-adjudication.md) | **那些重复，哪套是活的、哪些能删？** 5 组 × 可达性追踪 + 6 条删除阻塞 |
| 09 | [conductor → canvas 评估](09-conductor-rename-assessment.md) | **该不该重命名？** 344 文件 / 2 库 / 230 i18n key 的影响面 + 为什么不该整体改 |
| 10 | [参考实现对比](10-reference-comparison.md) | **codex / grok / pi / ZCode 哪些该抄？** 16 条决定 + 写完代码后被自己推翻的 3 条 |
| 10 | [技术债台账](10-tech-debt-tracker.md) | 目标状态与仓库实际状态之间还差什么？谁来还？ |
| 11 | [protocol 前瞻评审](11-protocol-forward-review.md) | 这套协议接下来会往哪里坏掉？ |

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

7. **`@duya/conductor` 的 package description 是错的，但不是包名错了。**
   `package.json` 自称 "canvas orchestrator agent subsystem"，实际是 React canvas UI 包
   （`renderer/` 下 100+ React 文件），与 agent 仅 2 条依赖。
   ⚠️ **"名不副实所以改名"是错误推论** —— 全量评估见 [09](09-conductor-rename-assessment.md)：
   改名的真实代价是 **344 文件 / 2 个数据库 / 230 个 i18n key / 39 个 CSS class**，
   会让 `CanvasConductor` 撞车成 `CanvasCanvas`，并摧毁 i18n 里
   finite-workspace vs infinite-canvas 的既有区分。
   **它当前拖慢 agent 构建纯属位置偶然 —— 真正的缺陷是那个 two-pass build hack，不是名字。**

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

## 第二轮：两项专项裁决（2026-10-01 追加）

第一轮审计基于**统计**（数 import、搜字符串）。第二轮对重复实现与命名做了**可达性追踪**
（从 boot / IPC handler / 用户动作 / agent run 反向），**推翻了四条初始判断**：

| 初始判断 | 复核结论 | 文档 |
|---|---|---|
| "4 套 Task 模型重复" | **三个不同 subject**：TODO 清单(SQLite) / subagent 执行控制(内存 Map) / bash 命令(JSON)。`KillTaskTool` 同时查后两个，删任一即断 | [08](08-duplicate-implementation-adjudication.md) |
| "2 套 automation 是最尖锐的重复" | **两套都活着**；唯一死的是 `trigger.ts` 一个文件（自称 "unified trigger entry"，四个导出全仓只命中自己和测试） | [08](08-duplicate-implementation-adjudication.md) |
| "5 处 path containment 重复" | **五处全 LIVE 且分层**。一次 `Read` 跑三道，前两道词法（决定问不问），第三道 realpath（安全边界）。**"弱于强是刻意的"** | [08](08-duplicate-implementation-adjudication.md) |
| "permission 5 份拷贝，默认值已分叉" | **两个 resolver 都默认 `'auto'`**；`'default'` 是对非法存储值的降级。分歧被夸大且当前不可达（agent 侧 resolver 是死代码） | [08](08-duplicate-implementation-adjudication.md) |

**真正可安全删除的只有 2 个文件**（`session/permission-resolver.ts`、`modes/workflow/trigger.ts`），
另有 4 项需前置条件，**6 项"看着像死代码但不是"** ——
其中 `legacy-import.ts` 是唯一能读 plan-328 之前用户数据的**复活舱**，
`TaskStore.claim()` 是"差一个开关"的功能。

第二轮同时撤回了 `packages/workspace` 的"条件采纳"：它的唯一 consumer 是 Control Plane，
收成 `control-plane/workspace/` 内部 module，跨边界只留 `agent-protocol` 的 `WorkspaceSnapshot`
契约（见 [03](03-target-structure.md) §3.5）。

---

## 目标结构一览

```
apps/desktop/{src/{main,preload,renderer}}     ← ✅ 已落地（M7 · PR #115）
apps/desktop/src/main/control-plane/           ← 逻辑层，非 package
  goals/ tasks/ runs/ scheduler/ wake/ approvals/ checkpoints/ workspace/
packages/
  agent-protocol/    ★ 新建  真叶子，零 IO，CI 强制
  agent-core/        ★ 新建  纯 reasoning
  agent-runtime/     ★ 新建  进程/生命周期
  browser/           ★ 进行中  单能力独立成包（替代初版的 agent-tools 聚合包）
  shared/            ★ 新建  跨进程 contract + 平台 port
  ai/ plugin-core/ computer-use/ conductor/ gateway/ voice/ cli/   ← 保留
evals/agent/         ★ 新建  非 workspace member（初版名为 harness/）
```

**8 包 → 13 包**（+5 新建，1 进行中，1 重定位，5 个假设项被否决，
1 个条件项撤回为 Control Plane 内部 module）。
否决的假设项：`packages/mcp`（已有 owner）、`packages/memory`（先解耦所有权）、
`packages/storage`（44 处触达分散在 7 个 owner）、`packages/ui`（UI 的问题是边界泄漏不是缺包）、
`packages/agent-tools`（聚合袋内聚弱，改为按能力独立成包）。

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
