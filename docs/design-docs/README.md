# 设计决策

记录为什么选择一个方案，以及约束和替代方案。当前行为查根架构，执行状态查计划。

| 主题 | 记录 |
| --- | --- |
| Project-first 产品架构（当前方向） | [project-first-architecture](project-first-architecture.md)：Project Coordinator、Personal Bot、工作 Session 的边界、共享仓库与状态权威 |
| Coordinator 首版实施合同 | [project-coordinator-contract](project-coordinator-contract.md)：具体工具输入/输出、稳定工作身份、派发反馈、控制权与项目记忆接缝 |
| Coordinator 提示词系统 | [project-coordinator-prompts](project-coordinator-prompts.md)：基于 624 的常驻正文、动态上下文、事件处理、工作交接与恢复/评估设计草案 |
| 个人长期 Bot | [personal-bot-framework](personal-bot-framework.md)：Bot / Session / Run、包边界、持久唤醒、记忆与迁移合同（设计提案） |
| CLI 控制面 | [roadmap](cli-control-plane/roadmap.md)及同目录阶段决策 |
| Gateway 职责 | [channel-only-gateway](channel-only-gateway.md) |
| 多模型推理 | [2026-07-29 架构方案](2026-07-29-multi-model-reasoning-architecture.md) |
| TUI 基础调查 | [cli-tui-foundation-phase0](cli-tui-foundation-phase0.md) |

这些记录保留原决策时点，不保证全部落地。新决策写问题、选择、理由、后果及关联计划；被替代时链接后继，不覆盖原理由。
