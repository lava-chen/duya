# 动态工作流核心抽包与并发恢复

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：codex/three-learning-plans · worktree：E:/Projects/duya/.claude/worktrees/three-plans · base：7063a47f · owner：本会话

## 目标与边界

把动态工作流从“host 里的一个目录加 agent 里的一份旧副本”整理成边界清楚的能力包，并补齐 ZCode 已经验证的执行纪律：并行派发、依赖隔离的失败、退避、run 级与 provider 级双并发上限、整脚本恢复校验。

允许修改 `packages/host/src/worker-workflows/`、新增 `packages/workflow/`、更新构建顺序与架构策略、迁移 `packages/agent/src/modes/workflow/` 的重复实现，以及必要的 UI/CLI 引用。本次不实现 ZCode 的 TypeScript taint/因果分析器，不新建多层 run service，不改 WorkflowPanel 的交互产品面。

关联：[多 Agent Orchestrator](2026-10-23-multi-agent-orchestrator.md) 的 O1–O4。

## 包归属决策

结论：新增 `packages/workflow`（`@duya/workflow`），不放进 `packages/capabilities`，也不放进 `agent-core` / `agent-runtime`。

| 选项 | 判定 | 理由 |
| --- | --- | --- |
| `agent-core` / `agent-runtime` | 否 | 工作流是产品编排能力，不是每轮推理必需的 harness 结构；放进去会让基础运行链背上 run 生命周期、预算与持久化端口。 |
| `capabilities` | 否 | 该包是“工具实现 + 工具契约”，明确不知道调用者；工作流需要 run 身份、journal、预算、重试与并发治理。放进会混合编排与工具，并让所有 runtime 消费者承担工作流代码。 |
| 继续留在 `host` | 部分保留 | Host 继续拥有 run 存储、进度通道、worker 装配与执行绑定；纯核心不应继续散落在 24 个文件里。 |
| 新增 `@duya/workflow` | 是 | 纯定义、调度、日志语义与恢复规则可零 IO 测试；Host 通过端口注入存储与执行器；UI/CLI 可只依赖 schema。 |

新包放在 runtime 层，`requires` 只保留协议与核心类型；Host 增加对 `@duya/workflow` 的依赖。`packages/capabilities` 不新增任何工作流依赖。

## 验收

- `npm run typecheck:all`、`npm run architecture:check` 通过；新模块以 `managed: true` 登记，无新增 baseline 指纹。
- `@duya/workflow` 在无数据库、无 worker 的测试环境可跑完整调度用例。
- 同一阶段内两个互不依赖的节点并行执行；一个分支失败不影响另一分支已完成的结果，依赖失败节点的下游才被跳过或标记 blocked。
- 重试带指数退避与抖动；provider 限流反馈能降低共享上限，压力解除后逐步恢复。
- 运行中只修改并发上限时，不新建 run、不打断在途节点；提高上限后排队节点立即派发。
- 恢复时校验整份工作流定义 hash 与 journal 代次；hash 不匹配拒绝 resume，孤儿 running 收敛为可恢复的 stopped。
- 关键行为用 graph fixture 与数值轨迹断言，而不是只看最终状态码。

## 进度

- [ ] S0 对账：以 `packages/host/src/worker-workflows/` 为当前实现，逐文件比对 `packages/agent/src/modes/workflow/` 的重复副本；列出差异、引用与删除条件，旧副本冻结不再新增实现。
- [ ] S1 抽包骨架：建立 `packages/workflow`，迁入 schema、validate、expr、journal 类型、resume-token、host 端口、scheduler 与并发控制；Host 保留 manager、runner、DB、进度与执行绑定。
- [ ] S2 接线与门禁：更新 workspace 构建顺序、tsconfig、architecture-policy 的模块与 requires，补齐公共入口；Host 从新包导入，删除迁移后的重复实现。
- [ ] S3 并行调度：从阶段内串行拓扑改为就绪集派发；run 级上限与 provider 级 AIMD governor 分离；支持 live retune 与 `concurrency-changed`、`run-stalled` 观测。
- [ ] S4 失败语义：失败按依赖子树隔离；独立分支继续；重试指数退避加抖动；预算耗尽与取消仍是 run 级停止，不写可重放 journal。
- [ ] S5 恢复纪律：整份定义 hash + journal 为唯一事实；修复 trailing failure 剪除与孤儿 running 对账；明确脚本运行时与 DAG 定义两类 run 的 hash 来源。
- [ ] S6 测试：补齐并发数值轨迹、依赖失败隔离、退避时序、live retune、hash 失配与断点恢复 fixture；记录基线失败后再比较。

## 发现与决策

- 当前 Host 实现已有 DAG 校验、阶段串行拓扑、map 并发、journal 缓存、resume token 与预算；缺口是阶段内并行、首败杀整轮、重试无退避、子 agent 拓扑不落盘，以及没有 run/provider 双上限。
- `packages/host/src/worker-workflows/` 与 `packages/agent/src/modes/workflow/` 存在同名但内容不同的两套实现；`packages/agent` 已标记待退役，旧副本不应继续承载新能力。
- `packages/capabilities` 的架构职责是工具实现与窄契约，且被 `agent-runtime` 依赖；把工作流放进去会形成“runtime 依赖编排”的层级倒置。
- ZCode 的实现证明双上限与 live retune 可以只靠观测事件与端口完成；其 TS 分析器与多层 run service 不进入本计划。
- 决策：保留 YAML/DAG 作为定义面，不引入脚本驱动的第二作者面；先对齐执行纪律，再评估 amend/retune 是否需要产品入口。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待记录 | Windows / Node | `npm run typecheck:all` | 待记录 | S2 完成后填写 |
| 待记录 | Windows / Node | `npm run architecture:check` | 待记录 | S2 完成后填写 |
| 待记录 | Windows / Node | `@duya/workflow` 单测与 Host 集成测试 | 待记录 | S6 完成后填写 |

## 接续 / 结果

已实现：无。已验证：无。已合并：无。

未提交路径：本计划文档。外部副作用：无。

阻塞：新包命名与公共入口需与架构门禁对齐；旧副本删除依赖 `@duya/agent` 退役门禁的当前状态，不能顺手整树删除。

下一步：完成 S0 对账表，确认 Host 与 agent 两份实现的差异和引用，再决定 S1 的迁移清单。
