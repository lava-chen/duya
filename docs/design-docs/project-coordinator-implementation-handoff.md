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
| The unified project state | `HostProjectApiV1.getProjectState` → `GET /v1/projects/:id/state` — the project, its coordinator, its tasks and its working sessions in ONE read, so a client cannot assemble a project view from sources that disagree |
| Canonical Task state | `TaskStore` / `HostTaskApiV1` in `packages/agent-protocol/src/tasks.ts`; persistence in `packages/data/src/core-stores.ts`; Host adapter in `packages/host/src/task-api.ts` |
| Session creation and execution | `HostSessionApiV1` plus existing `session` capability; Host owns execution/authorization, worker only requests operations |
| Project conversation role | Hidden `project-coordinator` preset in `packages/host/src/worker-profiles/types.ts`, selected by `packages/ui/src/components/chat/NewChatView.tsx`; its Host-enforced allowlist contains only `session` and `todo` |
| Durable user input, receipt, lease | `packages/data/src/session-inputs.ts`, `packages/host/src/session-input-api.ts`, `packages/host/src/session-input-routes.ts`; desktop adapter under `apps/desktop/src/main/agents/server/` |
| Project memory | Reuse `@duya/memory`; Host adapter belongs under `packages/host/src/project/`. Do not route through Bot membership or invent a `botId` for projects. |
| Desktop Project entry and conversation | Project selection/composer in `packages/ui/src/components/chat/NewChatView.tsx`, active conversation in `ChatView.tsx`, Project/session grouping in `packages/ui/src/stores/conversation-store.ts`; renderer-to-Main API belongs in `apps/desktop/src/preload/index.ts` and `apps/desktop/src/main/ipc/`. |
| Desktop project workspace (delivered) | `apps/desktop/src/main/ipc/project-workspace-handlers.ts` + `apps/desktop/src/contracts/project-workspace.ts` + `packages/ui/src/components/projects/ProjectWorkspaceView.tsx`; the control lease is read by the Desktop's interagent router, so a takeover really stops the Coordinator from instructing that session |

## Continuity contract added on the task-one branch

`HostProjectApiV1` now exposes a read projection for UI consumers and Host
context assembly:

- `GET /v1/projects/:id/continuity?after=&limit=` returns current project state,
  canonical Task records plus their work Session links and acceptance status,
  versioned decisions/memory, cursor-paged Activity, and coordinator/work
  transcript references. Transcript bodies remain in MessageLog.
- `GET /v1/projects/:id/context?taskId=&maxCharacters=` returns a bounded
  context string and the source references used to build it. Relevant unfinished
  Tasks and completed-but-unaccepted work are included; other transcript text
  is read on demand from its existing Session.
- `GET /v1/sessions/:id/project-context?maxCharacters=` is what the Worker
  bootstrap actually calls. The Host derives the Project, the durable role
  (`coordinator` / `work`) and the work Session's Task from
  `projects.coordinator_session_id` / `project_task_sessions.work_session_id`;
  the caller supplies only a Session id. A cwd reverse-lookup cannot supply
  the Task, cannot tell the two roles apart, and is ambiguous when two projects
  share a root. `200 { context: null }` is the normal answer for a Session that
  is not project-bound. The Desktop sends `init` on every chat, so this read
  happens once per Run, not once per worker process.
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

1. ~~Add the explicit Project Task completion/acceptance flow in the Desktop.~~
   **Done (2026-11-04)** — `projects:task:acceptance` plus accept/reject
   buttons on every pending task in `ProjectWorkPanel`. The main process owns
   the `user_message` provenance; the renderer supplies only a click id. A Run
   terminal or Task status `completed` still leaves acceptance pending.
2. ~~Add the Desktop review flow for project memory candidates and corrections.~~
   **Done (2026-11-04)** — `projects:continuity` reads candidates, revisions
   and task acceptance; `projects:decision:review` / `projects:memory:review`
   carry confirm, correct and discard. This is what makes project memory
   reachable: the Coordinator tool may only write `candidate`, and only
   `active` memories are injected into the project context. Automatic memory
   learning remains deferred. A session-scoped injection into every new Run is
   still follow-up work — the checkpoint `3bd4f915` is explicitly marked
   "not for integration" and was not merged.
3. ~~Extend the Project view to expose Task/activity plus work Session entry
   points.~~ **Done** — the Desktop project workspace reads one unified project
   state, opens or creates the bound coordinator conversation, lists the
   project's tasks and working sessions with their live state, and lets the user
   open a working session read-only, take it over, work in it and hand it back.
   It reuses the existing Project and Session UI: there is no second transcript
   and no second task store.
4. ~~Add the "results come back to the project" loop.~~ **Done** — a settled
   work Run writes one durable project activity and a coordinator notification;
   the Desktop also wakes an idle coordinator, and a window that was not
   listening claims the notification on its next turn. A Run terminal never
   accepts or completes the Task.
5. ~~Keep Coordinator product identity and dispatch rules out of the generic
   Session service.~~ **Done** — the coordinator role, Task dispatch, ownership
   authorization and work-role mapping live in `packages/host/src/project/`
   behind a port supplied by each Host composition, and the coordinator has a
   dedicated `project` prompt system instead of falling back to `general`.
6. ~~Add a session-scoped project context injection on every new Run.~~
   **Done (2026-11-04)** — see the Session-keyed route above. The frozen
   checkpoint `3bd4f915` was NOT cherry-picked: its migration id 65 collides
   with the `run.terminal` dedupe index on the current main line, and its data
   layer had already landed through later PRs. Every failure path after a
   Coordinator `createTask` also rolls the Task back to `pending`, so a failed
   dispatch cannot leave a phantom in-progress Task. The Desktop now also
   renders the paged Activity timeline and transcript references.

The first Project chat now creates/binds a restricted Coordinator Session and
subsequent new-chat entry resumes it. Session dispatch creates and links a real
Project Task and work Session, settled work results return to the project
activity/wake path, and a replacement Coordinator can manage the project's work
Sessions through their durable links. Items 1, 2 and 6 landed on 2026-11-04, so
the user-side loop is closed at the API and Desktop surface and every Run
receives the Session's current project context. What still prevents a claim
that the end-to-end Project Coordinator is complete: a real product pass over
the whole flow with recorded feedback. The executable checklist and the
pass/fail feedback template are in the Coordinator exec-plan; that step needs
a human in front of the Desktop and is intentionally left unchecked.
