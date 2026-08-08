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

### Agent Core & Message

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [315-agent-message-domain-framework](./active/315-agent-message-domain-framework.md) | Pi-inspired append-only AgentMessage timeline, custom message projection, durable compaction checkpoints | P0 | Phase 1 complete; runtime integration deferred |
| [316-prompt-contributor-integration](./active/316-prompt-contributor-integration.md) | Prompt contributors wiring into the message/context framework | P1 | Planning |
| [242-agent-package-cleanup](./active/242-agent-package-cleanup.md) | Evidence-driven cleanup of dead Claude Code inheritance, stale build/public surface, unused deps in `@duya/agent` | P1 | Phase 1 complete; verification blockers recorded |
| [310-multi-model-reasoning-architecture](./active/310-multi-model-reasoning-architecture.md) | Multi-model reasoning architecture | P1 | Planning |
| [202-agent-mailbox](./active/202-agent-mailbox.md) | AgentMailbox — Codex-like runtime instruction injection (`agent_mailbox` + checkpoints + soft interrupt) | P0 | Planning |
| [104-proactive-memory-enhancement](./active/104-proactive-memory-enhancement.md) | Proactive memory — RealTimeCapture hook + scoring + dual-path Recall + decay archival | P1 | Planning |
| [243-session-search-overhaul](./active/243-session-search-overhaul.md) | Session search overhaul | P1 | Planning |
| [322-core-db-package-foundation](./completed/322-core-db-package-foundation.md) | ~~`@duya/core-db` 包地基~~ 已作废 → 326 | — | OBSOLETE → 326 |
| [323-core-db-state-aggregates](./completed/323-core-db-state-aggregates.md) | ~~core-db 状态聚合~~ 已作废 → 327 | — | OBSOLETE → 327 |
| [324-core-db-electron-wiring](./completed/324-core-db-electron-wiring.md) | ~~core-db 接线~~ 已作废 → 328 | — | OBSOLETE → 328 |
| [325-core-db-legacy-import](./completed/325-core-db-legacy-import.md) | ~~core-db 旧库导入~~ 已作废 → 329 | — | OBSOLETE → 329 |
| [326-core-db-rollout-foundation](./active/326-core-db-rollout-foundation.md) | core-db 地基：CoreDatabase + MessageLog（rollout 文件 + message_index 单类）+ SessionStore（LIKE 搜索，无 FTS）；7 文件平铺 | P0 | Phase 1-3 ✅ |
| [328-core-db-electron-wiring](./active/328-core-db-electron-wiring.md) | core-db 全量接线：Main 双库 + IPC/Worker 薄转发 + 全部直连消费方收编（无保留清单）+ 旧查询层删除（CLI 独立模式不接入） | P0 | Phase 1-7 接线完成 ✅（e2e smoke + grep 零引用 + db-handlers 转发测试通过）；手动 LLM 链路验证待办 |
| [329-core-db-legacy-import](./active/329-core-db-legacy-import.md) | core-db 旧库导入（单文件 LegacyImport）+ 首启自动执行 + 对账与文档收口 | P0 | Planning |
| [330-electron-cleanup-repair](./active/330-electron-cleanup-repair.md) | Electron 主进程清理修复：IPC 统一注册、agents barrel、services 分类、main.ts 启动编排下沉、上帝文件拆分、命名/shim 收口（六 Phase） | P1 | Planning |

### Conductor / Canvas

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [233-conductor-multi-canvas-management](./active/233-conductor-multi-canvas-management.md) | Agent canvas identity, listing, creation, switching, naming, durable sidebar/session sync | P0 | In progress |
| [235-conductor-finite-widget-layout](./active/235-conductor-finite-widget-layout.md) | Finite document-mode allowlist for document/table/link plus free-positioned text and media | P0 | Phase 1 complete |
| [236-project-database-element](./active/236-project-database-element.md) | Project-local structured data source, saved table views, canvas database element, Agent tools | P0 | MVP implemented; verification blockers recorded |
| [223-conductor-canvas-style-and-group](./active/223-conductor-canvas-style-and-group.md) | Sticky/connector style extension + Group element + 4 group tools + property panel | P1 | Planning |
| [70-conductor-canvas-v2-type-system](./active/70-conductor-canvas-v2-type-system.md) | Canvas V2 Phase 1: unified node model + type system + DB + IPC + Store | P0 | Planning |
| [71-conductor-canvas-v2-native-rendering](./active/71-conductor-canvas-v2-native-rendering.md) | Canvas V2 Phase 2: Shape/Text/Sticky/Section native rendering | P0 | Planning |
| [72-conductor-canvas-v2-connector](./active/72-conductor-canvas-v2-connector.md) | Canvas V2 Phase 3: Connector system (Bezier + endpoint binding) | P0 | Planning |
| [73-conductor-canvas-v2-mindmap-frame-toolbar](./active/73-conductor-canvas-v2-mindmap-frame-toolbar.md) | Canvas V2 Phase 4-6: MindMap + Frame + toolbar + interaction | P0 | Planning |
| [74-conductor-canvas-v2-agent-integration](./active/74-conductor-canvas-v2-agent-integration.md) | Canvas V2 Phase 7-8: Agent tools + Image + theme + light shell | P0 | Planning |
| [81-mindmap-interaction-correction](./active/81-mindmap-interaction-correction.md) | Mindmap follow-up: root move + subtree reorder + draft node flow | P0 | Planning |
| [36-conductor-blueprint-implementation](./active/36-conductor-blueprint-implementation.md) | Conductor blueprint interaction loop implementation | P0 | In progress |
| [32-conductor-foundation](./active/32-conductor-foundation.md) | Conductor data, communication, architecture guardrails | P0 | Phase 1 ✅ |
| [33-conductor-canvas-ui](./active/33-conductor-canvas-ui.md) | Conductor canvas UI + built-in Widget V1 | P0 | Phase 1-4 ✅ |
| [31-conductor-overview](./active/31-conductor-overview.md) | Conductor dynamic Agent workbench overview | P0 | 待开始 |
| [35-conductor-widget-extensibility](./active/35-conductor-widget-extensibility.md) | Conductor Widget extensibility & dynamic security boundary | P1 | 待开始 |
| [48-canvas-element-data-model](./active/48-canvas-element-data-model.md) | Canvas Elements type system | P0 | 设计阶段 |
| [227-canvas-knowledge-workspace](./active/227-canvas-knowledge-workspace.md) | Canvas knowledge workspace | P1 | Planning |
| [314-global-connector-registry-design-suite](./active/314-global-connector-registry-design-suite.md) | Global connector registry design suite | P1 | Planning |
| [314-tool-catalog-snapshot](./active/314-tool-catalog-snapshot.md) | Tool catalog snapshot design | P1 | Planning |

### Plugin / MCP / App Connection

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [311-plugin-workflow-templates](./active/311-plugin-workflow-templates.md) | Workflow Templates first-class — manifest v2 `components.workflows` + load + launch + permission | P0 | Planning |
| [312-app-connection-oauth](./active/312-app-connection-oauth.md) | App Connection infra — safeStorage token vault + loopback/PKCE OAuth + connector tools | P0 | Planning |
| [313-first-party-plugin-catalog](./active/313-first-party-plugin-catalog.md) | 12 first-party plugin catalog — GitHub/Playwright P0 + Remote MCP + App Connection batches | P0 | Planning |
| [85-builtin-plugin-flexibilization](./active/85-builtin-plugin-flexibilization.md) | Built-in Plugin convention-over-configuration | P0 | Planning |
| [86-schema-manifest-llm-friendly](./active/86-schema-manifest-llm-friendly.md) | Schema lenient — Agent-readable `plugin.md` layered design | P0 | Planning |
| [87-hook-system-full-enhancement](./active/87-hook-system-full-enhancement.md) | Hook system full upgrade — 4 types + 29 events + Async + Matcher | P0 | Planning |
| [88-plugin-discovery-multi-source](./active/88-plugin-discovery-multi-source.md) | Multi-source plugin discovery — GitHub/NPM/Git/URL/Local + priority merge | P1 | Planning |
| [89-plugin-lifecycle-version](./active/89-plugin-lifecycle-version.md) | Plugin lifecycle & versioning — versioned cache + Scope + dependency validation + auto-update | P1 | Planning |
| [90-marketplace-system-implementation](./active/90-marketplace-system-implementation.md) | Plugin marketplace — catalog + enterprise policy + spoof-protection + sync | P1 | Planning |
| [91-structured-error-handling](./active/91-structured-error-handling.md) | Structured error handling — 28 Discriminated-Union PluginError types | P1 | Planning |
| [92-plugin-security-enterprise-policy](./active/92-plugin-security-enterprise-policy.md) | Plugin security & enterprise policy — Trust Level + path guard + permission + Enterprise Policy | P0 | Planning |
| [38-mcp-marketplace-install](./active/38-mcp-marketplace-install.md) | MCP marketplace & one-click install | P1 | 待开始 |
| [226-mcp-security-layer-hardening](./active/226-mcp-security-layer-hardening.md) | MCP security hardening — env allowlist + secret sanitization + prompt-injection scan + rate limiter | P1 | Phase 1-2 ✅, 2.5 deferred |

### CLI / Cron

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [98-cli-channel-cron-message](./active/98-cli-channel-cron-message.md) | CLI Channel/Cron/Message + descriptor-driven command-registration refactor | P0 | Phase A 🟡, B–F 📋 |
| [99-duya-cli-argv-and-deprecate-cron-tool](./active/99-duya-cli-argv-and-deprecate-cron-tool.md) | CLI argv handling + deprecate cron tool | P0 | Planning |
| [100-plugin-cli-completion](./active/100-plugin-cli-completion.md) | Plugin CLI completion | P1 | Planning |
| [108-cli-channel-list-and-help](./active/108-cli-channel-list-and-help.md) | `channel_bindings` into `duya channel list`; wire `--help` for every descriptor command | P0 | Planning |
| [107-cron-cli-bugfix](./active/107-cron-cli-bugfix.md) | Cron CLI bugfix — DTO wrap, 500 ReferenceError, schedule field-name UX, CI typecheck | P0 | Phase 1 ✅, Phase 2 📋 |
| [201-cli-packaged-smoke-fixes](./active/201-cli-packaged-smoke-fixes.md) | CLI packaged smoke-test fixes — `adaptIdFirst`, auto-inject `--format`, `channel_directory` table | P0 | Phases 1–5 ✅, Phase 6 ⏳ |
| [237-cron-shared-session](./active/237-cron-shared-session.md) | Cron `session_target='shared'` — single persistent session per cron, DB-authoritative history | P0 | Planning |
| [231-skill-learning-inbox](./active/231-skill-learning-inbox.md) | Skill learning inbox | P1 | Planning |

### Session / UI / UX

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [314-no-project-session](./active/314-no-project-session.md) | No-project session — share `~/.duya/workspace`, sidebar "无项目" group | P1 | In progress |
| [232-input-option-popover-alignment](./active/232-input-option-popover-alignment.md) | Shared searchable option-panel style for chat model and project/session pickers | P1 | In progress |
| [308-turn-review-history](./active/308-turn-review-history.md) | Persisted per-chat-turn Git deltas, latest completed turn as Code Review default | P1 | In progress |
| [309-button-unification](./active/309-button-unification.md) | Shared `Button`/`IconButton` components; migrate 372 fragmented `<button>` call sites | P1 | Phase 1 in progress |
| [215-office-workspace](./active/215-office-workspace.md) | Office side-panel workspace — DOCX/PPTX/XLSX preview, selection context, Agent edits | P1 | Phase 1 complete; Phase 2 pending |
| [38-chat-generative-ui](./active/38-chat-generative-ui.md) | Chat Generative UI — Widget system V2 upgrade | P1 | Phase 1-4 ✅ Phase 5 🔴 |
| [44-skills-sync-fix](./active/44-skills-sync-fix.md) | Skills sync fix | P0 | In Progress |
| [25-skills-completion-plan](./active/25-skills-completion-plan.md) | Official Skill completion plan (hermes-agent 等) | P1 | 进行中 |
| [41-onboarding-experience-overhaul](./active/41-onboarding-experience-overhaul.md) | Onboarding experience overhaul | P0 | 待开始 |
| [42-document-parser-service](./active/42-document-parser-service.md) | Document parser service | P1 | Phase 1 待开始 |
| [43-startup-landing](./active/43-startup-landing.md) | First-launch branded landing page | P1 | Phase 1 ✅ |
| [39-beta-launch-preparation](./active/39-beta-launch-preparation.md) | Beta launch preparation | P0 | 进行中 |
| [82-researcher-codex-ui-alignment](./active/82-researcher-codex-ui-alignment.md) | Researcher Codex UI alignment — Codex-level Agent UX + research assistant positioning | P0 | Planning |
| [83-plugin-codex-ui-alignment](./active/83-plugin-codex-ui-alignment.md) | Plugin Codex UI alignment — capability marketplace + settings UX | P1 | Planning |
| [84-research-agent-memory-and-literature-plugin](./active/84-research-agent-memory-and-literature-plugin.md) | Research Agent memory + literature plugin | P1 | Planning |
| [65-recap-feature](./active/65-recap-feature.md) | Session Recap — auto show session summary on return | P1 | Planning |
| [37-subagent-nested-session](./active/37-subagent-nested-session.md) | SubAgent nested-session sidebar display | P1 | Planning |

### Infrastructure & Research

| Plan | Description | Priority | Status |
|------|-------------|----------|--------|
| [214-agent-core-audit](./active/214-agent-core-audit.md) | Full read-only audit of agent runtime, IPC, renderer, DB, lifecycle, packaging | P0 | Phase 1 ✅ (audit only), Phase 2 ⏳ |
| [94-research-mode-loop-improvement](./active/94-research-mode-loop-improvement.md) | Research Mode loop — dynamic ranking, StopDecision, SourceEvaluator, dedupe | P1 | Milestone 1 ✅, M2.1-3 📋 |
| [95-external-agent-import](./active/95-external-agent-import.md) | Import project context/memory/skills from Claude Code / Codex | P1 | Phase 1 ✅ |
| [60-research-mode](./active/60-research-mode.md) | Research Mode — iterative research workflow + Interactive Report | P1 | 规划中 |
| [97-tool-path-permission-refactor](./active/97-tool-path-permission-refactor.md) | Read/Write/Edit path permission refactor — delegate to permission system | P0 | Planning |
| [66-async-nonblocking-subagent](./active/66-async-nonblocking-subagent.md) | Async non-blocking subagent — parallel work while main agent continues | P0 | Planning |
| [54-electron-directory-restructure](./active/54-electron-directory-restructure.md) | Electron directory architecture restructure | P1 | Phase 1 ✅, Phase 2 🔴 |
| [62-gateway-ipc-refactor](./active/62-gateway-ipc-refactor.md) | Gateway ↔ IPC architecture refactor | P0 | 进行中 |
| [64-browser-parallel-isolation](./active/64-browser-parallel-isolation.md) | Browser multi-tab isolation & parallel execution | P0 | 进行中 |
| [15-bash-worker-implementation](./active/15-bash-worker-implementation.md) | Bash Worker multi-process implementation | P0 | 设计完成 |
| [27-logging-and-auto-update](./active/27-logging-and-auto-update.md) | Logging system & auto-update | P1 | 代码完成，待 UI 集成 |
| [28-multi-source-update-fallback](./active/28-multi-source-update-fallback.md) | Auto-update multi-source fallback | P1 | 待实现 |

## Completed Plans

Moved here when finished. Each includes original goal, key decisions, and lessons learned.

### Agent / Message / Memory

| Plan | Description | Completed |
|------|-------------|-----------|
| [241-on-demand-tool-discovery](./completed/241-on-demand-tool-discovery.md) | `tool_search` meta-entry + schema summary + builtin tiering + dynamic dispatch (3 phases) | — |
| [317-message-persistence-simplification](./completed/317-message-persistence-simplification.md) | 单一写者 + 单一 append-only `messages` 表 + 稳定边界批量落库；封存 `conversation_entries`；废弃前端写库旁路；统一 IPC 传输 | 2026-08-05 |
| [327-core-db-state-aggregates](./completed/327-core-db-state-aggregates.md) | core-db 状态聚合：Mailbox（状态机 + apply 矩阵唯一实现）+ stores.ts（TaskStore/PermissionLedger/LockStore 合并）+ mailbox 死代码清理 | 2026-08-07 |
| [332-storage-alignment-improvements](./completed/332-storage-alignment-improvements.md) | 存储对齐改进：session_spawn_edges 血缘表 + 附件 DB TEXT→文件目录迁移 + 日志/分库策略决策记录到 ARCHITECTURE.md | 2026-08-07 |
| [333-core-db-rollout-process-events](./active/333-core-db-rollout-process-events.md) | rollout 升级为会话轨迹：过程事件（reasoning/tool_call/turn_started/system_context）落盘 + turn_id 自包含 + 系统上下文落盘（对齐 codex developer 角色） | P1 | Planning |
| [331-session-goals-ui-state-persistence](./completed/331-session-goals-ui-state-persistence.md) | 会话目标/预算持久化（session_goals 表 + TokenBudget 镜像）+ 窗口状态记忆 + pinned threads | 2026-08-07 |
| [322-core-db-package-foundation](./completed/322-core-db-package-foundation.md) | 旧 core-db 地基方案（事件表 + FTS）——**作废**，由 326 取代 | 2026-08-06 |
| [323-core-db-state-aggregates](./completed/323-core-db-state-aggregates.md) | 旧 core-db 状态聚合——**作废**，由 327 取代 | 2026-08-06 |
| [324-core-db-electron-wiring](./completed/324-core-db-electron-wiring.md) | 旧 core-db 接线方案——**作废**，由 328 取代 | 2026-08-06 |
| [325-core-db-legacy-import](./completed/325-core-db-legacy-import.md) | 旧 core-db 导入方案——**作废**，由 329 取代 | 2026-08-06 |
| [318-plugin-management-unification](./completed/318-plugin-management-unification.md) | Plugin management unification — converge MCP collectors into plugin-core, rm orphaned BundledPluginRegistry, clarify permission vs plugin-security boundary | 2026-08-05 |
| [224-mode-architecture-unification](./completed/224-mode-architecture-unification.md) | 声明式 ModeModifier 统一 Plan/Research/Conductor 三种 mode | 2026-07-07 |
| [222-interagent-message-session](./completed/222-interagent-message-session.md) | MessageSession tool for cross-session agent Q&A + cycle detection | — |
| [212-subagent-task-notification](./completed/212-subagent-task-notification.md) | `<task-notification>` envelope + `messageQueueManager` task-notification mode | — |
| [211-duya-agent-refactor](./completed/211-duya-agent-refactor.md) | `@duya/agent` index.ts 2326→226 pure barrel | 2026-06-16 |
| [105-code-agent-profile-runtime-wiring](./completed/105-code-agent-profile-runtime-wiring.md) | Code Agent Profile runtime wiring + tool diagnostics | — |
| [305-memory-v2-phase-1c-worker-main-process-e2e](./completed/305-memory-v2-phase-1c-worker-main-process-e2e.md) | Memory Phase 1C — long-lived worker + e2e (shadow mode) | 2026-07-26 |
| [304-memory-v2-phase-1b-extractor](./completed/304-memory-v2-phase-1b-extractor.md) | Memory Phase 1B — stage-1 extractor + D8 guard | 2026-07-26 |
| [303-memory-v2-phase-1a3-projection-outbox](./completed/303-memory-v2-phase-1a3-projection-outbox.md) | Memory Phase 1A.3 — projection outbox + reconciliation | 2026-07-25 |
| [302-memory-v2-phase-1a2-lease-heartbeat-cas](./completed/302-memory-v2-phase-1a2-lease-heartbeat-cas.md) | Memory Phase 1A.2 — lease lifecycle + CAS | 2026-07-25 |
| [301-memory-v2-phase-1a-schema-projects-catalog](./completed/301-memory-v2-phase-1a-schema-projects-catalog.md) | Memory Phase 1A — schema + project registry + catalog sync | 2026-07-25 |
| [403-memory-curation-validator-runner](./completed/403-memory-curation-validator-runner.md) | Memory curation validator runner — curator prompt + staging validator + agent runner | 2026-08-04 |
| [401-memory-curation-tool-foundation](./completed/401-memory-curation-tool-foundation.md) | Memory curation tool foundation — `allowedRoots` sandbox on 5 file tools + memory-curator profile + root-bound entry | 2026-08-04 |
| [404-memory-curation-publisher-projection](./completed/404-memory-curation-publisher-projection.md) | Memory curation publisher projection — crash-safe publish state machine + projection generators + snapshot + health | 2026-08-04 |
| [405-memory-curation-prompt-canary-layout](./completed/405-memory-curation-prompt-canary-layout.md) | Memory curation prompt canary layout — two-layer prompt contract + canary + memory_layout.json | 2026-08-04 |
| [306-memory-v2-phase-2-consolidator-and-recall](./completed/306-memory-v2-phase-2-consolidator-and-recall.md) | Memory Phase 2 Consolidator (legacy) — superseded by Plan 401-406 curation agent architecture; consolidator.ts deleted, memory_entries dropped in migration 0009 | 2026-08-03 |
| [406-memory-curation-rebuild-adhoc-retire](./completed/406-memory-curation-rebuild-adhoc-retire.md) | Memory Phase 2 Plan 406 — memory_entries rebuild cache + ad-hoc input chain + Phase D retire (migration 0009 drops legacy tables, consolidator.ts deleted) | 2026-08-04 |

### Canvas / Conductor

| Plan | Description | Completed |
|------|-------------|-----------|
| [240-canvas-capture-splash-and-manage-broadcast](./completed/240-canvas-capture-splash-and-manage-broadcast.md) | `canvas_capture` waits for first paint; `conductor:canvas:changed` broadcast | — |
| [239-canvas-tool-find-empty-space-and-capture-region](./completed/239-canvas-tool-find-empty-space-and-capture-region.md) | `canvas_find_empty_space` fully-empty rectangles; `canvas_capture` region clip | — |
| [238-tool-history-integrity](./completed/238-tool-history-integrity.md) | Strict provider-safe tool-round ordering + durable message sequence | — |
| [235-human-like-browser-backend](./completed/235-human-like-browser-backend.md) | Codex-style computer-use: coordinate primitives + Set-of-Mark loop | — |
| [234-canvas-element-editing-and-scene-architecture](./completed/234-canvas-element-editing-and-scene-architecture.md) | Capability-driven element editing/toolbars + Agent scene blueprints | — |
| [231-cron-automation-ui-runtime-hardening](./completed/231-cron-automation-ui-runtime-hardening.md) | Cron creation/editing UX + scheduler startup hardening | — |
| [225-canvas-smart-layout-and-hit-test](./completed/225-canvas-smart-layout-and-hit-test.md) | Canvas smart layout + hit-test + direct manipulation | — |
| [221-conductor-main-agent-injection](./completed/221-conductor-main-agent-injection.md) | Conductor main-agent injection — 5 tools + prompt overlay + UI toggle | — |
| [220-attachment-unification](./completed/220-attachment-unification.md) | Collapse 5 parallel attachment state machines into 1 `AttachmentBar` | — |
| [216-file-preview-workspace](./completed/216-file-preview-workspace.md) | Expanded read-only file preview workspace with tabs | — |
| [49-canvas-agent-free-form-tools](./completed/49-canvas-agent-free-form-tools.md) | Canvas Agent tool refactor | 2026-05-16 |
| [34-conductor-agent-orchestration](./completed/34-conductor-agent-orchestration.md) | Conductor Agent perception & orchestration | 2026-05-16 |

### CLI / Provider / Electron

| Plan | Description | Completed |
|------|-------------|-----------|
| [203-provider-ui-interaction-architecture](./completed/203-provider-ui-interaction-architecture.md) | Provider UI 4-layer architecture — 不改 UX 减 1900 行 | — |
| [334-config-toml-unification](./completed/334-config-toml-unification.md) | 配置收敛为单一 `~/.duya/config.toml` + `secrets.json`(0600)：旧源(settings.json/boot.json/mcp.toml/registry.json/known_marketplaces.json)迁移后全删；`ConfigManager` 类物理删除；模型兼容解析 DB 化(方案 ii) | 2026-08-08 |
| [204-provider-card-redesign](./completed/204-provider-card-redesign.md) | Provider Card UX — `ProvidersSection` 1066→246 LoC | 2026-06-10 |
| [205-provider-inline-edit-page](./completed/205-provider-inline-edit-page.md) | Provider inline edit page + two-step add flow | — |
| [200-cli-surface-expansion](./completed/200-cli-surface-expansion.md) | CLI `update/backup/security` + polish existing commands | — |
| [103-research-mode-persistence-hardening](./completed/103-research-mode-persistence-hardening.md) | Research mode persistence hardening + dispatch fixes | — |
| [106-node-file-parser-and-read-integration](./completed/106-node-file-parser-and-read-integration.md) | Node file parser & Read tool multimodal integration | — |
| [99-cli-split-and-control-plane](./completed/99-cli-split-and-control-plane.md) | CLI split into `packages/cli` + control plane | 2026-06-04 |
| [96-duya-cli-tool](./completed/96-duya-cli-tool.md) | DUYA CLI unified command-line tool | 2026-06-04 |
| [30-mcp-loading-implementation](./completed/30-mcp-loading-implementation.md) | MCP server loading & connection | — |
| [102-duya-config-into-cli](./completed/102-duya-config-into-cli.md) | Merge `duya_config` into `duya_cli` | 2026-06-04 |
| [101-plugin-system-cleanup](./completed/101-plugin-system-cleanup.md) | Plugin system cleanup & runtime wiring | — |
| [21-nextjs-to-vite-migration](./completed/21-nextjs-to-vite-migration.md) | Next.js → Vite frontend migration | 2026-04-22 |
| [18-zero-router-architecture](./completed/18-zero-router-architecture.md) | Zero Router architecture | 2026-04-22 |
| [14-database-architecture-refactor](./completed/14-database-architecture-refactor.md) | Golden Trident data architecture refactor | 2026-05-08 |
| [19-database-ownership-unification](./completed/19-database-ownership-unification.md) | Database ownership unification | 2026-05-08 |

### Gateway / Browser / Misc

| Plan | Description | Completed |
|------|-------------|-----------|
| [230-gateway-agent-capability-and-workspace](./completed/230-gateway-agent-capability-and-workspace.md) | Gateway Agent direct tools + isolated workspace | 2026-07-17 |
| [229-recent-session-directory](./completed/229-recent-session-directory.md) | Project-aware recent session discovery | 2026-07-15 |
| [228-cookie-import-app-bound-fix](./completed/228-cookie-import-app-bound-fix.md) | Cookie import app-bound + live export hardening | 2026-07-13 |
| [227-built-in-browser-fallback](./completed/227-built-in-browser-fallback.md) | Built-in browser fallback when Chrome extension missing | 2026-07-10 |
| [226-agent-harness-project-grounding](./completed/226-agent-harness-project-grounding.md) | Scoped AGENTS.md + bounded plan/spec recovery | 2026-07-15 |
| [307-code-review-workspace](./completed/307-code-review-workspace.md) | Read-only sidebar Code Review workspace | 2026-07-27 |
| [25-platform-gateway](./completed/25-platform-gateway.md) | Platform gateway | 2026-05-08 |
| [25-streaming-state-architecture-refactor](./completed/25-streaming-state-architecture-refactor.md) | Streaming state architecture refactor | 2026-05-08 |
| [21-automation-cronjob-workflow](./completed/21-automation-cronjob-workflow.md) | Automation cron job system | 2026-05-08 |
| [22-singleton-daemon-architecture](./completed/22-singleton-daemon-architecture.md) | Singleton daemon architecture | 2026-04-23 |
| [24-self-improvement-system](./completed/24-self-improvement-system.md) | Self-improvement skill quality control | 2026-04-24 |
| [52-deepseek-tui-feature-parity](./completed/52-deepseek-tui-feature-parity.md) | DeepSeek-TUI feature parity | 2026-05-12 |
| [53-agent-communication-architecture-v2](./completed/53-agent-communication-architecture-v2.md) | Agent communication architecture V2 | 2026-05-16 |
| [55-agent-directory-restructuring](./completed/55-agent-directory-restructuring.md) | Agent directory restructure | 2026-05-16 |

> 更早的归档计划（多 Agent Profile、Conductor 早期、DB 迁移、Skill 系统、MessagePort 等完整历史）见 `completed/` 目录各文件。

## Tech Debt

See [tech-debt-tracker.md](./tech-debt-tracker.md) for known technical debt items.

## Principle

> "Plans are first-class artifacts. Lightweight plans for small changes; complex work is documented in execution plans with progress and decision logs committed to the repository."

This enables agents to run without relying on external context.