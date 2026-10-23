# 计划目录

本表用于定位，不重新证明实现状态。既有下一步由旧索引迁入，2026-10-20 未逐项重新验收；执行前核对计划、生产代码和 Git。
用户本次任务优先；没有任务时按[计划入口](README.md)选择，而非自动执行本目录第一项。

## 既有活动计划

| 计划 | 原优先级 | 定位后的核对方向 |
| --- | --- | --- |
| [2026-10-22-panel-column-layout](active/2026-10-22-panel-column-layout.md) | — | 侧面板从单列 tab 改为多列 + 列内堆叠 + 可脱窗；切片 A/B 并行，C/D 第二波 |
| [2026-10-21-public-tree-cleanup](active/2026-10-21-public-tree-cleanup.md) | — | 清理公开根目录，迁移文档入口和打包配置，核对链接与产物 |
| [2026-10-23-multi-agent-orchestrator](active/2026-10-23-multi-agent-orchestrator.md) | — | 多 agent 编排的测试体系与优化方案；Phase 1 补子 agent 状态机测试（当前零覆盖），Phase 2 做 DAG 并行与失败级联 |
| [610 架构主线](active/610-architecture-series/README.md) | P0 | 按 [19 执行队列](active/610-architecture-series/19-fast-track-queue.md) 的追踪表核对；不在此复制卡片状态 |
| [622 平台收口](active/622-agent-platform-convergence/README.md) | P0 | 依赖测量先行：01 修切片图解析（= T19 执行版）→ 02 门禁接线与口径收敛 → 03 `@duya/host` 层归属裁决 → 04 其余无层包；05 客户端轴门禁 · 06 runtime 纯净度 · 07 DAG 并行 · 08 生命周期落盘 · 09 安全治理 · 10 退役与文档事实源 · 11 常驻对账 |
| [08-31-multi-agent-profile-design](active/2026-08-31-multi-agent-profile-design.md) | P1 | Implement plan 7.2 memory partition by profile (migration + `[memory] partition` toggle) |
| [popover-autoflip](active/237-popover-autoflip.md) | P1 | Migrate `HoverPopover` to `usePopoverPlacement`, then `SlashCommandPopover` / `ModelSelector` |
| [permission-decision-bus](active/419-permission-decision-bus.md) | P0 | Add `checkPermissions` + `riskTier` to the MCP tool registration path |
| [search-tools-hardening](active/443-search-tools-hardening.md) | — | Wire `DUYA_RIPGREP_PATH` + timeout/abort into `GrepTool` spawn |
| [read-edit-freshness-protocol](active/448-read-edit-freshness-protocol.md) | P1 | Phase 2/3 — **Task E 已落地**（`WriteTool.ts` 已含 read-first 快照检查），下两项见 plan |
| [multi-protocol-and-wrapper-layer](active/451-multi-protocol-and-wrapper-layer.md) | P0 | Implement Phase 5 Vertex (`api/google-vertex.ts` + `providers/vertex.ts`) |
| [mcp-direct-and-plugin-unification](active/452-mcp-direct-and-plugin-unification.md) | P1 | Remove the dead MCP submenu branch + merge the Apps/MCP constant sections |
| [open-connector-registry](active/455-open-connector-registry.md) | P1 | Close Phase D: run `typecheck:all` + full vitest and record the result |
| [rest-template-connector](active/460-rest-template-connector.md) | P1 | Convert the slack `slack_search_messages` connector to a `.app.json` REST template |
| [grok-bot-framework-overview](active/473-grok-bot-framework-overview.md) | P0 | Close the plan 10 acceptance list once 478 P2.3 (automation group seeding) lands |
| [bot-system-prompt-sections](active/474-bot-system-prompt-sections.md) | P0 | Create the demo bot toml and run G1 prompts typecheck + unit tests (P3.3) |
| [bot-compaction-increment](active/475-bot-compaction-increment.md) | P1 | Implement `automationReminderFingerprint` in turn-prep (P3.1) |
| [shared-rooms-group-chat](active/478-shared-rooms-group-chat.md) | P1 | Wire cron automation to seed a group room (P2.3) |
| [bot-memory-isolation-tiers](active/479-bot-memory-isolation-tiers.md) | P0 | Add the tier filter to the 430 RAG injection path (P2.3) |
| [bot-storage-layout](active/485-bot-storage-layout.md) | P0 | Add `fs.watch` on `agents/<id>/profile.json` -> roster broadcast (P3) |
| [bot-channel-integration](active/488-bot-channel-integration.md) | P1 | Add the P4.3 connector manifest registry (Discord/Slack) to `wake/channels` |
| [bot-chat-dataflow-and-complete-cards](active/489-bot-chat-dataflow-and-complete-cards.md) | P0 | Complete P0.2 - persist card payloads for all 5 SendMessage types |
| [bot-toolset-turn-tool-alignment](active/490-bot-toolset-turn-tool-alignment.md) | P0 | Add the workspace-constrained bash mode to `BashTool` (P2 BoxShell) |
| [bot-chat-messaging-feel](active/491-bot-chat-messaging-feel.md) | P0 | Implement the P0.1 delivery phase machine in `conversation-store` |
| [bot-to-bot-grok-parity](active/492-bot-to-bot-grok-parity.md) | P0 | Extend the bot-direct source whitelist so agent DM entries render (P3) |
| [worktree-framework-implementation](active/496-worktree-framework-implementation.md) | P0 | 统一 Host / legacy 生命周期，再补回收与 worktreeSummary；隔离实现已存在 |
| [bot-connector-elicitation](active/503-bot-connector-elicitation.md) | P1 | Add the `disconnect_app` action + tool row in `AppConnectorManageTool` |
| [image-preview-modal-unification](active/511-image-preview-modal-unification.md) | P1 | Delete the 3 legacy preview components, then collapse the `preview.css` legacy rules |
| [code-review-history](active/518-code-review-history.md) | P2 | Build `<HistoryPanel>` (Branches/Commits tabs) and wire it into CodeReviewPanel |
| [memory-footprint-and-lifecycle-reclamation](active/521-memory-footprint-and-lifecycle-reclamation.md) | P1 | Wire `BrowserPanel` unmount -> `releaseBrowserMemory` (Phase 1a) |
| [project-entity-and-plan-management](active/525-project-entity-and-plan-management.md) | P1 | Run `scripts/migrate-projects-paths.ts --apply` on the dev DB, then delete 522 |
| [projects-core-db-and-main-db-migration](active/534-projects-core-db-and-main-db-migration.md) | P0 | Run the Phase 3.6.a static scan of `widget.*` callers and log `[CONDUCTOR_DUAL_WRITE]` counts |
| [project-menus-use-dropdownmenu](active/535-project-menus-use-dropdownmenu.md) | — | Replace the `BotContactListItem` inline submenu with a `MenuAction` of `kind:'submenu'` |
| [project-context-injection-v2](active/536-project-context-injection-v2.md) | P1 | Add the current `projectId`/name to the bot memory system-prompt section (L3) |
| [workflow-independent-runtime](active/560-workflow-independent-runtime.md) | P0 | Land the Phase 5 `wf.agent` Go/No-Go spike: bind `runAgent` in the child process and journal `nodeKind:'agent'` + usage, or fall back to option C |
| [browser-core-upgrade](active/573-browser-core-upgrade.md) | P0 | Phase 3: add the core-db browsing-history table + migration, hook webview main-frame `did-navigate`, expose `browser:history-*` IPC plus the history view |
| [cua-tree-richness](active/576-cua-tree-richness.md) | P1 | Phase 3 in the ps1 C# probe walk: emit `children_total/shown/offset` for container nodes, plus `surface_kind` and the new-window settle poll |
| [mcp-capability-core-convergence](active/580-mcp-capability-core-convergence.md) | P0 | Run Phase 0's real-machine Notion baseline (instrumented around `RemoteMcpConnector`/`MCPClient` discovery) to record `pages=N, total=M` |
| [session-archive-hardening](active/582-session-archive-hardening.md) | P0 | Storage 与生命周期补强（G1–G4 / UI 轨 G5–G9）—— **此前未列入本索引，2026-10-03 补上**；前置 plan 549 已于 PR #56 落地 |
| [tui-ux-overhaul](active/611-tui-ux-overhaul.md) | P1 | 从 611 及 foundation / bugfix 切片核对当前接续，验收实际 TUI |
| [cli-manual-compaction](active/613-cli-manual-compaction.md) | P2 | 先核对冷 worker 摘要器的 provider 配置探针，再推进 Host / CLI 接线 |
| [cli-markdown-rendering](active/614-cli-markdown-rendering.md) | P1 | 核对 Markdown 渲染与真实终端验收；先检查 615 的接管范围 |
| [cli-unified-tui-engine](active/615-cli-unified-tui-engine.md) | P1 | 对照计划、PR 草稿与 Git 核对已交付项，再选择剩余验收 |
| [duya-app-mcp-layer](active/616-duya-app-mcp-layer.md) | P1 | 按本计划的 T 卡与验证记录接续；桌面扩展另见 618 |
| [外置能力迁移](active/2026-10-22-external-capability-migration.md) | P1 | Browser、Computer Use、Canvas 分别插件化；按阶段验证并保留旧模块 |
| [612 rollout 恢复](active/612-rollout-recovery-hardening.md) | P1 | 先核对 Phase 1 的实际落地与证据，Phase 2/3 决策见正文 |
| [617 基础工具 v2](active/617-basic-tool-interface-v2.md) | P1 | 读取本计划切片和依赖，核对基础工具 schema 与生产接线 |
| [619 提示词组装](active/619-prompt-assembly-context-channel.md) | P0 | Phase 1–5 与 620 Phase A 已合入（PR #365）：两通道投递 + 分类学单源 + `prompt_snapshot` 留痕。**下一动作**：① 定 `prompt_snapshot` 全文落盘的保留期限 / 导出边界（`DUYA_PROMPT_LEDGER=off` 可整体关闭）；② 采真实会话的 hash 表验证 system 前缀逐轮恒定（Phase 0 的产品采样验收）；③ (g) 恢复 `BOT_BASIC_SYSTEM_PROMPT` 单独排期（会改 bot 人格） |
| [620 会话记录架构](active/620-session-record-architecture.md) | P0 | 实现待认领；从 A1 开始，固定 fixture 验证，不读取真实用户 rollout 数据 |
| [621 工作区生命周期](active/621-coding-workspace-lifecycle-harness.md) | P0 | 已合并：A/B/C · 接缝 #370 · D #372 · E #371 · 组装接线 #373 · F（三端 UI + 真实链路验证）#378 → `39f2314f`；三端同一 Host API 回答，场景 1–7 全绿 |
| [CI 提速与测试瘦身](active/2026-10-21-ci-speed-and-test-diet.md) | — | #339（CI 提速）已合并 `052f85cb`；#342（退役 `packages/agent` 291 个测试）仍 open，待授权合并 |
| [CI 提速的后续四项](active/2026-10-21-ci-followups.md) | — | 上面那份之后的四项（typecheck 按依赖图拆分、最慢 7 个测试文件重构、全局状态测试分组串行、12 个契约补测试）；实测数据与验收都在正文 |

## 关联切片与待确认提案

- [611 foundation](active/611-tui-foundation-slice.md)、[611 bugfix](active/611-tui-bugfix-slice.md)：611 的实施与验收记录，不另排队列。
- [615 PR 草稿](active/615-cli-unified-tui-engine-PR.md)：关联 615 的交付说明，不是独立任务。
- [618 桌面管理层](active/618-duya-desktop-management-layer.md)：616 的 Proposed 续章；前置交付状态从 616 核对，不能直接当作 ready。
- [587 历史主线](active/587-agent-harness-monorepo/README.md)：610 的合同来源，不单独排期。

## 已归档

- [2026-10-21 master CI 修复](archive/2026-10-21-ci-green-master.md)：收敛 master 上 95 个失败测试文件与 17 个 E2E 失败；根因、Linux 独有失败与三个 E2E 产品 bug 的修法见正文。
- [Claude Code 式工具组 UI 对齐（P1）](archive/2026-10-23-claude-code-tool-group-parity.md)：轮级汇总行、caret 行尾常显、展开态持久、分组卡片化；PR #368 已合并 `2c91e9b7`。**其中轮级统计已被 P2 回退**，见下一条。
- [工具组 P2：组级折叠态 / diff 增强 / 路径头](archive/2026-10-23-tool-group-flatten-and-diff.md)：路径头 + 复制、diff 语法高亮，以及把折叠态改回「轮级只报耗时、组级承载统计」；PR #374 已合并 `43df59f4`。两份计划的「发现与决策」记了各自的取舍与被改回去的原因。
- [Desktop 性能爬坡](archive/2026-10-23-desktop-performance-hill-climbing.md)：5 个 Agent 独占路径并行（A 的 Harness v1 + B/C/D/E 各自建基线）。**2026-10-23 移交，未完成**——A 的 Harness 与五条基线均未落地，验收从未重跑；「指标契约」与「固定 fixture」两节可复用。

## Backlog

设计或等待条件，不承诺开工；原有理由同样需在认领前核对。

| 计划 | 原搁置原因 |
| --- | --- |
| [button-unification](backlog/309-button-unification.md) | 0-byte file: delete or write |
| [duya-ai-model-list-lazy-loading](backlog/426b-duya-ai-model-list-lazy-loading.md) | 0/21, nothing started |
| [failclosed-command-parsing-and-content-rules](backlog/443-failclosed-command-parsing-and-content-rules.md) | content rules remain dead code |
| [external-agent-invocation](backlog/482-external-agent-invocation.md) | no code started |
| [bot-reliability-ack-and-resume](backlog/484-bot-reliability-ack-and-resume.md) | no code started |
| [dock-layout-and-window-management](backlog/527-dock-layout-and-window-management.md) | idea only |
| [multi-path-sidebar-rendering](backlog/530-multi-path-sidebar-rendering.md) | blocked on 525 Phase 2 `--apply` |
| [model-call-trace](backlog/561-model-call-trace.md) | 0/40, unstarted |
| [tab-shell-workbench](backlog/571-tab-shell-workbench.md) | 0/28, unstarted |
| [chain-ab-runtime-merge-evaluation](backlog/581-chain-ab-runtime-merge-evaluation.md) | decision doc only; execution deferred to plan 582+ |

完整迁移前记录与历史列表见[索引快照](archive/2026-10-20-index-snapshot.md)。
