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
- A Coordinator dispatch passes `projectTask.subject` and `.description` on the
  existing `session` tool. Host derives the Project from the trusted caller's
  bound coordinator Session, creates the canonical Task, creates the child,
  and binds `work_session_id` before starting the child Run. Task-to-Project
  ownership is immutable; SQLite cascades link cleanup on Task/Project/worker
  Session deletion.
- Child Runs from `project-coordinator` are assigned `code-expert`; the parent
  Coordinator's `session`/`todo` tool allowlist is not inherited by work.

## Stable API surface and ownership

| Concern | Interface / path owner |
| --- | --- |
| Project and task/session bindings | `HostProjectApiV1` in `packages/agent-protocol/src/projects.ts`; SQLite schema/store in `packages/data/src/project-store.ts`; Host adapter in `packages/host/src/project-api.ts`; HTTP routes/client in `packages/host/src/http-server.ts` and `http-client.ts` |
| Canonical Task state | `TaskStore` / `HostTaskApiV1` in `packages/agent-protocol/src/tasks.ts`; persistence in `packages/data/src/core-stores.ts`; Host adapter in `packages/host/src/task-api.ts` |
| Session creation and execution | `HostSessionApiV1` plus existing `session` capability; Host owns execution/authorization, worker only requests operations |
| Project conversation role | Hidden `project-coordinator` preset in `packages/host/src/worker-profiles/types.ts`, selected by `packages/ui/src/components/chat/NewChatView.tsx`; its Host-enforced allowlist contains only `session` and `todo` |
| Durable user input, receipt, lease | `packages/data/src/session-inputs.ts`, `packages/host/src/session-input-api.ts`, `packages/host/src/session-input-routes.ts`; desktop adapter under `apps/desktop/src/main/agents/server/` |
| Project memory | Reuse `@duya/memory`; Host adapter belongs under `packages/host/src/project/`. Do not route through Bot membership or invent a `botId` for projects. |
| Desktop Project entry and conversation | Project selection/composer in `packages/ui/src/components/chat/NewChatView.tsx`, active conversation in `ChatView.tsx`, Project/session grouping in `packages/ui/src/stores/conversation-store.ts`; renderer-to-Main API belongs in `apps/desktop/src/preload/index.ts` and `apps/desktop/src/main/ipc/`. |

## Remaining integration for the next slice

1. Add explicit Project Task completion/acceptance and progress reconciliation;
   Run terminal status alone must not mark the Task complete. Expose linked Task
   records through the Project UI and reconcile a failed child start safely.
2. Add a project-scoped memory adapter and inject current state/memory into new
   coordinator and work Runs without depending on a Personal Bot.
3. Extend the Project view to expose Task/activity plus work Session entry points.
   Reuse the existing
   Project and Session UI; avoid a second transcript or task store.

The first Project chat now creates/binds a restricted Coordinator Session and
subsequent new-chat entry resumes it. Session dispatch creates and links a real
Project Task and work Session, while work Run results remain available through
the existing Session management surface. Project memory and the Task/activity
view still need to land before the collaboration loop is complete.
