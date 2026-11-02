# Project Coordinator implementation handoff

This is the implementation map for the first Project Coordinator slice. The
product boundary is defined in [Project-first architecture](./project-first-architecture.md)
and its delivery queue in [the Coordinator plan](../exec-plans/active/2026-11-02-project-coordinator.md).

## Current authoritative state

- Project identity remains `projects.project_id` in `@duya/data` Core DB.
- `projects.coordinator_session_id` points at the current project conversation.
  Replacing that Session does not change the project identity.
- `project_task_sessions` links one canonical Task ID to its Project, the
  coordinating Session that created/adopted it, and its optional work Session.
  Task content/status remains in the existing `tasks` store; do not copy it into
  this link table.
- Session input/receipt and control-lease authority is the `session_inputs` /
  `session_control_leases` implementation from PR #580. Do not add a parallel
  mailbox receipt or Session-extension lease store.

## Stable API surface and ownership

| Concern | Interface / path owner |
| --- | --- |
| Project and task/session bindings | `HostProjectApiV1` in `packages/agent-protocol/src/projects.ts`; SQLite schema/store in `packages/data/src/project-store.ts`; Host adapter in `packages/host/src/project-api.ts`; HTTP routes/client in `packages/host/src/http-server.ts` and `http-client.ts` |
| Canonical Task state | `TaskStore` / `HostTaskApiV1` in `packages/agent-protocol/src/tasks.ts`; persistence in `packages/data/src/core-stores.ts`; Host adapter in `packages/host/src/task-api.ts` |
| Session creation and execution | `HostSessionApiV1` plus existing `session` capability; Host owns execution/authorization, worker only requests operations |
| Durable user input, receipt, lease | `packages/data/src/session-inputs.ts`, `packages/host/src/session-input-api.ts`, `packages/host/src/session-input-routes.ts`; desktop adapter under `apps/desktop/src/main/agents/server/` |
| Project memory | Reuse `@duya/memory`; Host adapter belongs under `packages/host/src/project/`. Do not route through Bot membership or invent a `botId` for projects. |
| Desktop Project entry and conversation | Project selection/composer in `packages/ui/src/components/chat/NewChatView.tsx`, active conversation in `ChatView.tsx`, Project/session grouping in `packages/ui/src/stores/conversation-store.ts`; renderer-to-Main API belongs in `apps/desktop/src/preload/index.ts` and `apps/desktop/src/main/ipc/`. |

## Remaining integration for the next slice

1. Add the Project Coordinator role and bootstrap it from a Project entry with
   `coordinator_session_id`; enforce the management-only tool allowlist in the
   Host manifest/registry. A profile denylist alone is not an execution boundary.
2. Add a Host coordinator service that creates/adopts the canonical Task, starts
   an existing work Session under the user's Project workspace/checkout rules,
   binds its ID with `bindWorkSession`, and reflects receipts, progress,
   cancellation and terminal results into the existing Task state.
3. Add a project-scoped memory adapter and inject current state/memory into new
   coordinator and work Runs without depending on a Personal Bot.
4. Make the Project view open/resume the bound coordinator conversation and
   expose Task/activity plus work Session entry points. Reuse the existing
   Project and Session UI; avoid a second transcript or task store.

Until those pieces land, the persisted relationships and Host API are a stable
backend seam, not a claim that the end-to-end Project Coordinator UI is complete.
