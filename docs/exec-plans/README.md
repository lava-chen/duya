# 执行计划

先定位用户本次任务，再读取对应计划的验收与接续点。这里维护路由，不复制各计划的实时状态。

## Active Plans

| 范围 | 入口 | 下一动作 |
| --- | --- | --- |
| 动态工作流核心包 | [2026-10-24 动态工作流核心包](active/2026-10-24-dynamic-workflow-package.md) | S0 已对账并记录基线；提交文档切片后定 S1 包边界并抽取零 IO 核心 |
| 插件 UI MCP 资源 | [2026-10-24 插件 UI MCP 资源](active/2026-10-24-plugin-ui-mcp-resources.md) | 完成 S1 契约后先报告 schema diff 与受影响调用方，再推进 S2 |
| 输出速度 tok/s | [2026-10-23 输出速度](active/2026-10-23-output-token-rate.md) | provider 校准路径：ai 测时长 → 协议契约 → 帧携带 → TUI 展示 |
| 面板列树布局 | [2026-10-22 面板列树](active/2026-10-22-panel-column-layout.md) | 切片 A（列树渲染）与 B（脱窗 Electron 侧）并行开工；C/D 待 A 落地 |
| 本次侧栏对齐 | [2026-10-22 侧栏对齐](active/2026-10-22-sidebar-alignment.md) | 已在最新 master 重建分支，实现行级状态图标、分组头三按钮与组内搜索 |
| 本次公开树整理 | [2026-10-21 仓库树整理](active/2026-10-21-public-tree-cleanup.md) | 清理公开根目录、移动中文入口/架构文档并验证打包路径 |
| 本次文档整理 | [2026-10-20 文档体系](active/2026-10-20-documentation-system.md) | 文档已整理；待处理文档范围外的两处门禁失败，见接续记录 |
| 单 Host 多客户端 | [2026-10-22 Desktop 与 TUI 共用 Host](active/2026-10-22-single-host-multiclient.md) | 先做 health 能力字段与 TUI 自动 attach |
| 架构主线 | [610 执行队列](active/610-architecture-series/19-fast-track-queue.md) | 只从该文档追踪表选择未完成卡；不从旧编号重排 |
| Harness 正确性 | [2026-10-24 Harness 审计](active/2026-10-24-harness-correctness-audit.md) | 契约 + H-1~H-6 修复随 base=master 的 PR 进 master；CI 会跑 |
| 平台收口 | [622 依赖测量先行](active/622-agent-platform-convergence/README.md) | 01 已合入（PR #399）；02 已提交（`73c067c4`）并开 PR #405；architecture/typecheck/build 通过，全量 test 的 2 个 IPC 失败在 base 复现 |
| 工作区生命周期 | [621 生命周期 Harness](active/621-coding-workspace-lifecycle-harness.md) | 已合并（含 F 三端 UI，#378 → `39f2314f`）；场景 1–7 全绿 |
| 多 Agent 编排 | [2026-10-23 多 Agent Orchestrator](active/2026-10-23-multi-agent-orchestrator.md) | 评估已出：codex 无队列/DAG/重试可抄；duya 依赖与重试已具备。Phase 1 补测（子 agent 状态机零覆盖）→ Phase 2 DAG 并行 + 失败级联 |
| Agent Runtime 真实基准 | [2026-10-23 Agent Runtime 基准](active/2026-10-23-agent-runtime-e2e-benchmark.md) | 基准已跑通并定位瓶颈；待 PR 集成 |
| Desktop 性能爬坡 | [2026-10-23 Desktop 性能爬坡](active/2026-10-23-desktop-performance-hill-climbing.md) | 5 个 Agent 各占一条独占路径：先由 A 交 Harness v1，再由 B/C/D/E 建基线、各出一个可证明收益的 PR |
| CLI TUI 渲染 todolist | [2026-10-23 CLI todo 渲染](active/2026-10-23-cli-todo-list-render.md) | todo 清单渲染与 thinking 折叠预览已实现并过门禁，待开 PR；底部常驻面板列 Phase 2 |
| config 写侧下沉 | [2026-10-25 config 写侧下沉](active/2026-10-25-host-config-agents-write.md) | 共享规则已下沉 `packages/host/config-agents`，Host bridge 接上 `config:agents:create/update`；PR #433 已合并（`f59767f1`） |
| 插件安装路径下沉 | [2026-10-25 插件安装路径](active/2026-10-25-host-plugin-install-path.md) | 独立 Host 已能解析插件 `installPath` 与 MCP 声明，恢复插件技能与 MCP；PR #443 已合并（`49b4771e`） |
| 其他产品任务 | [完整目录](catalog.md) | 定位用户指定主题，核对实际进度与依赖后认领 |
| TUI 滚动语义 | [2026-10-23 TUI 滚动锚定](active/2026-10-23-tui-scroll-anchor.md) | 视窗改为绝对偏移 + 独立 follow，已过门禁待开 PR；参考 pi 的 scroll-view |
| TUI 上下文占用 | [2026-10-23 TUI 上下文占用](active/2026-10-23-tui-context-usage.md) | 占用率与会话花费拆开，已过用例与变异验证，待门禁与 PR |
| TUI 忙碌期消息 | [2026-10-24 TUI steer 与排队](active/2026-10-24-tui-busy-message-steer.md) | Enter=steer / Tab=排队 / Esc=打断发送与 `/queue` 逐条管理已落地并过门禁；PR #454 待 review |

没有明确任务时，再按本表顺序选择可执行项。目录和旧 `Status` 头都不能代替接续证据。

## 计划生命周期

- 新任务先查目录，复用已有计划；独立多步骤任务使用[模板](template.md)。
- `active/`：有明确执行承诺的计划；旧文件中的历史合同和 Proposed 提案须按目录说明辨别。
- `backlog/`：尚未承诺或条件未满足的方案。已认领后受阻的任务留在 active，写解除条件。
- `archive/`：本次及后续完成或被替代的记录，保留验证和交付状态并纳入 Git。
- `completed/`：历史目录，混有已跟踪与本地文件；保持原位，不批量加入或删除。
- 完成时更新同一计划，移入 archive，更新目录和入链；未提交或未合并状态必须明确。

## 证据与历史

验证记录随任务保存，带 SHA、环境、命令、退出码和关键结果；基线按本次执行重新记录。
旧测试数字、依赖图与历史计划列表在[索引迁移快照](archive/2026-10-20-index-snapshot.md)，不作为当前基线。

归属与写法见 [docs/AGENTS.md](../AGENTS.md)；跨会话接续见[工程闭环](../development/engineering-loop.md)。
