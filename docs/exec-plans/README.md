# Execution Plans

> **This is the first place to check before any work!** See workflow below.

***

## Quick Workflow

```
1. Read Active Plans below — each row states ONE concrete next action.
2. Pick the top row, read that plan file, execute its next action.
3. When it is done: `git mv` the file into completed/ and drop its row here.
4. New idea, not committed to? Put the file in backlog/ and add a Backlog row.
```

***

## Structure

```
exec-plans/
├── active/    # the only commitment list. Every row has a concrete next action.
├── backlog/   # designed but unstarted. Not a commitment; no row promises work.
├── completed/ # finished plans, kept for decision logs
└── tech-debt-tracker.md
```

Rules:

- **active/** is a commitment list. A plan belongs here only if it has a
  next action someone could start today. Cap it; do not let it grow back.
- **backlog/** is an idea shelf. Leaving something here is a valid outcome.
- A plan leaves `active/` the moment its last phase lands, not when someone
  remembers to archive it. Status headers in plan files are advisory only —
  this index is the source of truth.

***

## Active Plans (36)

| Plan | Priority | Next action |
| --- | --- | --- |
| [08-31-multi-agent-profile-design](./active/2026-08-31-multi-agent-profile-design.md) | P1 | Implement plan 7.2 memory partition by profile (migration + `[memory] partition` toggle) _(section C partially done via 481/477)_ |
| [popover-autoflip](./active/237-popover-autoflip.md) | P1 | Migrate `HoverPopover` to `usePopoverPlacement`, then `SlashCommandPopover` / `ModelSelector` |
| [permission-decision-bus](./active/419-permission-decision-bus.md) | P0 | Add `checkPermissions` + `riskTier` to the MCP tool registration path _(P0/P2 done; P1 open)_ |
| [harness-gap-closure](./active/429-harness-gap-closure.md) | P0 | Add `block_tool` hook effect + `PreToolUse` dispatch in `DuyaAgent` |
| [search-tools-hardening](./active/443-search-tools-hardening.md) | — | Wire `DUYA_RIPGREP_PATH` + timeout/abort into `GrepTool` spawn _(tasks A-G untouched)_ |
| [read-edit-freshness-protocol](./active/448-read-edit-freshness-protocol.md) | P0 | Add the `WriteTool` read-first gate (Task E) _(Phase 2/3 unstarted)_ |
| [multi-protocol-and-wrapper-layer](./active/451-multi-protocol-and-wrapper-layer.md) | P0 | Implement Phase 5 Vertex (`api/google-vertex.ts` + `providers/vertex.ts`) _(2 wrappers still inline)_ |
| [mcp-direct-and-plugin-unification](./active/452-mcp-direct-and-plugin-unification.md) | P1 | Remove the dead MCP submenu branch + merge the Apps/MCP constant sections _(Phase B absorbed by 455 D3)_ |
| [open-connector-registry](./active/455-open-connector-registry.md) | P1 | Close Phase D: run `typecheck:all` + full vitest and record the result |
| [rest-template-connector](./active/460-rest-template-connector.md) | P1 | Convert the slack `slack_search_messages` connector to a `.app.json` REST template |
| [grok-bot-framework-overview](./active/473-grok-bot-framework-overview.md) | P0 | Close the plan 10 acceptance list once 478 P2.3 (automation group seeding) lands _(umbrella tracker)_ |
| [bot-system-prompt-sections](./active/474-bot-system-prompt-sections.md) | P0 | Create the demo bot toml and run G1 prompts typecheck + unit tests (P3.3) |
| [bot-compaction-increment](./active/475-bot-compaction-increment.md) | P1 | Implement `automationReminderFingerprint` in turn-prep (P3.1) |
| [shared-rooms-group-chat](./active/478-shared-rooms-group-chat.md) | P1 | Wire cron automation to seed a group room (P2.3) |
| [bot-memory-isolation-tiers](./active/479-bot-memory-isolation-tiers.md) | P0 | Add the tier filter to the 430 RAG injection path (P2.3) |
| [bot-storage-layout](./active/485-bot-storage-layout.md) | P0 | Add `fs.watch` on `agents/<id>/profile.json` -> roster broadcast (P3) |
| [bot-channel-integration](./active/488-bot-channel-integration.md) | P1 | Add the P4.3 connector manifest registry (Discord/Slack) to `wake/channels` _(24/33 done)_ |
| [bot-chat-dataflow-and-complete-cards](./active/489-bot-chat-dataflow-and-complete-cards.md) | P0 | Complete P0.2 - persist card payloads for all 5 SendMessage types _(4/32 done)_ |
| [bot-toolset-turn-tool-alignment](./active/490-bot-toolset-turn-tool-alignment.md) | P0 | Add the workspace-constrained bash mode to `BashTool` (P2 BoxShell) |
| [bot-chat-messaging-feel](./active/491-bot-chat-messaging-feel.md) | P0 | Implement the P0.1 delivery phase machine in `conversation-store` _(1/11 done)_ |
| [bot-to-bot-grok-parity](./active/492-bot-to-bot-grok-parity.md) | P0 | Extend the bot-direct source whitelist so agent DM entries render (P3) |
| [worktree-framework-implementation](./active/496-worktree-framework-implementation.md) | P0 | Create `packages/agent/src/worktree/` and wire SubagentTool `isolation:'worktree'` _(research done, 0 code)_ |
| [bot-connector-elicitation](./active/503-bot-connector-elicitation.md) | P1 | Add the `disconnect_app` action + tool row in `AppConnectorManageTool` _(P6b only open item)_ |
| [image-preview-modal-unification](./active/511-image-preview-modal-unification.md) | P1 | Delete the 3 legacy preview components, then collapse the `preview.css` legacy rules _(Phases 3-4 unfinished)_ |
| [code-review-history](./active/518-code-review-history.md) | P2 | Build `<HistoryPanel>` (Branches/Commits tabs) and wire it into CodeReviewPanel _(Phase 2 UI missing)_ |
| [memory-footprint-and-lifecycle-reclamation](./active/521-memory-footprint-and-lifecycle-reclamation.md) | P1 | Wire `BrowserPanel` unmount -> `releaseBrowserMemory` (Phase 1a) _(Phases 1-5 open)_ |
| [project-entity-and-plan-management](./active/525-project-entity-and-plan-management.md) | P1 | Run `scripts/migrate-projects-paths.ts --apply` on the dev DB, then delete 522 _(5.1 still pending)_ |
| [projects-core-db-and-main-db-migration](./active/534-projects-core-db-and-main-db-migration.md) | P0 | Run the Phase 3.6.a static scan of `widget.*` callers and log `[CONDUCTOR_DUAL_WRITE]` counts _(3.6 not started)_ |
| [project-menus-use-dropdownmenu](./active/535-project-menus-use-dropdownmenu.md) | — | Replace the `BotContactListItem` inline submenu with a `MenuAction` of `kind:'submenu'` _(Phase 3 open)_ |
| [project-context-injection-v2](./active/536-project-context-injection-v2.md) | P1 | Add the current `projectId`/name to the bot memory system-prompt section (L3) _(only L3 open)_ |
| [prompt-hbs-and-agent-decomposition](./active/550-prompt-hbs-and-agent-decomposition.md) | P1 | Extract the TurnLoop event dispatcher out of `streamChat` into `TurnStreamRunner` _(worktree branch in progress)_ |
| [workflow-independent-runtime](./active/560-workflow-independent-runtime.md) | P0 | Land the Phase 5 `wf.agent` Go/No-Go spike: bind `runAgent` in the child process and journal `nodeKind:'agent'` + usage, or fall back to option C _(Phases 1-4 landed (Phase 4 checkbox list is stale))_ |
| [browser-core-upgrade](./active/573-browser-core-upgrade.md) | P0 | Phase 3: add the core-db browsing-history table + migration, hook webview main-frame `did-navigate`, expose `browser:history-*` IPC plus the history view _(Phases 1/1b/2/2b landed)_ |
| [cua-tree-richness](./active/576-cua-tree-richness.md) | P1 | Phase 3 in the ps1 C# probe walk: emit `children_total/shown/offset` for container nodes, plus `surface_kind` and the new-window settle poll _(Phases 1-2 landed)_ |
| [mcp-capability-core-convergence](./active/580-mcp-capability-core-convergence.md) | P0 | Run Phase 0's real-machine Notion baseline (instrumented around `RemoteMcpConnector`/`MCPClient` discovery) to record `pages=N, total=M` _(Phases 0/3/4/5 open)_ |
| [session-archive-hardening](./active/582-session-archive-hardening.md) | P0 | Run the §6.5 runtime repro, then fix G5 (archived rows permanently injected into the active sidebar) + G7 (rename/pin/delete on archived rows are no-ops) _(G1-G9 all open)_ |

***

## Backlog (11)

Designed, not started. Nothing here is promised work.

| Plan | Why it is not active |
| --- | --- |
| [09-workspace-phase-0](../backlog/2026-09-workspace-phase-0.md) | P0 design-only, 0/26 started |
| [button-unification](../backlog/309-button-unification.md) | 0-byte file: delete or write |
| [duya-ai-model-list-lazy-loading](../backlog/426b-duya-ai-model-list-lazy-loading.md) | 0/21, nothing started |
| [failclosed-command-parsing-and-content-rules](../backlog/443-failclosed-command-parsing-and-content-rules.md) | content rules remain dead code |
| [external-agent-invocation](../backlog/482-external-agent-invocation.md) | no code started |
| [bot-reliability-ack-and-resume](../backlog/484-bot-reliability-ack-and-resume.md) | no code started |
| [dock-layout-and-window-management](../backlog/527-dock-layout-and-window-management.md) | idea only |
| [multi-path-sidebar-rendering](../backlog/530-multi-path-sidebar-rendering.md) | blocked on 525 Phase 2 `--apply` |
| [model-call-trace](../backlog/561-model-call-trace.md) | 0/40, unstarted |
| [tab-shell-workbench](../backlog/571-tab-shell-workbench.md) | 0/28, unstarted |
| [chain-ab-runtime-merge-evaluation](../backlog/581-chain-ab-runtime-merge-evaluation.md) | decision doc only; execution deferred to plan 582+ |

***

## Completed Plans (365)

Archived for decision logs. Not an index of current work.

### Agent Core & Message (120)

- [proactive-memory-enhancement](../completed/104-proactive-memory-enhancement.md) · [code-agent-profile-runtime-wiring](../completed/105-code-agent-profile-runtime-wiring.md) · [agent-mailbox](../completed/202-agent-mailbox.md) · [06-15-subagent-lifecycle-ownership-migration](../completed/2026-06-15-subagent-lifecycle-ownership-migration.md) · [09-chat-attachment-edit-queue](../completed/2026-09-chat-attachment-edit-queue.md) · [09-tool-use-group-progress-titles](../completed/2026-09-tool-use-group-progress-titles.md)
- [file-edit-tool-ui-redesign](../completed/208-file-edit-tool-ui-redesign.md) · [duya-agent-refactor](../completed/211-duya-agent-refactor.md) · [subagent-task-notification](../completed/212-subagent-task-notification.md) · [agent-core-audit-report](../completed/214-agent-core-audit-report.md) · [html-preview-in-tool-rows](../completed/217-html-preview-in-tool-rows.md) · [tool-row-auto-collapse](../completed/219-tool-row-auto-collapse.md)
- [interagent-message-session](../completed/222-interagent-message-session.md) · [mode-architecture-unification](../completed/224-mode-architecture-unification.md) · [on-demand-tool-discovery](../completed/241-on-demand-tool-discovery.md) · [agent-package-cleanup](../completed/242-agent-package-cleanup.md) · [session-search-overhaul](../completed/243-session-search-overhaul.md) · [memory-v2-phase-1a-schema-projects-catalog](../completed/301-memory-v2-phase-1a-schema-projects-catalog.md)
- [memory-v2-phase-1a2-lease-heartbeat-cas](../completed/302-memory-v2-phase-1a2-lease-heartbeat-cas.md) · [memory-v2-phase-1a3-projection-outbox](../completed/303-memory-v2-phase-1a3-projection-outbox.md) · [memory-v2-phase-1b-extractor](../completed/304-memory-v2-phase-1b-extractor.md) · [memory-v2-phase-1c-worker-main-process-e2e](../completed/305-memory-v2-phase-1c-worker-main-process-e2e.md) · [memory-v2-phase-2-consolidator-and-recall](../completed/306-memory-v2-phase-2-consolidator-and-recall.md) · [multi-model-reasoning-architecture](../completed/310-multi-model-reasoning-architecture.md)
- [agent-message-domain-framework](../completed/315-agent-message-domain-framework.md) · [prompt-contributor-integration](../completed/316-prompt-contributor-integration.md) · [message-persistence-simplification](../completed/317-message-persistence-simplification.md) · [plugin-management-unification](../completed/318-plugin-management-unification.md) · [core-db-package-foundation](../completed/322-core-db-package-foundation.md) · [core-db-state-aggregates](../completed/323-core-db-state-aggregates.md)
- [core-db-electron-wiring](../completed/324-core-db-electron-wiring.md) · [core-db-legacy-import](../completed/325-core-db-legacy-import.md) · [core-db-rollout-foundation](../completed/326-core-db-rollout-foundation.md) · [core-db-state-aggregates](../completed/327-core-db-state-aggregates.md) · [core-db-electron-wiring](../completed/328-core-db-electron-wiring.md) · [core-db-legacy-import](../completed/329-core-db-legacy-import.md)
- [electron-cleanup-repair](../completed/330-electron-cleanup-repair.md) · [session-goals-ui-state-persistence](../completed/331-session-goals-ui-state-persistence.md) · [storage-alignment-improvements](../completed/332-storage-alignment-improvements.md) · [core-db-rollout-process-events](../completed/333-core-db-rollout-process-events.md) · [duya-agent-refactor](../completed/334-duya-agent-refactor.md) · [memory-pipeline-unblock](../completed/336-memory-pipeline-unblock.md)
- [memory-curation-tool-foundation](../completed/401-memory-curation-tool-foundation.md) · [memory-curation-ledger-staging](../completed/402-memory-curation-ledger-staging.md) · [memory-curation-validator-runner](../completed/403-memory-curation-validator-runner.md) · [memory-curation-publisher-projection](../completed/404-memory-curation-publisher-projection.md) · [memory-curation-prompt-canary-layout](../completed/405-memory-curation-prompt-canary-layout.md) · [memory-curation-rebuild-adhoc-retire](../completed/406-memory-curation-rebuild-adhoc-retire.md)
- [agents-md-loader-alignment](../completed/408-agents-md-loader-alignment.md) · [nested-agents-md-loading](../completed/408b-nested-agents-md-loading.md) · [voice-library](../completed/410-voice-library.md) · [agent-voice-setup](../completed/411-agent-voice-setup.md) · [goal-mode](../completed/411-goal-mode.md) · [mode-state-machine-framework](../completed/413-mode-state-machine-framework.md)
- [mode-tracker-framework](../completed/413a-mode-tracker-framework.md) · [plan-tracker-state-machine](../completed/413b-plan-tracker-state-machine.md) · [mode-state-persistence](../completed/413c-mode-state-persistence.md) · [agent-loop-wiring](../completed/413d-agent-loop-wiring.md) · [plan-mode-frontend-session](../completed/413e-plan-mode-frontend-session.md) · [workflow-mode-design](../completed/415-workflow-mode-design.md)
- [deterministic-curation](../completed/417-deterministic-curation.md) · [tool-protocol-adaptation](../completed/418-tool-protocol-adaptation.md) · [agent-profile-completion](../completed/420-agent-profile-completion.md) · [goal-observability-persistence](../completed/420-goal-observability-persistence.md) · [goal-ui](../completed/421-goal-ui.md) · [compaction-strategy-consolidation](../completed/422-compaction-strategy-consolidation.md)
- [deep-research-state-machine](../completed/423-deep-research-state-machine.md) · [config-driven-custom-agents](../completed/424-config-driven-custom-agents.md) · [hook-loop-bus](../completed/426-hook-loop-bus.md) · [voice-pipeline-overhaul](../completed/427-voice-pipeline-overhaul.md) · [harness-signal-contracts](../completed/428-harness-signal-contracts.md) · [agent-worktree-isolation](../completed/440-agent-worktree-isolation.md)
- [provider-stream-coverage](../completed/440-provider-stream-coverage.md) · [main-agent-worktree-tools](../completed/441-main-agent-worktree-tools.md) · [context-ring-single-estimator](../completed/443-context-ring-single-estimator.md) · [token-accounting-cache-health](../completed/444-token-accounting-cache-health.md) · [skills-reload-snapshot-cache](../completed/445-skills-reload-snapshot-cache.md) · [streaming-durable-dedup](../completed/447-streaming-durable-dedup.md)
- [app-connection-approval-parity](../completed/449-app-connection-approval-parity.md) · [app-connection-codex-alignment](../completed/450-app-connection-codex-alignment.md) · [wake-agent](../completed/453-wake-agent.md) · [computer-use-mode](../completed/454-computer-use-mode.md) · [codex-marketplace-and-install](../completed/455-codex-marketplace-and-install.md) · [agent-wake-bus](../completed/476-agent-wake-bus.md)
- [agent-dm-messaging](../completed/477-agent-dm-messaging.md) · [appended-tool-schema-catalog](../completed/480-appended-tool-schema-catalog.md) · [message-threads](../completed/486-message-threads.md) · [host-persistent-tool-permission](../completed/487-host-persistent-tool-permission.md) · [session-tool-minimal-loop](../completed/504-session-tool-minimal-loop.md) · [rollout-as-first-class-data](../completed/506-rollout-as-first-class-data.md)
- [bot-compact-agent-not-initialized](../completed/508-bot-compact-agent-not-initialized.md) · [compaction-loop-fix-and-ui-progress](../completed/517-compaction-loop-fix-and-ui-progress.md) · [computer-use-harness-gaps](../completed/519-computer-use-harness-gaps.md) · [context-window-resolution](../completed/522-context-window-resolution.md) · [compaction-summary-quality-guards](../completed/523-compaction-summary-quality-guards.md) · [marketplace-source-fallback-mirror](../completed/528-marketplace-source-fallback-mirror.md)
- [multi-source-default-and-dynamic-tabs](../completed/529-multi-source-default-and-dynamic-tabs.md) · [plugin-format-adapter-layer](../completed/531-plugin-format-adapter-layer.md) · [context-ring-persistence-and-throttle](../completed/533-context-ring-persistence-and-throttle.md) · [token-usage-double-count-fix](../completed/546-token-usage-double-count-fix.md) · [unify-session-and-project-actions](../completed/547-unify-session-and-project-actions.md) · [jev-system-one-integration](../completed/551-jev-system-one-integration.md)
- [prompt-module-flatten](../completed/551-prompt-module-flatten.md) · [compaction-consolidation](../completed/552-compaction-consolidation.md) · [workflow-rpa-agent-design](../completed/552-workflow-rpa-agent-design.md) · [prompt-slimming](../completed/555-prompt-slimming.md) · [rpa-recorder-computer-use-framework](../completed/556-rpa-recorder-computer-use-framework.md) · [prompt-gating-consolidation](../completed/557-prompt-gating-consolidation.md)
- [prompt-asset-cleanup](../completed/559-prompt-asset-cleanup.md) · [element-tree-enumeration-overlay](../completed/562-element-tree-enumeration-overlay.md) · [bash-foreground-soft-yield](../completed/563-bash-foreground-soft-yield.md) · [structural-computer-use](../completed/564-structural-computer-use.md) · [workflow-run-live-nodes-and-agent-watch](../completed/568-workflow-run-live-nodes-and-agent-watch.md) · [macos-native-computer-use](../completed/572-macos-native-computer-use.md)
- [windows-cua-alignment](../completed/575-windows-cua-alignment.md) · [context-accounting-ledger](../completed/577-context-accounting-ledger.md) · [cua-minimized-window-access](../completed/578-cua-minimized-window-access.md) · [duya-agent-api-design](../completed/duya-agent-api-design.md) · [duya-agent-core-implementation](../completed/duya-agent-core-implementation.md) · [duya-agent-integration](../completed/duya-agent-integration.md)

### Infrastructure & Research (53)

- [bash-worker-implementation](../completed/15-bash-worker-implementation.md) · [09-bug-sweep](../completed/2026-09-bug-sweep.md) · [automation-cronjob-workflow](../completed/21-automation-cronjob-workflow.md) · [agent-core-audit](../completed/214-agent-core-audit.md) · [localhost-auto-open-from-bash](../completed/218-localhost-auto-open-from-bash.md) · [singleton-daemon-architecture](../completed/22-singleton-daemon-architecture.md)
- [agent-harness-project-grounding](../completed/226-agent-harness-project-grounding.md) · [built-in-browser-fallback](../completed/227-built-in-browser-fallback.md) · [async-task-inbox](../completed/228-async-task-inbox.md) · [cookie-import-app-bound-fix](../completed/228-cookie-import-app-bound-fix.md) · [recent-session-directory](../completed/229-recent-session-directory.md) · [gateway-agent-capability-and-workspace](../completed/230-gateway-agent-capability-and-workspace.md)
- [self-improvement-system](../completed/24-self-improvement-system.md) · [platform-gateway](../completed/25-platform-gateway.md) · [streaming-state-architecture-refactor](../completed/25-streaming-state-architecture-refactor.md) · [logging-and-auto-update](../completed/27-logging-and-auto-update.md) · [multi-source-update-fallback](../completed/28-multi-source-update-fallback.md) · [code-review-workspace](../completed/307-code-review-workspace.md)
- [remove-legacy-message-bridge](../completed/319-remove-legacy-message-bridge.md) · [mailbox-legacy-cleanup-assessment](../completed/320-mailbox-legacy-cleanup-assessment.md) · [telegram-hermes-gap-completion](../completed/407-telegram-hermes-gap-completion.md) · [projection-layer-compression](../completed/412-projection-layer-compression.md) · [low-spec-performance](../completed/426-low-spec-performance.md) · [unified-permission-gate](../completed/430-unified-permission-gate.md)
- [bot-routines-and-listeners](../completed/499-bot-routines-and-listeners.md) · [deepseek-tui-feature-parity](../completed/52-deepseek-tui-feature-parity.md) · [agent-communication-architecture-v2](../completed/53-agent-communication-architecture-v2.md) · [messagelist-scroll-jump-and-freeze](../completed/532-messagelist-scroll-jump-and-freeze.md) · [browser-parallel-fetch-text-only](../completed/533-browser-parallel-fetch-text-only.md) · [electron-directory-restructure](../completed/54-electron-directory-restructure.md)
- [compact-ui-history-retention](../completed/548-compact-ui-history-retention.md) · [archive-design-parity-with-codex](../completed/549-archive-design-parity-with-codex.md) · [agent-directory-restructuring](../completed/55-agent-directory-restructuring.md) · [goal-mode-v2](../completed/553-goal-mode-v2.md) · [minimax-small-wins](../completed/554-minimax-small-wins.md) · [code-review-line-comments](../completed/572-code-review-line-comments.md)
- [research-mode](../completed/60-research-mode.md) · [gateway-ipc-refactor](../completed/62-gateway-ipc-refactor.md) · [browser-parallel-isolation](../completed/64-browser-parallel-isolation.md) · [async-nonblocking-subagent](../completed/66-async-nonblocking-subagent.md) · [research-mode-loop-improvement](../completed/94-research-mode-loop-improvement.md) · [external-agent-import](../completed/95-external-agent-import.md)
- [tool-path-permission-refactor](../completed/97-tool-path-permission-refactor.md) · [chat-ux-improvement-plan](../completed/chat-ux-improvement-plan.md) · [duya-implementation-phase1](../completed/duya-implementation-phase1.md) · [duya-implementation-phase2-3](../completed/duya-implementation-phase2-3.md) · [duya-implementation-phase4-5](../completed/duya-implementation-phase4-5.md) · [duya-project-structure](../completed/duya-project-structure.md)
- [duya-source-code-integration](../completed/duya-source-code-integration.md) · [first-test-problems-analysis](../completed/first-test-problems-analysis.md) · [first-test-problems](../completed/first-test-problems.md) · [harness-comparison-docs](../completed/harness-comparison-docs.md) · [problems](../completed/problems.md)

### App Shell / UI (45)

- [06-15-right-sidebar-redesign](../completed/2026-06-15-right-sidebar-redesign.md) · [office-workspace](../completed/215-office-workspace.md) · [input-option-popover-alignment](../completed/232-input-option-popover-alignment.md) · [skills-completion-plan](../completed/25-skills-completion-plan.md) · [turn-review-history](../completed/308-turn-review-history.md) · [no-project-session](../completed/314-no-project-session.md)
- [subagent-nested-session](../completed/37-subagent-nested-session.md) · [chat-generative-ui](../completed/38-chat-generative-ui.md) · [beta-launch-preparation](../completed/39-beta-launch-preparation.md) · [onboarding-experience-overhaul](../completed/41-onboarding-experience-overhaul.md) · [skills-system-cleanup-and-system-skills](../completed/414-skills-system-cleanup-and-system-skills.md) · [inline-task-row](../completed/416-inline-task-row.md)
- [document-parser-service](../completed/42-document-parser-service.md) · [browser-search-tooling](../completed/428-browser-search-tooling.md) · [startup-landing](../completed/43-startup-landing.md) · [memory-rag-hook](../completed/430-memory-rag-hook.md) · [memory-setup-cli-and-skill](../completed/431-memory-setup-cli-and-skill.md) · [memory-rag-settings-ui](../completed/432-memory-rag-settings-ui.md)
- [stage1-policy-incremental-edits](../completed/433-stage1-policy-incremental-edits.md) · [skill-tool-expose-and-system-gui](../completed/434-skill-tool-expose-and-system-gui.md) · [cli-skill-listing-alignment](../completed/435-cli-skill-listing-alignment.md) · [focus-mode](../completed/438-focus-mode.md) · [skills-sync-fix](../completed/44-skills-sync-fix.md) · [browser-latency-optimizations](../completed/441-browser-latency-optimizations.md)
- [browser-webview-parallel-isolation](../completed/442-browser-webview-parallel-isolation.md) · [sidebar-section-refactor](../completed/471-sidebar-section-refactor.md) · [unified-attachment-card-visual](../completed/472-unified-attachment-card-visual.md) · [run-surface-threadkind-consolidation](../completed/505-run-surface-threadkind-consolidation.md) · [channel-attachments](../completed/507-channel-attachments.md) · [modal-unification](../completed/510-modal-unification.md)
- [sidebar-awaiting-input-pill](../completed/516-sidebar-awaiting-input-pill.md) · [browser-tab-group-management](../completed/524-browser-tab-group-management.md) · [shared-agent-channel-root](../completed/526-shared-agent-channel-root.md) · [dwf-browser-node](../completed/564-dwf-browser-node.md) · [dwf-zcode-parity-resume-compile-actor-escalate](../completed/565-dwf-zcode-parity-resume-compile-actor-escalate.md) · [background-command-list-and-output-panel](../completed/566-background-command-list-and-output-panel.md)
- [system-reminder-taxonomy-sanitize-rebuild](../completed/567-system-reminder-taxonomy-sanitize-rebuild.md) · [finalize-final-mailbox-poll](../completed/569-finalize-final-mailbox-poll.md) · [exit-boundary-user-message-separation](../completed/570-exit-boundary-user-message-separation.md) · [mailbox-delivery-receipts](../completed/571-mailbox-delivery-receipts.md) · [recap-feature](../completed/65-recap-feature.md) · [researcher-codex-ui-alignment](../completed/82-researcher-codex-ui-alignment.md)
- [plugin-codex-ui-alignment](../completed/83-plugin-codex-ui-alignment.md) · [research-agent-memory-and-literature-plugin](../completed/84-research-agent-memory-and-literature-plugin.md) · [sidebar-project-management](../completed/sidebar-project-management.md)

### CLI / Cron / Provider (39)

- [plugin-cli-completion](../completed/100-plugin-cli-completion.md) · [plugin-system-cleanup](../completed/101-plugin-system-cleanup.md) · [duya-config-into-cli](../completed/102-duya-config-into-cli.md) · [research-mode-persistence-hardening](../completed/103-research-mode-persistence-hardening.md) · [node-file-parser-and-read-integration](../completed/106-node-file-parser-and-read-integration.md) · [cron-cli-bugfix](../completed/107-cron-cli-bugfix.md)
- [cli-channel-list-and-help](../completed/108-cli-channel-list-and-help.md) · [database-architecture-refactor](../completed/14-database-architecture-refactor.md) · [zero-router-architecture](../completed/18-zero-router-architecture.md) · [database-ownership-unification](../completed/19-database-ownership-unification.md) · [cli-surface-expansion](../completed/200-cli-surface-expansion.md) · [cli-packaged-smoke-fixes](../completed/201-cli-packaged-smoke-fixes.md)
- [provider-ui-interaction-architecture](../completed/203-provider-ui-interaction-architecture.md) · [provider-card-redesign](../completed/204-provider-card-redesign.md) · [provider-inline-edit-page](../completed/205-provider-inline-edit-page.md) · [provider-masked-key-bug](../completed/209-provider-masked-key-bug.md) · [nextjs-to-vite-migration](../completed/21-nextjs-to-vite-migration.md) · [gateway-cli-channel-message-fixes](../completed/210-gateway-cli-channel-message-fixes.md)
- [e2e-ipc-test-coverage](../completed/213-e2e-ipc-test-coverage.md) · [skill-learning-inbox](../completed/231-skill-learning-inbox.md) · [cron-shared-session](../completed/237-cron-shared-session.md) · [mcp-loading-implementation](../completed/30-mcp-loading-implementation.md) · [ai-provider-factory-alignment](../completed/319-ai-provider-factory-alignment.md) · [single-provider-source-builtin-catalog](../completed/321-single-provider-source-builtin-catalog.md)
- [config-toml-unification-tasks](../completed/334-config-toml-unification-tasks.md) · [config-toml-unification](../completed/334-config-toml-unification.md) · [config-consumer-unification](../completed/335-config-consumer-unification.md) · [cron-definition-configstore](../completed/405-cron-definition-configstore.md) · [gateway-user-authz](../completed/407-gateway-user-authz.md) · [cron-single-source-refactor](../completed/409-cron-single-source-refactor.md)
- [ipc-path-safety-hardening](../completed/413-ipc-path-safety-hardening.md) · [provider-error-surfacing-and-retry-notice](../completed/462-provider-error-surfacing-and-retry-notice.md) · [gateway-minimal-router](../completed/520-gateway-minimal-router.md) · [duya-cli-tool](../completed/96-duya-cli-tool.md) · [cli-channel-cron-message](../completed/98-cli-channel-cron-message.md) · [cli-split-and-control-plane](../completed/99-cli-split-and-control-plane.md)
- [duya-cli-argv-and-deprecate-cron-tool](../completed/99-duya-cli-argv-and-deprecate-cron-tool.md) · [ai-provider-settings](../completed/ai-provider-settings.md) · [cli-tool-fix](../completed/cli-tool-fix.md)

### Foundations (legacy 01-99) (35)

- [tool-interface-enhancement](../completed/01-tool-interface-enhancement.md) · [context-compaction-system](../completed/02-context-compaction-system.md) · [compact-critical-fix](../completed/03-compact-critical-fix.md) · [query-engine-separation](../completed/03-query-engine-separation.md) · [tool-orchestration-enhancement](../completed/05-tool-orchestration-enhancement.md) · [abort-controller-propagation](../completed/06-abort-controller-propagation.md)
- [openharness-comparison-and-improvement](../completed/10-openharness-comparison-and-improvement.md) · [messageport-architecture](../completed/11-messageport-architecture.md) · [config-manager-implementation](../completed/12-config-manager-implementation.md) · [message-port-lifecycle](../completed/13-message-port-lifecycle.md) · [tool-stream-buffer](../completed/14-tool-stream-buffer.md) · [sse-to-messageport-unification](../completed/16-sse-to-messageport-unification.md)
- [api-routes-to-ipc-migration](../completed/18-api-routes-to-ipc-migration.md) · [data-persistence-fixes](../completed/23-data-persistence-fixes.md) · [draft-skill-manager](../completed/24a-draft-skill-manager.md) · [self-improver-core](../completed/24b-self-improver-core.md) · [skill-agents](../completed/24c-skill-agents.md) · [skill-prompts](../completed/24d-skill-prompts.md)
- [integration-testing](../completed/24e-integration-testing.md) · [prompt-mode-architecture](../completed/26-prompt-mode-architecture.md) · [telegram-enhancement](../completed/28-telegram-enhancement.md) · [multi-agent-profile-system](../completed/29-multi-agent-profile-system.md) · [agent-self-management](../completed/40-agent-self-management.md) · [extension-install-ux](../completed/42-extension-install-ux.md)
- [chat-input-paste-fix](../completed/43-chat-input-paste-fix.md) · [subagent-live-rendering-sidebar](../completed/45-subagent-live-rendering-sidebar.md) · [parallel-agent-orchestration](../completed/46-parallel-agent-orchestration.md) · [agent-server-http-sse-migration](../completed/53-agent-server-http-sse-migration.md) · [context-design](../completed/60-context-design.md) · [orchestrator-design](../completed/60-orchestrator-design.md)
- [sse-protocol](../completed/60-sse-protocol.md) · [message-queue-abort-integration](../completed/67-message-queue-abort-integration.md) · [message-rewind-edit-resend](../completed/75-message-rewind-edit-resend.md) · [plugin-development-skill](../completed/93-plugin-development-skill.md) · [canvas-interaction-core-refactor](../completed/98-canvas-interaction-core-refactor.md)

### Conductor / Canvas (34)

- [06-16-conductor-iterative-visual-refinement](../completed/2026-06-16-conductor-iterative-visual-refinement.md) · [file-preview-workspace](../completed/216-file-preview-workspace.md) · [attachment-unification](../completed/220-attachment-unification.md) · [conductor-main-agent-injection](../completed/221-conductor-main-agent-injection.md) · [conductor-canvas-style-and-group](../completed/223-conductor-canvas-style-and-group.md) · [canvas-smart-layout-and-hit-test](../completed/225-canvas-smart-layout-and-hit-test.md)
- [canvas-knowledge-workspace](../completed/227-canvas-knowledge-workspace.md) · [cron-automation-ui-runtime-hardening](../completed/231-cron-automation-ui-runtime-hardening.md) · [conductor-multi-canvas-management](../completed/233-conductor-multi-canvas-management.md) · [canvas-element-editing-and-scene-architecture](../completed/234-canvas-element-editing-and-scene-architecture.md) · [conductor-finite-widget-layout](../completed/235-conductor-finite-widget-layout.md) · [human-like-browser-backend](../completed/235-human-like-browser-backend.md)
- [project-database-element](../completed/236-project-database-element.md) · [tool-history-integrity](../completed/238-tool-history-integrity.md) · [canvas-tool-find-empty-space-and-capture-region](../completed/239-canvas-tool-find-empty-space-and-capture-region.md) · [canvas-capture-splash-and-manage-broadcast](../completed/240-canvas-capture-splash-and-manage-broadcast.md) · [conductor-overview](../completed/31-conductor-overview.md) · [global-connector-registry-design-suite](../completed/314-global-connector-registry-design-suite.md)
- [tool-catalog-snapshot](../completed/314-tool-catalog-snapshot.md) · [conductor-foundation](../completed/32-conductor-foundation.md) · [conductor-canvas-ui](../completed/33-conductor-canvas-ui.md) · [conductor-agent-orchestration](../completed/34-conductor-agent-orchestration.md) · [conductor-widget-extensibility](../completed/35-conductor-widget-extensibility.md) · [conductor-blueprint-implementation](../completed/36-conductor-blueprint-implementation.md)
- [canvas-capture-region-canvas-coords](../completed/439-canvas-capture-region-canvas-coords.md) · [canvas-element-data-model](../completed/48-canvas-element-data-model.md) · [canvas-agent-free-form-tools](../completed/49-canvas-agent-free-form-tools.md) · [canvas-workbench-runtime](../completed/570-canvas-workbench-runtime.md) · [conductor-canvas-v2-type-system](../completed/70-conductor-canvas-v2-type-system.md) · [conductor-canvas-v2-native-rendering](../completed/71-conductor-canvas-v2-native-rendering.md)
- [conductor-canvas-v2-connector](../completed/72-conductor-canvas-v2-connector.md) · [conductor-canvas-v2-mindmap-frame-toolbar](../completed/73-conductor-canvas-v2-mindmap-frame-toolbar.md) · [conductor-canvas-v2-agent-integration](../completed/74-conductor-canvas-v2-agent-integration.md) · [mindmap-interaction-correction](../completed/81-mindmap-interaction-correction.md)

### Plugin / MCP / App Connection (21)

- [mcp-security-layer-hardening](../completed/226-mcp-security-layer-hardening.md) · [plugin-workflow-templates](../completed/311-plugin-workflow-templates.md) · [app-connection-oauth](../completed/312-app-connection-oauth.md) · [first-party-plugin-catalog](../completed/313-first-party-plugin-catalog.md) · [agent-plugins-compat](../completed/335-agent-plugins-compat.md) · [mcp-marketplace-install](../completed/38-mcp-marketplace-install.md)
- [hook-row-in-message-flow](../completed/437-hook-row-in-message-flow.md) · [live-tool-input-streaming](../completed/461-live-tool-input-streaming.md) · [connector-auth-resume-card](../completed/498-connector-auth-resume-card.md) · [plans-plugin-mcp](../completed/522-plans-plugin-mcp.md) · [skills-mention-and-catalog-codex-alignment](../completed/535-skills-mention-and-catalog-codex-alignment.md) · [skill-context-accounting-and-invocation](../completed/579-skill-context-accounting-and-invocation.md)
- [builtin-plugin-flexibilization](../completed/85-builtin-plugin-flexibilization.md) · [schema-manifest-llm-friendly](../completed/86-schema-manifest-llm-friendly.md) · [hook-system-full-enhancement](../completed/87-hook-system-full-enhancement.md) · [plugin-discovery-multi-source](../completed/88-plugin-discovery-multi-source.md) · [plugin-lifecycle-version](../completed/89-plugin-lifecycle-version.md) · [marketplace-system-implementation](../completed/90-marketplace-system-implementation.md)
- [structured-error-handling](../completed/91-structured-error-handling.md) · [plugin-security-enterprise-policy](../completed/92-plugin-security-enterprise-policy.md) · [skill-system](../completed/skill-system.md)

### Bot Series (14)

- [08-13-grok-harness-turn-semantics](../completed/2026-08-13-grok-harness-turn-semantics.md) · [08-13-grok-synthetic-reason-and-working-directory](../completed/2026-08-13-grok-synthetic-reason-and-working-directory.md) · [08-13-grok-task-todo-alignment](../completed/2026-08-13-grok-task-todo-alignment.md) · [bot-toolset-unified-foundation](../completed/481-bot-toolset-unified-foundation.md) · [multi-bot-chat-ui](../completed/483-multi-bot-chat-ui.md) · [bot-direct-handoff-2026-09-05](../completed/489-bot-direct-handoff-2026-09-05.md)
- [bot-session-physical-isolation-and-generation-rotation](../completed/493-bot-session-physical-isolation-and-generation-rotation.md) · [bot-direct-ask-cards](../completed/494-bot-direct-ask-cards.md) · [bot-long-session-grok-parity](../completed/495-bot-long-session-grok-parity.md) · [bot-tool-approval-cards](../completed/498-bot-tool-approval-cards.md) · [bot-run-scheduler](../completed/500-bot-run-scheduler.md) · [bot-stability-layers](../completed/501-bot-stability-layers.md)
- [bot-title-and-id-minting](../completed/502-bot-title-and-id-minting.md) · [bot-hbs-migration](../completed/558-bot-hbs-migration.md)

### Browser (2)

- [browser-navigate-snapshot-projection](../completed/425-browser-navigate-snapshot-projection.md) · [one-click-extension-install](../completed/532-one-click-extension-install.md)

### Tool Catalog (1)

- [09-tool-catalog-unification](../completed/2026-09-tool-catalog-unification.md)

### Automation (1)

- [cron-editor-redesign](../completed/574-cron-editor-redesign.md)

***

## Tech Debt

See [tech-debt-tracker.md](./tech-debt-tracker.md).

## Principle

A plan is not progress. Landed code is progress.