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
  ownership is immutable; Project deletion and canonical Task deletion clean up
  the link, while work Session deletion clears only its optional binding. Task
  deletion by source Session preserves Project-linked Tasks so replacing or
  deleting a Coordinator chat cannot erase pending project work.
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

## Continuity contract added on the task-one branch

`HostProjectApiV1` now exposes a read projection for UI consumers and Host
context assembly:

- `GET /v1/projects/:id/continuity?after=&limit=` returns current project state,
  canonical Task records plus their work Session links and acceptance status,
  versioned decisions/memory, cursor-paged Activity, and coordinator/work
  transcript references. Transcript bodies remain in MessageLog.
- `GET /v1/projects/:id/context?taskId=&maxCharacters=` returns a bounded
  context string and the source references used to build it. The new Worker
  bootstrap loads it from Host for a project-bound Session. Relevant unfinished
  Tasks and completed-but-unaccepted work are included; other transcript text
  is read on demand from its existing Session.
- `PUT /v1/projects/:id/state` replaces the current state/next step using an
  `expectedRevision` and a source reference.
- `PUT /v1/projects/:id/decisions/:key` uses `proposed`, `accepted`, or
  `superseded`; accepting requires a `user_message` source.
- `PUT /v1/projects/:id/memory/:key` supports `candidate`, `active`,
  `superseded`, or `retired`, with optimistic revision checks and provenance.
  Activating a candidate requires a `user_message` source. History is read at
  `/decisions/:key/history` and `/memory/:key/history`.
- `PUT /v1/projects/:id/tasks/:taskId/acceptance` records explicit user
  acceptance/rejection. A Run terminal or Task status `completed` leaves
  `acceptanceStatus=pending` until this operation succeeds.

The SQLite Core DB remains the authority for Project state and Task links;
`@duya/memory` provides deterministic relevance ranking and bounded rendering.
The API stores only project-scoped claims and source IDs, never a transcript
copy. UI can call the same Host HTTP client methods; it does not need a Bot ID
or a second progress store.

## Remaining integration for the next slice

1. Show the continuity snapshot, Task acceptance control, Activity cursor and
   transcript entry points in the Project UI; reconcile a failed child start.
2. Add an explicit user-facing flow that reviews worker memory candidates and
   records corrections; automatic memory learning remains deferred.
3. Extend the Project view to expose Task/Activity plus work Session entry points.
   Reuse the existing
   Project and Session UI; avoid a second transcript or task store.

The first Project chat now creates/binds a restricted Coordinator Session and
subsequent new-chat entry resumes it. Session dispatch creates and links a real
Project Task and work Session. The task-two slice adds versioned project state,
decisions, memory candidates, acceptance records and Activity in Core Data;
the Host returns these with the unchanged Task records and MessageLog refs.
Worker bootstrap loads a bounded project context. Desktop UI wiring, real
transcript navigation from these refs, and user review of memory candidates
remain for task three.
