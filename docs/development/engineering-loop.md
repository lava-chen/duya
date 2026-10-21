# 工程闭环契约（多 Agent 自主开发）

> 这份文档回答一个问题：**一个任务怎么从「一句话目标」走到「一个通过验证、可合并的 PR」，并且在任何一步被打断后还能安全续上。**

## 为什么需要它

duya 已经有不少长程工程的基础件：Task API（`claimTask` / `owner` / `blocks` / `blockedBy`）、
Checkpoint 数据结构、worktree 隔离、架构依赖门禁、真实 Agent 行为 Evals、CodeReview Agent。

但这些是**零件**，不是**回路**。参考 OpenAI 的 Harness Engineering（百万行级仓库、持续自动
集成）和 Anthropic 的多 Agent 编译实验，差距不在单个 Agent 的编码能力，而在三件事：

1. **没有自动的「拆解 → 执行 → 独立验证 → 反馈修复 → 再调度」循环**；
2. **验证基础设施还不足以当裁判**——Agent 无法可信地回答「我的改动是不是真的让产品变好了」；
3. **长任务状态没有贯穿所有系统**——Goal / Task / Run / Worktree / Commit / PR / Verification
   之间没有统一关系，重启后不知道哪些已验证、哪些有未提交成果、哪些需要恢复。

第 2 条是前提：验证不可信时，增加并行 Agent 只会加速错误传播。

## 闭环

```
Goal ──plan──▶ Task ──claim──▶ Run ──worktree──▶ Commit/PR ──verify──▶ Integration
  ▲                                                                            │
  └──────────────── 失败反馈 / 修复回合 ◀────────────────────────────────────┘
```

每一段都有明确的产出物和负责人：

| 段 | 产出物 | 规则 |
| --- | --- | --- |
| Goal → Task | Task 列表 + 依赖关系 | 一个 Task 一个可独立验证的产出；依赖用 `blocks` / `blockedBy` 声明 |
| Task → Run | Run + owner + lease | 一个 Task 同时只能有一个 owner（`claimTask`）；lease 到期要能被回收 |
| Run → Worktree | worktree + 分支 + base commit | 并行写代码必须各自一个 worktree，见 [worktree.md](./worktree.md) |
| Worktree → PR | 分支 + 原子 commit | 一个 Task 一个分支；commit 与 plan 步骤对应 |
| PR → Verification | **验证证据** | 命令 + 退出码 + 关键输出，写进 PR 或 task 记录 |
| Verification → Integration | 合并 | 必须过 CI 门禁；不合并不算完成 |

## 角色契约

### Planner

- 把目标拆成 Task，给每个 Task 一个**可判定的验收条件**（能写成一条命令或一个断言）。
- 拆解按**文件归属**切，不按功能切——否则并行分支一定在合并期撞车。
- 不写实现代码。

### Worker

- 在自己的 worktree 里干活，不碰共享检出。
- **不能自证完成**。Worker 的总结是**输入**，不是**证据**；证据是命令的退出码和 CI。
- 提交前跑针对性测试 + `npm run typecheck:all` + 受影响的架构门禁。
- 遇到基线就红：先记录基线失败集，再判断自己的改动是不是新引入的。

### Evaluator

- 独立于 Worker 重新验证，理想情况下在**另一个 worktree / 干净检出**上跑。
- 用产品级证据而不是单元测试通过：Playwright MCP 截图、真实 Electron turn、DB 查询结果、
  API 响应。`evals/agent/` 是这条的现成形态。
- 判定失败时，输出**可复现的失败步骤**给 Worker，不给「感觉不对」。

### Integration Controller

- 按依赖顺序合并，先合小的、范围窄的。
- 合并后重新验证（re-verify），而不是假定合并一定安全。
- 合并失败要回滚到已知良好状态，不能留半合并的 master。

## 硬规则

1. **证据先于结论**：没有验证输出就不能声称完成。
2. **隔离先于并行**：两个写代码的 Agent 同时开工，必须是两个 worktree。
3. **恢复靠对账，不靠重跑**：中断后先对账（哪些副作用已经发生、哪些没发生），
   再决定续跑还是回滚。
4. **不合并未验证的分支**：验证失败就留在原地修，不要为了「推进进度」而合并。
5. **状态必须落盘**：Task 状态、base commit、分支、验证证据都写进版本化的记录
   （plan 文档 / task store / PR 正文），不能只留在会话上下文里。
6. **知识库以 Git 为准**：计划、契约、决策记录进 Git。未进 Git 的本地文件对下一个会话不存在。

## 当前能力与缺口

| 能力 | duya 现状 | 缺口归属 |
| --- | --- | --- |
| 任务认领与依赖 | Task API 已有 `claimTask` / `owner` / `blocks` / `blockedBy` | 缺 lease/fence 与回收 |
| Checkpoint | D7.1 已合并（#177），含单调 `fence` | D7.2 lease/renew、D7.3 恢复执行、D7.4 Goal/Task 长期闭环 —— **一条未开始** |
| 恢复语义 | resume / determinism / pause 被**显式声明为 unsupported** | plan 587 D7；有故障注入矩阵作为放行条件 |
| Worktree 隔离 | 子代理 `isolation: "worktree"` 可用；开发用 worktree 流程已文档化 | 无锁、无 journal、无自动清理 —— plan 496 |
| 独立验证 | 有 `evals/agent/`、CodeReview Agent、架构门禁 | 固定 Evals 未接 CI；真实 Electron turn E2E 有未验收项 |
| 集成 | 有 PR 流程 | 缺合并队列、文件冲突预测、合并后重验 |

**下一动作**：plan 587 D7.2（lease/fence + 恢复 attempt）。
在这之前，`execution resume` 保持 unsupported 是**正确**的状态——不要为了「能恢复」
而打开一个没通过故障矩阵的口子。

## 相关

- plan 587（主执行路线）：`docs/exec-plans/active/587-agent-harness-monorepo/`
- plan 496（worktree 框架）：`docs/exec-plans/active/496-worktree-framework-implementation.md`
- worktree 契约与流程：[worktree.md](./worktree.md)
