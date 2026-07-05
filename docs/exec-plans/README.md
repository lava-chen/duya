# Execution Plans

> **This is the first place to check before any work!** See workflow below.

---

## Quick Workflow

```
1. Check this README for current work status
2. Find relevant plan in Active Plans table
3. Read the plan file to understand progress
4. Implement following the plan's phases
5. Complete: mark [x] checkboxes, move to completed/ if done
```

---

## Structure

```
exec-plans/
├── active/           # Plans currently being executed
├── completed/        # Finished plans with decision logs
└── tech-debt-tracker.md
```

## Active Plans

Plans in `active/` are being executed with clear phases and checkpoints.

### Agent Feature Parity Plans

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [25-skills-completion-plan](./active/25-skills-completion-plan.md) | 官方 Skill 补全计划 (hermes-agent 等) | P1 | 进行中 |
| [30-mcp-loading-implementation](./active/30-mcp-loading-implementation.md) | MCP 服务器加载与连接实现 | P0 | Phase 1-3 ✅ |
| [38-mcp-marketplace-install](./active/38-mcp-marketplace-install.md) | MCP 市场与一键安装实现 | P1 | 待开始 |
| [38-chat-generative-ui](./active/38-chat-generative-ui.md) | Chat Generative UI — Widget 系统 V2 升级 | P1 | Phase 1-4 ✅  Phase 5 🔴 |
| [82-researcher-codex-ui-alignment](./active/82-researcher-codex-ui-alignment.md) | Researcher Codex UI Alignment — Codex 级 Agent UX + 科研助手定位 | P0 | Planning |
| [83-plugin-codex-ui-alignment](./active/83-plugin-codex-ui-alignment.md) | Plugin Codex UI Alignment — capability marketplace and settings UX | P1 | Planning |
| [84-research-agent-memory-and-literature-plugin](./active/84-research-agent-memory-and-literature-plugin.md) | Research Agent Memory + Literature Plugin — 独立文献插件与研究记忆子系统 | P1 | Planning |
| [203-provider-ui-interaction-architecture](./completed/203-provider-ui-interaction-architecture.md) | Provider UI 4 层架构（Query / Hook-per-concern / Orchestrator / Wiring）— Phase 1+2+3 之后的地基重构，**不改 UX 减 1900 行** | P1 | Phase 0–5 ✅ |
| [204-provider-card-redesign](./completed/204-provider-card-redesign.md) | Provider Card UX 重做 — 在 Plan 203 4 层架构之上，对齐 cc-switch 卡片视觉（hover 操作区 + 右上角 Add + 测试/限额查询/删除 + 删诊断）— `ProvidersSection` 1066→246 LoC | P1 | Plan 204 done 2026-06-10 |
| [205-provider-inline-edit-page](./active/205-provider-inline-edit-page.md) | Provider Inline Edit Page + Two-Step Add Flow — 用 settingsTab 子页面（picker → edit）替代 modal `ProviderConnectDialog`，store 驱动 | P1 | Phase A-F done, G in progress |

### Plugin System Enhancement Plans (Claude Code Alignment)

> Reference: [claude-code-haha plugin system comparison analysis](../design-docs/2026-05-28-plugin-system-comparison.md)

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [85-builtin-plugin-flexibilization](./active/85-builtin-plugin-flexibilization.md) | Built-in Plugin 约定优于配置 — 目录自描述 + Markdown 元信息 | P0 | Planning |
| [86-schema-manifest-llm-friendly](./active/86-schema-manifest-llm-friendly.md) | Schema 宽松化 — Agent 可理解的 plugin.md 分层设计 | P0 | Planning |
| [87-hook-system-full-enhancement](./active/87-hook-system-full-enhancement.md) | Hook 系统全面升级 — 4 类型 + 29 事件 + Async + Matcher | P0 | Planning |
| [88-plugin-discovery-multi-source](./active/88-plugin-discovery-multi-source.md) | 插件多源发现 — GitHub / NPM / Git / URL / Local + 优先级合并 | P1 | Planning |
| [89-plugin-lifecycle-version](./active/89-plugin-lifecycle-version.md) | 生命周期与版本管理 — 版本化缓存 + Scope + 依赖验证 + 自动更新 | P1 | Planning |
| [90-marketplace-system-implementation](./active/90-marketplace-system-implementation.md) | 插件市场系统 — catalog + 企业策略 + 防冒名 + 同步管理 | P1 | Planning |
| [91-structured-error-handling](./active/91-structured-error-handling.md) | 结构化错误处理 — 28 种可区分联合类型 PluginError | P1 | Planning |
| [92-plugin-security-enterprise-policy](./active/92-plugin-security-enterprise-policy.md) | 安全与企业策略 — Trust Level + 路径防护 + 权限执行 + Enterprise Policy | P0 | Planning |
| [96-duya-cli-tool](./active/96-duya-cli-tool.md) | DUYA CLI — 统一命令行工具 (plugin / session / doctor / skill / provider / mcp / install-cli / agent integration) | P0 | Phases 0–8 Complete |
| [98-cli-channel-cron-message](./active/98-cli-channel-cron-message.md) | CLI Channel / Cron / Message + Command-Registration Refactor — 3 new domains (channel/cron/message) + descriptor-driven registry | P0 | Phase A 🟡, B–F 📋 |
| [99-cli-split-and-control-plane](./active/99-cli-split-and-control-plane.md) | CLI Split — `packages/cli` workspace, Electron routes (channels/crons/messages), cron HTTP PATCH/DELETE contract, agent tool structured dispatcher, audit `invokedBy` tagging | P0 | Phases 0–9 ✅, canUseTool deferred to Plan 97 |
| [102-duya-config-into-cli](./active/102-duya-config-into-cli.md) | Merge `duya_config` into `duya_cli` — single agent config entry, `duya config {provider,settings,vision,style,pairing}` + `duya mcp add/remove/assign`, retire `DuyaConfigTool` | P1 | Planning |
| [103-research-mode-persistence-hardening](./active/103-research-mode-persistence-hardening.md) | Research Mode Persistence Hardening — `persistResearchSSEEvent` 优雅降级 + 修复 mode dispatch 中伪同步 IPC DB 调用 + research mode sessionId 缺失时 fail-fast | P1 | Phase 1–3 ✅ |
| [105-code-agent-profile-runtime-wiring](./completed/105-code-agent-profile-runtime-wiring.md) | Code Agent Profile Runtime Wiring & Tool Diagnostics — `promptProfile` 真正生效 (Code/General/Research/Conductor) + `PromptsRegistry` 缓存按 profile 实例化 + Tool filter diagnostic + code prompt 条件注入 | P0 | ✅ Complete |
| [104-proactive-memory-enhancement](./active/104-proactive-memory-enhancement.md) | Proactive Memory 主动记忆增强 — RealTimeCapture hook + 3D 评分反思 + 双路径 Recall + 时序衰减归档（基于 claude-code-haha / hermes-agent / openclaw / duya 四方对比）| P1 | Planning |
| [200-cli-surface-expansion](./active/200-cli-surface-expansion.md) | CLI Surface Expansion — `duya update / backup / security` (openclaw-comparison) + polish existing (status / plugin / config / session / message / mcp / skill / channel / cron / gateway) | P1 | All phases ✅ |
| [201-cli-packaged-smoke-fixes](./active/201-cli-packaged-smoke-fixes.md) | CLI Packaged Smoke-Test Fixes — `adaptIdFirst` for `(id,format)` info commands, auto-inject `--format`, auto-dispatch `default` sub, add missing `channel_directory` table, drop `setup` from control plane | P0 | Phases 1–5 ✅, Phase 6 ⏳ (verify on next packaged build) |
| [107-cron-cli-bugfix](./active/107-cron-cli-bugfix.md) | Cron CLI Bugfix — `info` / `message show` DTO wrap, `delete` 500 ReferenceError, schedule field-name UX, CI does not typecheck `electron/` | P0 | Phase 1 ✅, Phase 2 📋 |
| [108-cli-channel-list-and-help](./active/108-cli-channel-list-and-help.md) | CLI Channel list / channel --help bugfix — merge `channel_bindings` into `duya channel list`; wire `--help` / `help` for every descriptor-driven top-level command | P0 | Planning |
| [220-attachment-unification](./active/220-attachment-unification.md) | Chat input attachment unification — collapse 5 parallel state machines (paste/file/file-chip/terminal-ref/browser-ref) into 1 `pendingAttachments: FileAttachment[]` + 1 `<AttachmentBar>` + marker deletion with read-only legacy adapter | P1 | Phase 0–7 ✅ (decision log filled; not yet moved to completed) |
| [221-conductor-main-agent-injection](./active/221-conductor-main-agent-injection.md) | Conductor 主 Agent 注入 — 取消画布独立 agent，改由主界面 agent 控制 (5 工具 + prompt overlay + 智能绑定 + UI toggle) | P0 | Implemented (9.3/9.4/9.5 deferred) |
| [101-plugin-system-cleanup](./completed/101-plugin-system-cleanup.md) | Plugin System Cleanup & Runtime Wiring — 死代码清理 (`runtimeFactories` / `plugins/literature` / `PermissionService` override) + 接入路径修正 + capabilityCounts 派生 | P1 | Complete |

| [215-office-workspace](./active/215-office-workspace.md) | Office side-panel workspace for DOCX/PPTX/XLSX preview, selection context, and Agent-driven edits | P1 | Phase 1 complete; Phase 2 pending |
| [216-file-preview-workspace](./active/216-file-preview-workspace.md) | Expanded read-only file preview workspace with tabs, project tree, and persistent composer | P1 | Implementation complete; visual smoke environment-blocked |

### Infrastructure & Architecture Plans

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [15-bash-worker-implementation](./active/15-bash-worker-implementation.md) | Bash Worker 多进程实现 | P0 | 设计完成 |
| [27-logging-and-auto-update](./active/27-logging-and-auto-update.md) | 日志系统与自动更新功能 | P1 | 代码完成，待 UI 集成 |
| [28-multi-source-update-fallback](./active/28-multi-source-update-fallback.md) | 自动更新多源回退方案 | P1 | 待实现 |
| [97-tool-path-permission-refactor](./active/97-tool-path-permission-refactor.md) | Read/Write/Edit 路径权限重构 — 委托到权限系统，修复 bypass 模式 | P0 | Planning |
| [31-conductor-overview](./active/31-conductor-overview.md) | Conductor 动态 Agent 工作台总览 | P0 | 待开始 |
| [32-conductor-foundation](./active/32-conductor-foundation.md) | Conductor 数据、通信与架构护栏 | P0 | Phase 1 ✅ |
| [33-conductor-canvas-ui](./active/33-conductor-canvas-ui.md) | Conductor 画布 UI 与内置 Widget V1 | P0 | Phase 1-4 ✅ |
| [35-conductor-widget-extensibility](./active/35-conductor-widget-extensibility.md) | Conductor Widget 扩展性与动态安全边界 | P1 | 待开始 |
| [36-conductor-blueprint-implementation](./active/36-conductor-blueprint-implementation.md) | Conductor 蓝图交互闭环实施 | P0 | 进行中 |
| [66-async-nonblocking-subagent](./active/66-async-nonblocking-subagent.md) | Async Non-Blocking SubAgent 执行 — 子Agent非阻塞启动，主Agent可并行工作 | P0 | Planning |
| [37-subagent-nested-session](./active/37-subagent-nested-session.md) | SubAgent 嵌套会话侧边栏展示 | P1 | Planning |
| [39-beta-launch-preparation](./active/39-beta-launch-preparation.md) | Beta 发布准备 | P0 | 进行中 |
| [48-canvas-element-data-model](./active/48-canvas-element-data-model.md) | Canvas Elements 类型系统 | P0 | 设计阶段 |
| [54-electron-directory-restructure](./active/54-electron-directory-restructure.md) | Electron 目录架构重构 | P1 | Phase 1 ✅, Phase 2 🔴 |
| [60-research-mode](./active/60-research-mode.md) | Research Mode — 迭代研究工作流 + Interactive Report | P1 | 规划中 |
| [94-research-mode-loop-improvement](./active/94-research-mode-loop-improvement.md) | Research Mode Research Loop 核心改进 — 动态排序、StopDecision、SourceEvaluator、去重服务 | P1 | Milestone 1 ✅, M2.1-3 📋 |
| [62-gateway-ipc-refactor](./active/62-gateway-ipc-refactor.md) | Gateway ↔ IPC 架构重整 | P0 | 进行中 |
| [64-browser-parallel-isolation](./active/64-browser-parallel-isolation.md) | 浏览器多 Tab 隔离与并行执行 | P0 | 进行中 |
| [106-node-file-parser-and-read-integration](./active/106-node-file-parser-and-read-integration.md) | Node File Parser & Read 工具集成 — 把 Python sidecar 迁到 Node 内嵌解析,Read 工具升级多模态(PDF/DOCX/PPTX/图片) | P1 | ✅ Complete |
| [65-recap-feature](./active/65-recap-feature.md) | Session Recap — 离开回来后自动显示会话摘要 | P1 | Planning |
| [95-external-agent-import](./active/95-external-agent-import.md) | External Agent Workspace Import — 从 Claude Code / Codex 导入项目上下文、记忆、技能 | P1 | Phase 1 ✅ |
| [202-agent-mailbox](./active/202-agent-mailbox.md) | AgentMailbox — Codex-like 运行时追加指令 (`agent_mailbox` + 9 checkpoint + soft interrupt + claim/lease) — PR1 数据层 / PR2 接入 `before_model_turn` / PR3 final / PR4 permission / PR5 tool guard | P0 | Planning |
| [212-subagent-task-notification](./active/212-subagent-task-notification.md) | SubAgent Task-Notification Channel (claude-code-haha alignment) — `<task-notification>` XML envelope + `messageQueueManager.mode='task-notification'` + `notified` idempotency, UI 隐藏系统消息 | P1 | Implementation complete |
| [214-agent-core-audit](./active/214-agent-core-audit.md) | Agent Core Audit — full read-only audit of agent runtime, IPC, renderer, DB, lifecycle, packaging. Phased: Phase 1 audit done, Phase 2 gated by user. | P0 | Phase 1 ✅ (audit only), Phase 2 ⏳ awaiting confirmation |
| [222-interagent-message-session](./active/222-interagent-message-session.md) | Inter-Agent Communication — MessageSession tool for cross-session agent Q&A with cycle detection and timeout | P1 | Phase 1-9 ✅ |

### Canvas V2 Whimsical 风格重设计

> Design doc: [docs/design-docs/conductor-canvas-v2-whimsical.md](../design-docs/conductor-canvas-v2-whimsical.md)

| Plan | Description | Priority | Depends On |
|------|-------------|----------|-----------|
| [70-canvas-v2-type-system](./active/70-conductor-canvas-v2-type-system.md) | Phase 1: 统一节点模型 + 类型系统 + DB + IPC + Store | P0 | — |
| [71-canvas-v2-native-rendering](./active/71-conductor-canvas-v2-native-rendering.md) | Phase 2: Shape + Text + Sticky + Section 原生渲染 | P0 | 70 |
| [72-canvas-v2-connector](./active/72-conductor-canvas-v2-connector.md) | Phase 3: Connector 系统 (Bezier 曲线 + 端点绑定) | P0 | 70, 71 |
| [73-canvas-v2-mindmap-frame](./active/73-conductor-canvas-v2-mindmap-frame-toolbar.md) | Phase 4-6: MindMap + Frame + 工具栏 + 交互 | P0 | 71, 72 |
| [74-canvas-v2-agent-integration](./active/74-conductor-canvas-v2-agent-integration.md) | Phase 7-8: Agent 工具 + Image + 主题 + 轻量外壳 | P0 | 70, 71, 72, 73 |

| [81-mindmap-interaction-correction](./active/81-mindmap-interaction-correction.md) | Follow-up: root move + subtree reorder + draft node flow | P0 | 73 |
| [223-conductor-canvas-style-and-group](./active/223-conductor-canvas-style-and-group.md) | Post-mindmap: sticky/connector 样式扩展(shape/border/stroke) + Group 元素松散绑定 + 4 个 group tool + 属性面板 | P1 | 71, 72, 73 |

### Compact System Fix Plans

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [03-compact-critical-fix](./completed/03-compact-critical-fix.md) | Compact 系统关键修复（LLM摘要、Boundary、前端渲染） | P0 | ✅ Complete |

### First Test Bug Fix Plans (Beta Launch Blockers)

Source: [problems-analysis.md](./problems-analysis.md) — 10 个首次测试问题分析

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [41-onboarding-experience-overhaul](./active/41-onboarding-experience-overhaul.md) | 引导流程大修 | P0 | 待开始 |
| [42-document-parser-service](./active/42-document-parser-service.md) | 文档解析服务 | P1 | Phase 1 待开始 |
| [43-startup-landing](./active/43-startup-landing.md) | 首次启动品牌化 landing 页 — 覆盖 window 打开 → React mount → DB hydrate → session 渲染整个空白期，200ms 淡出，仅首次启动 | P1 | Phase 1 ✅ |
| [44-skills-sync-fix](./active/44-skills-sync-fix.md) | Skills 同步修复 | P0 | In Progress |

### Wiki Agent — Persistent Knowledge Network

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [56-wiki-agent-overview](./active/56-wiki-agent-overview.md) | Wiki Agent 架构总览与实施路线 | P1 | 待开始 |
| [57-wiki-agent-core](./active/57-wiki-agent-core.md) | Phase 1: 核心实现（类型、NodeStore、GraphManager、Profile） | P1 | 待开始 |
| [58-wiki-agent-listener](./active/58-wiki-agent-listener.md) | Phase 2: Listener 被动提取（会话结束→提取→建链） | P1 | 待开始 |
| [59-wiki-agent-gardener](./active/59-wiki-agent-gardener.md) | Phase 3: Gardener 主动巡检（六项检查，Scheduler 注册） | P2 | 待开始 |
| [61-wiki-agent-deep-research](./active/61-wiki-agent-deep-research.md) | Phase 4: Deep Research 双向集成（增量规划） | P2 | 待开始 |
| [77-wiki-agent-v0.5-overview](./active/77-wiki-agent-v0.5-overview.md) | WikiAgent v0.5 总览（全局监听 + 独立 prompts + 保守 merge + app UI） | P1 | 待开始 |
| [78-wiki-agent-global-observer-core](./active/78-wiki-agent-global-observer-core.md) | Phase 1: 全局监听、统一 queue、node store、读工具 | P1 | 待开始 |
| [79-wiki-agent-prompt-merge](./active/79-wiki-agent-prompt-merge.md) | Phase 2: 独立 prompt system、候选提取、保守自动合并 | P1 | 待开始 |
| [80-wiki-agent-app-ui](./active/80-wiki-agent-app-ui.md) | Phase 3: Memory 页面、Inbox、Activity、Merge 预览 | P1 | 待开始 |

## Completed Plans

Moved here when finished. Each includes:
- Original goal and outcome
- Key decisions made during execution
- Lessons learned

| Plan | Description | Completed |
|------|-------------|-----------|
| [02-context-compaction-system](./completed/02-context-compaction-system.md) | Context Compression 系统 | 2026-04-09 |
| [skill-system](./completed/skill-system.md) | Skill System Phase 2 | 2026-04-09 |
| [cli-tool-fix](./completed/cli-tool-fix.md) | CLI 工具调用问题修复 | 2026-04-09 |
| [03-query-engine-separation](./completed/03-query-engine-separation.md) | QueryEngine 分离 | 2026-04-15 |
| [10-openharness-comparison-and-improvement](./completed/10-openharness-comparison-and-improvement.md) | OpenHarness 对比与 CLI 增强 | 2026-04-15 |
| [problems](./completed/problems.md) | 打包后遇到的问题修复 | 2026-04-15 |
| [12-config-manager-implementation](./completed/12-config-manager-implementation.md) | ConfigManager 实现 | 2026-04-18 |
| [13-message-port-lifecycle](./completed/13-message-port-lifecycle.md) | MessagePort 生命周期管理 | 2026-04-20 |
| [14-tool-stream-buffer](./completed/14-tool-stream-buffer.md) | Tool Stream Buffer 实现 | 2026-04-20 |
| [16-sse-to-messageport-unification](./completed/16-sse-to-messageport-unification.md) | SSE → MessagePort 统一通信 | 2026-04-22 |
| [18-api-routes-to-ipc-migration](./completed/18-api-routes-to-ipc-migration.md) | API Routes → IPC 迁移 | 2026-04-22 |
| [18-zero-router-architecture](./completed/18-zero-router-architecture.md) | Zero Router 架构实施 | 2026-04-22 |
| [21-nextjs-to-vite-migration](./completed/21-nextjs-to-vite-migration.md) | Next.js → Vite 前端迁移 | 2026-04-22 |
| [22-singleton-daemon-architecture](./completed/22-singleton-daemon-architecture.md) | 单例守护进程架构 | 2026-04-23 |
| [23-data-persistence-fixes](./completed/23-data-persistence-fixes.md) | 数据持久化修复 | 2026-04-24 |
| [24-self-improvement-system](./completed/24-self-improvement-system.md) | 自我提升 Skill 质量控制 | 2026-04-24 |
| [11-messageport-architecture](./completed/11-messageport-architecture.md) | MessagePort 架构实施 | 2026-05-08 |
| [14-database-architecture-refactor](./completed/14-database-architecture-refactor.md) | Golden Trident 数据架构重构 | 2026-05-08 |
| [19-database-ownership-unification](./completed/19-database-ownership-unification.md) | 数据库所有权统一 | 2026-05-08 |
| [21-automation-cronjob-workflow](./completed/21-automation-cronjob-workflow.md) | 自动化定时任务系统 | 2026-05-08 |
| [25-platform-gateway](./completed/25-platform-gateway.md) | 平台网关 | 2026-05-08 |
| [25-streaming-state-architecture-refactor](./completed/25-streaming-state-architecture-refactor.md) | 流式状态架构重构 | 2026-05-08 |
| [26-prompt-mode-architecture](./completed/26-prompt-mode-architecture.md) | PromptMode 架构设计 | 2026-05-08 |
| [28-telegram-enhancement](./completed/28-telegram-enhancement.md) | Telegram 功能增强 | 2026-05-08 |
| [01-tool-interface-enhancement](./completed/01-tool-interface-enhancement.md) | Tool 接口增强 | 2026-05-08 |
| [06-abort-controller-propagation](./completed/06-abort-controller-propagation.md) | AbortController 传播链 | 2026-05-08 |
| [05-tool-orchestration-enhancement](./completed/05-tool-orchestration-enhancement.md) | Tool Orchestration 增强 | 2026-05-08 |
| [29-multi-agent-profile-system](./completed/29-multi-agent-profile-system.md) | 多 Agent Profile 系统 | 2026-05-16 |
| [34-conductor-agent-orchestration](./completed/34-conductor-agent-orchestration.md) | Conductor Agent 感知与编排 | 2026-05-16 |
| [40-agent-self-management](./completed/40-agent-self-management.md) | Agent 自管理工具 | 2026-05-16 |
| [42-extension-install-ux](./completed/42-extension-install-ux.md) | 扩展安装用户体验优化 | 2026-05-16 |
| [43-chat-input-paste-fix](./completed/43-chat-input-paste-fix.md) | 粘贴内容删除修复 | 2026-05-16 |
| [45-subagent-live-rendering-sidebar](./completed/45-subagent-live-rendering-sidebar.md) | 子 Agent 实时渲染 | 2026-05-16 |
| [46-parallel-agent-orchestration](./completed/46-parallel-agent-orchestration.md) | 并行 Agent 编排恢复 | 2026-05-16 |
| [49-canvas-agent-free-form-tools](./completed/49-canvas-agent-free-form-tools.md) | Canvas Agent 工具重构 | 2026-05-16 |
| [52-deepseek-tui-feature-parity](./completed/52-deepseek-tui-feature-parity.md) | DeepSeek-TUI 功能对齐 | 2026-05-12 |
| [53-agent-communication-architecture-v2](./completed/53-agent-communication-architecture-v2.md) | Agent 通信架构 V2 | 2026-05-16 |
| [55-agent-directory-restructuring](./completed/55-agent-directory-restructuring.md) | Agent 目录结构重组 | 2026-05-16 |
| [96-duya-cli-tool](./completed/96-duya-cli-tool.md) | DUYA CLI 工具 | 2026-06-04 |
| [98-cli-channel-cron-message](./completed/98-cli-channel-cron-message.md) | CLI Channel / Cron / Message | 2026-06-04 |
| [99-cli-split-and-control-plane](./completed/99-cli-split-and-control-plane.md) | CLI Split & Control Plane | 2026-06-04 |
| [102-duya-config-into-cli](./completed/102-duya-config-into-cli.md) | Merge `duya_config` into `duya_cli` — single control-plane entry | 2026-06-04 |
| [211-duya-agent-refactor](./completed/211-duya-agent-refactor.md) | `packages/agent/src/index.ts` Code Quality Refactor — `index.ts` 2326→226 纯 barrel,`agent/DuyaAgent.ts` 实现家,`streamChat` 拆 5 helpers + `_dispatchMode`,`_activeMode: any`→`BaseMode \| null`,`compressHistory` `@deprecated`,`console.log`→`logger` | 2026-06-16 |

## Tech Debt

See [tech-debt-tracker.md](./tech-debt-tracker.md) for known technical debt items.

## Principle

> "Plans are first-class artifacts. Lightweight plans for small changes; complex work is documented in execution plans with progress and decision logs committed to the repository."

This enables agents to run without relying on external context.
