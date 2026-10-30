# 执行计划

先定位用户本次任务，再读取对应计划的验收与接续点。这里维护路由，不复制各计划的实时状态。

## Active Plans

| 范围 | 入口 | 下一动作 |
| --- | --- | --- |
| 缓存输入与私有进度工具 | [2026-10-29 计数与进度修复](active/2026-10-29-usage-progress-fixes.md) | 修复 Host usage 转换与私有控制工具执行，真实 worker 回归通过，等待类型门禁与 PR |
| Provider 校验与运行收尾 | [2026-10-29 校验与收尾修复](active/2026-10-29-provider-validation-finalization.md) | 本地门禁通过，后续 PR #548 依赖 #546，待 review/集成 |
| TUI fetch failed 与渲染卡顿 | [2026-10-29 TUI fetch failed 与 write 渲染卡顿](active/2026-10-29-tui-fetch-failed-and-write-render-lag.md) | Host keep-alive 超时 + 轮询错误附 cause + 渲染缓存按 block revision 键控；门禁与 cli-tui/host 测试全绿，PR #547 等 review 与授权 |
| 产品独立发布 | [2026-10-29 Desktop 与 CLI 独立发布](active/2026-10-29-product-release-separation.md) | Desktop / CLI 独立 tag 与 workflow；CLI 自包含包、校验和 Codex 风格安装器 |
| 模型输出截断恢复 | [2026-10-29 输出截断恢复](active/2026-10-29-output-truncation-recovery.md) | 输出预算传递与有界续写已实现；282 项回归及类型/架构门禁通过，Draft PR #536 等 CI/review |
| TUI 租约韧性 | [2026-10-26 TUI 租约丢失与事件流中断](active/2026-10-26-tui-lease-loss-resilience.md) | Host lease 生命周期日志 + idle 停机先等回合 settle、可被重附着取消；CLI 重申请 lease 并从游标续订事件流；PR #505 已合并（`eaa33d80`），真机冒烟待用户 |
| TUI 四能力系列 | [630 系列](active/630-tui-capabilities-series/README.md) | 630a 与 632 的 Host 写面已实现待合并；面板两片等 630a 合入后开工 |
| TUI 插件查看与 mention | [2026-10-25 TUI 插件查看与 mention](active/2026-10-25-tui-plugin-view-and-mention.md) | 四查看命令交互化 + `@` 插件 mention 已过门禁；steer 改写已补，PR #497 已合并（`3213e6e0`），真机冒烟待用户 |
| 面板实现统一 | [2026-10-25 面板实现统一](active/2026-10-25-panel-implementation-unification.md) | preview 页与手写 hunk 渲染已删（净 −2099 行）；PR #486 已合并，e2e 已补，真机冒烟待用户 |
| 下一步建议下沉 | [2026-10-25 下一步建议下沉到 worker/Host](active/2026-10-25-next-step-suggestion-host.md) | S0 摸底完成；S1 起做 protocol + data 契约与表；PR #496 已合并 |
| TUI 下一步建议采纳 | [2026-10-28 TUI 建议采纳与会话边界](active/2026-10-28-tui-turn-suggestion-adopt-and-reset.md) | 空输入按 Enter 采纳建议填入输入框；换会话清空旧建议；PR #532 已合并（`356d0370`），真机冒烟待用户 |
| 面板脱窗渲染闭环 | [2026-10-25 面板脱窗渲染](active/2026-10-25-panel-popout-render.md) | 脱窗 UI 闭环与 resize 药丸语言已过门禁；PR #493 已合并，真机冒烟待用户 |
| Mini App 面板打开 | [2026-10-25 Mini App 面板打开](active/2026-10-25-mini-app-panel-open.md) | launcher 改面板打开与授权弹窗挂主窗口已过门禁；PR #485 已合并，真机冒烟待用户 |
| 个人长期 Bot 框架 | [2026-10-25 Bot 框架](active/2026-10-25-personal-bot-framework.md) | S0–S6-A 已合并（#495、#521）；S7 旧路径退役另立切片 |
| Workflow 并发恢复 | [2026-10-24 workflow 并发上限持久化](active/2026-10-24-workflow-retune-persistence.md) | live workflow 的并发上限更新已持久化；PR #453 待 review 与集成授权 |
| TUI 粘贴附件 | [2026-10-24 TUI 粘贴附件](active/2026-10-24-tui-paste-attachments.md) | 附件与 `!` 卡片已落地；PR #467 与 master 的合并冲突已解，待 review、CI 与集成授权；真机冒烟未跑 |
| 字体系统对齐 | [2026-10-24 字体系统对齐](active/2026-10-24-font-system-alignment.md) | 三栈收敛 + FontContext 拆除已过门禁，开 PR 待集成 |
| TUI 工具状态 | [2026-10-24 TUI 工具状态](active/2026-10-24-tui-tool-status-marks.md) | 门禁已过，PR #457 等 CI 与授权集成 |
| 动态工作流核心包 | [2026-10-24 动态工作流核心包](active/2026-10-24-dynamic-workflow-package.md) | S0 已对账并记录基线；提交文档切片后定 S1 包边界并抽取零 IO 核心 |
| 插件 UI MCP 资源 | [2026-10-24 插件 UI MCP 资源](active/2026-10-24-plugin-ui-mcp-resources.md) | 完成 S1 契约后先报告 schema diff 与受影响调用方，再推进 S2 |
| 输出速度 tok/s | [2026-10-23 输出速度](active/2026-10-23-output-token-rate.md) | provider 校准路径：ai 测时长 → 协议契约 → 帧携带 → TUI 展示 |
| 面板列树布局 | [2026-10-22 面板列树](active/2026-10-22-panel-column-layout.md) | 切片 A（列树渲染）与 B（脱窗 Electron 侧）并行开工；C/D 待 A 落地 |
| 本次新建对话页对齐 | [2026-10-27 新建对话页布局](active/2026-10-27-new-chat-layout.md) | 最近会话列表已删、环境卡与三段式布局已过门禁并真机量测；待全量门禁后提交 |
| Web 浏览器端到端验收 | [2026-10-27 Web 浏览器验收](active/2026-10-27-web-browser-acceptance.md) | 真 Host + 生产 worker + 受控 provider + 真浏览器跑通发送/工具/审批/取消/刷新重放，6/6 通过；PR #529 已合并（`dcec5c15`） |
| Web BFF 可运行入口 | [2026-10-27 Web BFF 入口](active/2026-10-27-web-bff-runnable-entry.md) | web server 打成自包含 ESM，`node apps/web/dist/server/main.js` 免 `--import`；PR #527 已合并（`ed473722`） |
| 本次侧栏对齐 | [2026-10-22 侧栏对齐](active/2026-10-22-sidebar-alignment.md) | 已在最新 master 重建分支，实现行级状态图标、分组头三按钮与组内搜索 |
| 本次公开树整理 | [2026-10-21 仓库树整理](active/2026-10-21-public-tree-cleanup.md) | 清理公开根目录、移动中文入口/架构文档并验证打包路径 |
| 本次文档整理 | [2026-10-20 文档体系](active/2026-10-20-documentation-system.md) | 文档已整理；待处理文档范围外的两处门禁失败，见接续记录 |
| 单 Host 多客户端 | [2026-10-22 Desktop 与 TUI 共用 Host](active/2026-10-22-single-host-multiclient.md) | 先做 health 能力字段与 TUI 自动 attach |
| 架构主线 | [610 执行队列](active/610-architecture-series/19-fast-track-queue.md) | 只从该文档追踪表选择未完成卡；不从旧编号重排 |
| Harness 正确性 | [2026-10-24 Harness 审计](active/2026-10-24-harness-correctness-audit.md) | 契约 + H-1~H-6 修复随 base=master 的 PR 进 master；CI 会跑 |
| 平台收口 | [622 依赖测量先行](active/622-agent-platform-convergence/README.md) | 01 已合入（PR #399）；02 已提交（`73c067c4`）并开 PR #405；architecture/typecheck/build 通过，全量 test 的 2 个 IPC 失败在 base 复现 |
| 工作区生命周期 | [621 生命周期 Harness](active/621-coding-workspace-lifecycle-harness.md) | P0 #460、P1a #465 未合并；P1b–P4 代码已实现；373 项相关测试与浏览器链路通过，按用户要求通过 [Draft #476](https://github.com/lava-chen/duya/pull/476) 交接；全量类型门禁和完整三端验收待接手 |
| 多 Agent 编排 | [2026-10-23 多 Agent Orchestrator](active/2026-10-23-multi-agent-orchestrator.md) | 评估已出：codex 无队列/DAG/重试可抄；duya 依赖与重试已具备。Phase 1 补测（子 agent 状态机零覆盖）→ Phase 2 DAG 并行 + 失败级联 |
| Agent Runtime 真实基准 | [2026-10-23 Agent Runtime 基准](active/2026-10-23-agent-runtime-e2e-benchmark.md) | 基准已跑通并定位瓶颈；待 PR 集成 |
| Desktop 性能爬坡 | [2026-10-23 Desktop 性能爬坡](active/2026-10-23-desktop-performance-hill-climbing.md) | 5 个 Agent 各占一条独占路径：先由 A 交 Harness v1，再由 B/C/D/E 建基线、各出一个可证明收益的 PR |
| CLI TUI 渲染 todolist | [2026-10-23 CLI todo 渲染](active/2026-10-23-cli-todo-list-render.md) | todo 清单渲染与 thinking 折叠预览已合并（PR #387）；底部常驻面板列 Phase 2 |
| config 写侧下沉 | [2026-10-25 config 写侧下沉](active/2026-10-25-host-config-agents-write.md) | 共享规则已下沉 `packages/host/config-agents`，Host bridge 接上 `config:agents:create/update`；PR #433 已合并（`f59767f1`） |
| 插件安装路径下沉 | [2026-10-25 插件安装路径](active/2026-10-25-host-plugin-install-path.md) | 独立 Host 已能解析插件 `installPath` 与 MCP 声明，恢复插件技能与 MCP；PR #443 已合并（`49b4771e`） |
| computer-use 插件 | [2026-10-24 computer-use 插件审计](active/2026-10-24-computer-use-plugin-audit.md) | 在插件仓库建独立检出并完成 S0 基线：读实现、跑测试、记录 Windows skip 与退出码 |
| 内置插件随本体分发 | [2026-10-24 内置插件随本体分发](active/2026-10-24-builtin-plugin-distribution.md) | 已实现并推 draft PR（主仓 #445、marketplace #4）：清单在插件仓、seed 改为 copy-then-swap、清单决定默认启停 |
| rollout 换桶判定 | [2026-10-25 rollout 换桶](active/2026-10-25-data-rollout-bucket.md) | `appendBatch` 不再每批重命名 rollout 文件（路径带毫秒戳导致判定恒成立）；写路径耗时降 59%–68%；PR #462 已合并（`55cd1b97`） |
| 读路径 fd 复用 | [2026-10-25 读路径 fd 复用](active/2026-10-25-data-read-range-fd.md) | 投影会话时一次打开 rollout 文件复用句柄，不再逐行 open/close；8000 条投影 656ms → 68ms；PR #466 已合并（`3b3e6470`） |
| 消息写路径点查 | [2026-10-25 写路径点查](active/2026-10-25-data-append-index-lookup.md) | `appendBatch` 去重检查按批内 id 走主键点查，去掉长会话上的 O(N²)；待开 PR |
| 网关通道能力补全 | [623 通道能力补全](active/623-gateway-channel-capability-parity.md) | 适配器层已交付并过类型/架构/单测（177 项）；下一步 Phase 3 接线 Host/Desktop 平台枚举 |
| 其他产品任务 | [完整目录](catalog.md) | 定位用户指定主题，核对实际进度与依赖后认领 |
| TUI 滚动语义 | [2026-10-23 TUI 滚动锚定](active/2026-10-23-tui-scroll-anchor.md) | 视窗改为绝对偏移 + 独立 follow，PR #388 已合并（`aec08d75`） |
| TUI inline 滚动 | [2026-10-24 TUI inline 滚动](active/2026-10-24-tui-inline-scroll.md) | inline 不再接管滚轮，滚动交还终端 scrollback；修 `viewEnd` → `viewTop`，并拦住会让流式画面冻结的上滚入口 |
| TUI 上下文占用 | [2026-10-23 TUI 上下文占用](active/2026-10-23-tui-context-usage.md) | 占用率与会话花费拆开，已过用例与变异验证，待门禁与 PR |
| TUI 后台任务视图 | [2026-10-24 TUI 后台任务视图](active/2026-10-24-tui-background-tasks.md) | Host 只读路由、subagent 投影、摘要行与任务视图已落地并过门禁；已合并 master（`8449a39b`），PR #464 等 CI 重跑与授权集成 |
| TUI 忙碌期消息 | [2026-10-24 TUI steer 与排队](active/2026-10-24-tui-busy-message-steer.md) | Enter=steer / Tab=排队 / Esc=打断发送与 `/queue` 逐条管理已落地并过门禁；PR #454 待 review |
| TUI 项目概念统一 | [2026-10-28 TUI 项目概念统一](active/2026-10-28-tui-project-catalog.md) | TUI `/project` 从会话派生目录改为读 `projects` 表，新增 `/project add`；推翻 633「不取 `/v1/projects`」的决定 |
| 市场来源删除与隐藏 | [2026-10-25 市场来源可见性](active/2026-10-25-marketplace-source-visibility.md) | 已合并（PR #492，`333b025a`）；仅剩真机 Electron 点击验收未跑 |
| 插件 App 主题通道 | [2026-10-27 插件 App 主题通道](active/2026-10-27-plugin-app-theme-channel.md) | 宿主向沙箱 iframe 推 `data-theme`；插件侧 token 层在 marketplace PR，两者需成对生效 |
| TUI 本地 shell UI | [2026-10-28 TUI 本地 shell 命令的专属 UI](archive/2026-10-28-tui-shell-command-ui.md) | composer 红色 `!` 提示符 + 本地命令 "You ran" 独立卡片；PR #533 已合并（`bd526d3b`），真机冒烟待用户 |
| TUI 权限 banner | [2026-10-29 TUI 权限 banner 与 Shift+Tab 快速切换](archive/2026-10-29-tui-permission-banner.md) | footer 右下角权限徽标 + Shift+Tab 循环（bypass 二次确认）；PR #538 已合并（`73710504`），真机冒烟待用户 |
| TUI 补全弹窗行宽 | [2026-10-29 TUI 补全弹窗的行宽](archive/2026-10-29-tui-popup-row-width.md) | 候选描述截断而非折行，弹窗不再比预留高、最后一个候选重新可见；修 #531 带进 master 的既有红用例；PR #542 已合并（`c8b47c3f`） |

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
