# Plan 202 — AgentMailbox: Codex-like In-Run Instruction Pipeline

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **Goal**: When a run is executing, the user can still send messages. The agent reads them at the next safe checkpoint and decides — by message kind — whether to absorb, replan, soft-interrupt, or guard a tool. **Not** a FIFO queue that drains only after `chat:done`.
>
> **Scope of v1**: Chat runtime addendum only. No Agent Studio, no scheduled automation, no cross-session mailbox.

---

## 1. Summary

The current path (`stream-session-manager.pendingMessages` → `autoStartQueuedStream` → new `chat:start` after `chat:done`) is a queue, not a mailbox. The agent has no awareness of pending user intent during a run.

This plan adds:

1. A persistent **`agent_mailbox`** SQLite table (the actual mailbox, survives restarts).
2. A **9-point Checkpoint** protocol that the run loop / tool executor / permission gate must call into.
3. A **soft interrupt** mechanism distinct from the current hard `chat:interrupt` abort.
4. A **claim / lease / reclaim** protocol so a crashed agent does not strand observed messages.
5. A **claimBatch** API (coalesce-window based, not age-discarding) so the agent sees "等等 / 不要改 auth / 先看 README" as one merged runtime update, not three independent turns.
6. A **MailboxComposer** + **MailboxBubble** renderer surface in ChatView, separate from `messages` history.
7. **Structured `constraints_json`** for tool guards, not natural-language string matching.

A first cut that ships in one PR is forbidden: PR1 is data layer only (no agent claim), and only **PR2 onwards** can be called "Codex-like".

---

## 2. Goals / Non-goals

### Goals
- User can send a message while a run is executing and see it as a persistent pending bubble.
- The agent, at safe checkpoints, reads pending messages and decides per-kind:
  - `followup` / `correction` / `constraint` — absorb into the next model turn or guard the next tool.
  - `stop` — soft interrupt: finish the in-flight tool, then end the turn.
  - `abort_and_replace` — hard interrupt: kill the in-flight tool, replan.
- App restart does not drop pending or observed messages.
- `pending/observed` messages **never** enter the chat history (`messages` table). Only `apply(mode=promote_to_user_message)` writes a row there, and only at checkpoints where it is safe (matrix in §5).
- Mailbox messages can change **intent** and **constraints**, but **never** raise permission.

### Non-goals (v1)
- No multi-agent / sub-agent mailbox cross-pollination.
- No scheduled / cron-delivered mailbox messages.
- No Agent Studio (history, replay, search across all mailbox entries).
- No natural-language-only constraint matching — v1 uses structured fields.
- No new npm dependencies (`picomatch` is already a direct dep of `@duya/agent`).

---

## 3. Core Invariants

```
I1  Persistent. agent_mailbox is a SQLite table; nothing depends on React state.
I2  pending/observed never enter chat history.
I3  applied does not imply a chat-history row.
    Only apply(mode = promote_to_user_message) writes to messages.
I4  No user message may be inserted between an assistant tool_use and its tool_result.
    Promote-to-user-message is only valid at the checkpoints listed in §5.
I5  observed is leased. claim_token + claim_expires_at. Expired observed
    rows are reclaimable on the next checkpoint. Agent crash never strands
    a message in observed forever.
I6  Edit / cancel rules:
        pending   — editable, cancellable
        observed  — locked; user can append a correction (new row) but not
                    silently retract
        applied   — read-only
        deferred  — read-only content; cancellable
        cancelled — read-only
I7  Mailbox can change intent and add constraints, never raise permission.
I8  apply and promote are two actions: apply = "I read it"; promote = "I
    made it a turn origin". They share a transaction but the writes are
    distinct.
```

If any of I1–I8 is violated, the change is wrong — regardless of how clean the surrounding code looks.

---

## 4. Data Model

New table — see migration `packages/agent/src/session/migrations/2026_06_09_agent_mailbox.sql`.

```sql
CREATE TABLE IF NOT EXISTS agent_mailbox (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  submitted_during_run_id TEXT NOT NULL,            -- run id at submit time
  content                TEXT NOT NULL,
  kind                   TEXT NOT NULL,             -- followup|correction|constraint|stop|abort_and_replace
  status                 TEXT NOT NULL,             -- pending|observed|applied|deferred|cancelled
  priority               INTEGER NOT NULL DEFAULT 100,
  constraints_json       TEXT,                      -- structured guard (see §7)
  attachments_json       TEXT,
  source                 TEXT NOT NULL DEFAULT 'ui',-- ui|cli|api|system
  client_msg_id          TEXT,                      -- idempotency key
  -- lifecycle
  created_at             INTEGER NOT NULL,
  -- claim / lease (I5)
  claim_token            TEXT,
  claim_expires_at       INTEGER,
  observed_at            INTEGER,
  observed_at_checkpoint TEXT,                      -- which checkpoint first observed
  observed_by_run_id     TEXT,                      -- may differ from submitted_during_run_id on restart
  claim_attempts         INTEGER NOT NULL DEFAULT 0,
  last_claim_error       TEXT,
  -- apply result (I3, I4)
  apply_mode             TEXT,                      -- see §5
  applied_at             INTEGER,
  applied_at_checkpoint  TEXT,                      -- which checkpoint actually applied
  applied_summary        TEXT,
  resulting_user_msg_id  TEXT,                      -- set only when apply_mode = promote_to_user_message
  failure_reason         TEXT,
  -- edit audit (I6)
  edit_history_json      TEXT,                      -- [{editedAt, prevContent, prevKind}]
  edit_locked_at         INTEGER,                   -- set when status -> observed
  cancelled_at           INTEGER,

  CHECK (kind IN ('followup','correction','constraint','stop','abort_and_replace')),
  CHECK (status IN ('pending','observed','applied','deferred','cancelled')),
  CHECK (apply_mode IS NULL OR apply_mode IN
    ('promote_to_user_message','runtime_instruction','tool_guard',
     'permission_context','interrupt_signal','deferred_to_next_turn'))
);

CREATE INDEX IF NOT EXISTS idx_mailbox_claim_ready
  ON agent_mailbox(session_id, status, priority, created_at)
  WHERE status = 'pending'
     OR (status = 'observed' AND claim_expires_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_mailbox_session_recent
  ON agent_mailbox(session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_client_msg
  ON agent_mailbox(session_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
```

### 4.1 Why these fields

- `submitted_during_run_id` ≠ `observed_by_run_id`: when an agent restarts, "this message was submitted while run X was active" is a fact about user intent; "run Y is the one that actually picked it up" is a fact about execution. Separating them preserves the audit trail.
- `claim_token`: every successful claim writes a fresh token. `apply` and `cancel` must echo the token. Prevents a stale run from mutating a row another run has reclaimed.
- `claim_expires_at`: 30s default lease. After expiry the row is reclaimable by the next claim. See §6.
- `observed_at_checkpoint` + `applied_at_checkpoint`: distinct so we can tell "I saw it at `before_tool_call` but I actually consumed it at `after_tool_call`" (deferred path).
- `edit_locked_at`: gates I6 — once non-null, edit attempts are rejected, only append-correction is allowed.
- `claim_attempts` cap (e.g. 5): after N failed reclaims, the row is auto-`cancelled` with `failure_reason='max_claim_attempts_exceeded'` and the UI surfaces an explicit "agent lost this message" notice. Prevents infinite reclaim loops on a misconfigured row.

### 4.2 Idempotency

`client_msg_id` is a per-renderer UUID. Renderer generates it before IPC send. If the IPC fails, renderer retries with the **same** id. The UNIQUE index makes the second insert a no-op (returning the existing row). This handles the "user spam-clicks Send" and "SSE dropped my ack, did the bubble get created?" cases.

### 4.3 pending never decays

No timer, no job, no agent code may flip `pending → cancelled` because of age. The only ways out of `pending` are:
1. Successful `claim` (becomes `observed`).
2. Explicit `cancel` (renderer / cli / api).
3. Hard cap on `claim_attempts` reached (after at least one observed → reclaim cycle failed; see §6).

`coalesceWindowMs` (see §6) is **not** age-based filtering — it is anchor-based batching. A pending older than the window is still claimable; it just isn't included in the current claim's batch.

---

## 5. Lifecycle & Apply Modes

### 5.1 State machine

```
                            ┌──────────┐
   send (IPC) → INSERT ────►│ pending  │
                            └─────┬────┘
                                  │ claim (lease)
                                  ▼
                            ┌──────────┐
                            │ observed │
                            └─────┬────┘
                                  │ apply (per checkpoint, see matrix)
                                  ▼
                ┌──────────┬──────┴──────┬──────────┐
                ▼          ▼             ▼          ▼
            applied   deferred      (loop)     cancelled
```

- `pending → observed`: only via `claim` (atomic UPDATE … RETURNING, see §6).
- `observed → applied`: only via `apply` with one of the modes below.
- `observed → cancelled`: renderer can cancel; agent treats the cancellation as "skip this row, do not honor". (The user is told "may or may not be honored, depending on whether agent already consumed it".)
- `pending → cancelled`: renderer cancel — guaranteed safe.
- `deferred → cancelled`: renderer cancel — safe (agent had not used it).
- `applied / cancelled`: terminal. No further mutations.

### 5.2 Apply mode × Checkpoint matrix

Hard rule: a checkpoint that would split a `tool_use → tool_result` pair can never produce `promote_to_user_message`.

| Checkpoint               | permitted `apply_mode`                                                                                     | forbidden                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `before_model_turn`      | `promote_to_user_message`, `runtime_instruction`, `interrupt_signal`                                       | —                                        |
| `after_model_turn`       | `runtime_instruction`, `interrupt_signal`, `deferred_to_next_turn`                                         | `promote_to_user_message` (assistant text is done; half-insert breaks assistant reasoning) |
| `before_tool_call`       | `tool_guard`, `interrupt_signal`, `runtime_instruction`                                                     | `promote_to_user_message` (tool_use already emitted, next must be tool_result) |
| `after_tool_call`        | `runtime_instruction`, `tool_guard`, `interrupt_signal`, `deferred_to_next_turn`                           | `promote_to_user_message` (must not split the assistant's next reasoning step) |
| `before_file_write`      | `tool_guard`, `interrupt_signal`                                                                            | `promote_to_user_message`                |
| `before_shell_command`   | `tool_guard`, `interrupt_signal`                                                                            | `promote_to_user_message`                |
| `before_final_answer`    | `promote_to_user_message` (but promotes trigger a **new turn** — final is not finalised), `runtime_instruction`, `interrupt_signal` | completing final without re-checking |
| `on_permission_request`  | `permission_context`, `interrupt_signal`                                                                   | `promote_to_user_message`                |
| `on_error_recovery`      | `runtime_instruction`, `interrupt_signal`, `deferred_to_next_turn`                                         | `promote_to_user_message`                |

`MailboxService.assertValidApply(checkpoint, mode)` is a single function call inside the apply transaction. Any violation throws and rolls back.

### 5.3 Soft vs hard interrupt

- `mode=interrupt_signal` with `kind=stop`: **soft**. Set `runAbortController.soft = true`. The current tool call completes. The turn loop checks `soft` at the next yield boundary and exits gracefully with a final "stopped as requested" message.
- `mode=interrupt_signal` with `kind=abort_and_replace`: **hard**. Call `runAbortController.hard.abort()`. In-flight tools, LLM streams, and worker sub-processes are all torn down. Run ends. (This is what `chat:interrupt` already does.)
- Multiple `stop` + `abort_and_replace` in one batch: the strongest wins. `abort_and_replace` > `stop`.

---

## 6. Claim Protocol

### 6.1 `claimBatch` (the only claim API)

```ts
mailboxDb.claimBatch({
  sessionId: string,
  runId: string,
  checkpoint: CheckpointType,
  // Anchor-based batching (see §6.2). Default 1500ms.
  coalesceWindowMs?: number,
  // Hard cap on batch size. Default 10.
  limit?: number,
}): { rows: MailboxRow[]; claimTokens: string[] }
```

The DB-level operation is a single statement:

```sql
WITH picked AS (
  SELECT id FROM agent_mailbox
  WHERE session_id = @sessionId
    AND (
      -- pending: anchor-based (created within the coalesce window)
      (status = 'pending' AND created_at >= @anchorMs)
      -- observed: reclaim only if lease expired
      OR (status = 'observed' AND claim_expires_at IS NOT NULL AND claim_expires_at < @nowMs)
    )
  ORDER BY priority ASC, created_at ASC
  LIMIT @limit
)
UPDATE agent_mailbox AS m
SET status = 'observed',
    claim_token = @newToken,
    claim_expires_at = @nowMs + 30000,
    observed_at = COALESCE(observed_at, @nowMs),
    observed_at_checkpoint = COALESCE(observed_at_checkpoint, @checkpoint),
    observed_by_run_id = @runId,
    claim_attempts = claim_attempts + 1
FROM picked
WHERE m.id = picked.id
RETURNING m.*;
```

### 6.2 Anchor-based coalescing

The renderer sets a `coalesceAnchor` (the timestamp of the *first* pending message of the current burst) per UI session. The agent passes it as `anchorMs` in `claimBatch`. The agent's own claim endpoint computes its own anchor when no renderer anchor is supplied (e.g. CLI / API sources) — anchored to `now - coalesceWindowMs` at first call, then `now` on subsequent calls within the same checkpoint sequence.

**Why not `now - coalesceWindowMs` always**: with that, three messages at t=0/0.5/1.0s would be in different windows, claimed one at a time. Anchor-based: the first message at t=0 sets the anchor, the next checkpoint at t=1.2s sees all three within the same window and merges them.

**Pending older than the window**: still claimable. They just don't ride the current batch. The next checkpoint's anchor is the *latest* picked message's `created_at` (or a fresh `now` after a quiet period).

**Cap at 1500ms in PR2**: tunable; do not exceed 2s. Beyond 2s the user's mental model "I just sent this, why didn't the agent pick it up" starts to break.

### 6.3 `apply` & `cancel` with claim_token

```sql
-- apply
UPDATE agent_mailbox
SET status = 'applied',
    apply_mode = @mode,
    applied_at = @nowMs,
    applied_at_checkpoint = @checkpoint,
    applied_summary = @summary,
    resulting_user_msg_id = @newUserMsgId   -- NULL unless mode=promote_to_user_message
WHERE id = @id AND claim_token = @token;
-- if rowCount = 0: claim was reclaimed by another run, throw stale_claim

-- cancel
UPDATE agent_mailbox
SET status = 'cancelled',
    cancelled_at = @nowMs
WHERE id = @id
  AND (claim_token = @token OR @token IS NULL)   -- renderer cancel: no token check
  AND status IN ('pending', 'observed', 'deferred');
```

### 6.4 Reclaim cap

If `claim_attempts >= 5` after an UPDATE, the trigger / service code flips the row to `cancelled` with `failure_reason='max_claim_attempts_exceeded'` and emits a `mail:cancelled` event. UI renders this distinctly (red banner: "Agent lost this message after 5 attempts") — not as a silent drop.

---

## 7. IPC Contract

### 7.1 Renderer → Main

```ts
// window.electronAPI.mailbox (preload exposes this)
mailbox: {
  send(params: {
    sessionId: string;
    content: string;
    kind: MailboxKind;
    attachments?: FileAttachment[];
    clientMsgId: string;             // idempotency
    metadata?: { coalesceAnchorMs?: number };
  }): Promise<MailboxRow>;

  edit(id: string, patch: { content?: string; kind?: MailboxKind }): Promise<MailboxRow>;
  cancel(id: string, reason?: string): Promise<MailboxRow>;
  list(sessionId: string, opts?: { status?: MailboxStatus[]; limit?: number }): Promise<MailboxRow[]>;

  onEvent(handler: (e: MailboxEvent) => void): () => void;
};
```

### 7.2 Agent process → Main (via existing `db:request`)

```ts
mailboxDb: {
  claimBatch(input): Promise<{ rows: MailboxRow[]; claimTokens: string[] }>;
  apply(id: string, payload: {
    claimToken: string;
    mode: MailboxApplyMode;
    checkpoint: CheckpointType;
    summary: string;
    newUserMsgId?: string;            // when mode = promote_to_user_message
  }): Promise<void>;
  defer(id: string, claimToken: string, reason: string): Promise<void>;
  cancelByAgent(id: string, claimToken: string, reason: string): Promise<void>;
  listForSession(sessionId: string): Promise<MailboxRow[]>;   // for restart recovery
};
```

### 7.3 MailboxEvents (broadcaster)

`MailboxBroadcaster` in Main process fans DB-level state changes back to the renderer as a single SSE channel `mailbox:<sessionId>`:

```ts
type MailboxEvent =
  | { type: 'mail:created';   row: MailboxRow }
  | { type: 'mail:edited';    row: MailboxRow; prevContent: string }
  | { type: 'mail:observed';  row: MailboxRow; checkpoint: CheckpointType; runId: string }
  | { type: 'mail:applied';   row: MailboxRow;
      result: { newUserMsgId?: string; replanned?: boolean; interrupted?: boolean } }
  | { type: 'mail:deferred';  row: MailboxRow; reason: string }
  | { type: 'mail:cancelled'; row: MailboxRow; reason?: string; lostAfterReclaim?: boolean };
```

The broadcaster is the **only** writer of mailbox state in renderer. `mailbox.send` returns the row but the renderer also waits for the matching `mail:created` event before showing the bubble — keeps store + DB in sync.

---

## 8. Renderer State Machine

### 8.1 MailboxStore (zustand)

```ts
type MailboxState = {
  bySession: Map<string, Map<string, MailboxRow>>;
  coalesceAnchorBySession: Map<string, number>;

  // selectors
  getBySession(sid: string, filter?: { status?: MailboxStatus[] }): MailboxRow[];
  count(sid: string, status: MailboxStatus): number;

  // actions
  send(params: MailboxSendParams): Promise<MailboxRow>;
  edit(id: string, patch: ...): Promise<void>;
  cancel(id: string): Promise<void>;
  applyEvent(e: MailboxEvent): void;
};
```

`coalesceAnchorBySession` is bumped on each successful `send` to `createdAt` of the new row, fed back into the next `claimBatch` call as `coalesceAnchorMs`. The renderer does not need to know about agent-side `coalesceWindowMs`; the agent handles the timing.

### 8.2 MailboxBubble (in MessageList header, NOT inside message history)

| status      | visual                                                            | interaction                                 |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `pending`   | translucent card, spinner, "Waiting to be picked up"              | edit / cancel                               |
| `observed`  | amber border, "Agent reading at `before_model_turn`"              | locked content; cancel; **append correction** |
| `applied`   | green ✓, "Absorbed into turn N"                                   | read-only                                   |
| `deferred`  | grey, "Saved for after current task"                              | cancel; **append correction**               |
| `cancelled` | strikethrough, "Cancelled"                                        | read-only                                   |
| (reclaim-lost) | red banner inside the bubble, "Agent lost this after 5 attempts" | read-only                                   |

### 8.3 MailboxComposer (replaces MessageInput when `isStreaming`)

```
┌──────────────────────────────────────────────────┐
│ [▼ Send a follow-up]   or:  Insert into current task / Stop & replace │
│                                                   │
│ [textarea..............................] [Send]  │
└──────────────────────────────────────────────────┘
```

Auto kind inference runs at submit time (non-blocking hint chip, not a forced gate):

| Signal in content                                            | inferred kind                | also populates `constraints_json`        |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------- |
| "不要 / 别 / 禁止 / stop / abort / never" + path or command   | `constraint`                 | `targetPaths` / `blockedCommands`        |
| Glob pattern (`**/*.ts`, `src/auth/*`)                        | `constraint`                 | `targetGlobs`                            |
| "先 / 然后 / 接着 / then / 之后 / actually" leading            | `correction`                 | —                                        |
| "停止 / 算了 / cancel / stop now"                             | `stop`                       | —                                        |
| Default                                                       | `followup`                   | —                                        |

> Inference is a hint, not a contract. The actual `kind` row is the source of truth.

`stop` and `abort_and_replace` are **never** submitted via the input. They map to the existing "Stop" button and a new "Stop & replace" button (top bar). The composer is for *content-bearing* messages.

### 8.4 Edit / cancel matrix (renderer-enforced, I6)

| status      | edit | cancel | append-correction |
| ----------- | :--: | :----: | :---------------: |
| pending     |  ✓   |   ✓    |         —         |
| observed    |  ✗   |   ✗    |         ✓         |
| applied     |  ✗   |   ✗    |         ✓         |
| deferred    |  ✗   |   ✓    |         ✓         |
| cancelled   |  ✗   |   —    |         ✗         |

Tooltip on `observed` cancel button: "Agent may have already consumed this. To retract, send a new correction." This is the same path as "append correction" — keeps the contract honest.

### 8.5 History isolation

`pending` and `observed` bubbles render in a strip **above** `MessageList` (or as the first block inside an empty `MessageList`), visually grouped and visually distinct from chat history. They are never fed to the LLM as `messages` rows. `applied` bubbles may stay visible for the user's reference, but they are not the same DOM mount as `MessageItem` — different store, different component.

---

## 9. Checkpoint Integration (by PR)

PR1 introduces **none** of the checkpoints below. PR1 only persists the table and IPC; agent does not call `claimBatch`. The agent *does* expose `mailboxDb.listForSession` so a freshly-started run can see historical messages (read-only). This is the only mailbox awareness in PR1.

Subsequent PRs introduce the checkpoints listed below, in this order:

### 9.1 PR2 — `before_model_turn`

The simplest, highest-leverage checkpoint. The agent is about to call the LLM. It calls `claimBatch`, merges all picked rows into a single runtime update, and either:
- `apply(mode=promote_to_user_message)`: writes **one** new `messages` row, `role=user`, content=merged block. Goes into the next LLM call.
- `apply(mode=interrupt_signal, kind=stop|abort_and_replace)`: sets the abort flag, exits the turn loop.

This is the first checkpoint that makes the feature "Codex-like" — the agent demonstrably reacts to mid-run input.

### 9.2 PR3 — `before_final_answer`

When the agent is about to finalise (turn count hit, no more tool_use, LLM said done), re-checkpoint. If a `followup`/`correction`/`constraint` arrived in the past ~window, force a new turn (apply=promote) instead of finalising. If only `stop`/`abort_and_replace` arrived, interrupt.

### 9.3 PR4 — `on_permission_request`

Right before the agent sends `chat:permission`, checkpoint. Any picked messages are applied as `permission_context` — they are appended to the `AgentPermissionEvent.context: string[]` field (extended in `worker-protocol.ts`). Renderer `PermissionPrompt` re-renders the context list. The composer stays usable while the permission modal is open; the next message flows through the same checkpoint.

### 9.4 PR5 — `before_tool_call` / `after_tool_call` / `before_file_write` / `before_shell_command`

Tool-layer guards. Detailed in §10.

---

## 10. Tool Guard Checkpoints

### 10.1 Structured constraints

`constraints_json` (rendered as `MailboxConstraints` in TS):

```ts
type MailboxConstraints = {
  targetPaths?: string[];        // exact abs paths
  targetGlobs?: string[];        // glob patterns
  blockedCommands?: string[];    // exact or prefix match
  allowedCommands?: string[];    // whitelist
  appliesToTools?: string[];     // ['Write', 'Edit', 'Bash', ...]
};
```

Filled by:
- Renderer's `autoKindInfer` at submit time.
- Agent's `claimBatch`-side normaliser (re-runs the same inference, in case the source is `cli`/`api` and the renderer wasn't involved).

Tool-layer checkpoints **only** read `constraints_json`. They do **not** re-parse `content`. This is the only way to avoid "I said don't touch X, agent said it interpreted as Y" footguns.

### 10.2 Glob matching

PR5 uses `picomatch` (already a direct dep of `@duya/agent` — used by `GlobTool` and `package.json` declares `"picomatch": "^4.0.4"`). No new dependency.

```ts
import picomatch from 'picomatch';

const matchers = (constraints.targetGlobs ?? []).map(picomatch);
const blocked = matchers.some(m => m(relativePath));
```

Fallback for paths is exact-prefix match against `targetPaths`:
```ts
const blocked =
  constraints.targetPaths?.some(p => absPath === p || absPath.startsWith(p + path.sep)) ||
  constraints.targetGlobs?.some(g => picomatch.isMatch(absPath, g)) ||
  false;
```

### 10.3 Per-checkpoint integration points

| Checkpoint               | call site                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `before_file_write`      | `packages/agent/src/tool/WriteTool/WriteTool.ts` — after `path` resolved, before write |
| `before_file_write`      | `packages/agent/src/tool/EditTool/EditTool.ts` — same                                   |
| `before_shell_command`   | `packages/agent/src/tool/BashTool/BashTool.ts` — after `command` parsed, before spawn  |
| `before_tool_call`       | `packages/agent/src/tool/StreamingToolExecutor.ts` `executeTool()` — entry              |
| `after_tool_call`        | same — exit, after `toolResult` assembled                                              |

If any guard returns `block`, the tool returns:
```ts
{ error: true, result: `<tool_error>Blocked by user constraint in mailbox (id=${id}): ${reason}</tool_error>` }
```

The agent reads the error and re-plans. The `block` is recorded as `apply(mode=tool_guard, summary=block)`.

---

## 11. Test Plan

All tests are colocated `*.test.ts` (vitest). UI tests use Playwright. PR-to-test mapping is in §12.

### 11.1 Unit (vitest)

| #   | file                                                | case                                                                                                  |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| U1  | `mailbox/MailboxService.test.ts`                    | 50 concurrent `claimBatch` on same session → exactly one wins per row                                |
| U2  | same                                                 | `priority` ordering: pending list `[followup=100, stop=10]` → next claim returns `stop` first        |
| U3  | same                                                 | state machine: `pending → observed → applied`; second `edit` on observed returns 409                 |
| U4  | same                                                 | idempotency: same `client_msg_id` twice → second returns original row, no duplicate                  |
| U5  | same                                                 | persistence: write → close DB → reopen → rows survive, claimable                                     |
| U6  | same                                                 | lease expiry: observe at t=0 with lease 100ms, sleep 200ms, second `claimBatch` returns same row    |
| U7  | same                                                 | reclaim cap: 6th `claimBatch` on a row → row auto-`cancelled` with `failure_reason=max_claim_attempts_exceeded` |
| U8  | `mailbox/checkpoint.test.ts`                        | apply mode matrix: each checkpoint × each mode → assert `assertValidApply` accepts/rejects           |
| U9  | same                                                 | `before_file_write` block via `targetGlobs` returns `block: true` when path matches glob              |
| U10 | same                                                 | `before_shell_command` block via `blockedCommands` (prefix match) blocks `rm -rf`                    |
| U11 | same                                                 | `before_tool_call` interrupt: row with `kind=abort_and_replace` → `interrupt: 'hard'`                 |
| U12 | same                                                 | `before_tool_call` interrupt: row with `kind=stop` → `interrupt: 'soft'` (does not abort in-flight)  |
| U13 | `mailbox/apply-promote.test.ts`                     | `promote_to_user_message` writes exactly one `messages` row, attaches `resulting_user_msg_id`        |
| U14 | `mailbox/apply-non-promote.test.ts`                 | `runtime_instruction` does **not** write `messages`, only updates `agent_mailbox` row                |
| U15 | `mailbox/store.test.ts` (renderer)                  | `send` → server `mail:created` arrives → store has row, no flicker                                   |
| U16 | same                                                 | `cancel` of `observed` returns 409 from server; store does not mutate                                |
| U17 | same                                                 | coalesce anchor: 3 sends within 1s, all share the anchor of the first                                 |

### 11.2 Integration (Playwright)

| #   | scenario                                                                                                     | expected                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Long shell running, user sends "Also update the README" with default kind                                   | Bubble appears as `pending` immediately; status flips to `observed` then `applied`; agent in next turn references the README                                              |
| I2  | Same as I1, but user sends three rapid messages: "等等" / "不要改 auth" / "先看 README"                       | Three `pending` bubbles; agent absorbs all three in the next turn as a single merged runtime update                                                                     |
| I3  | Agent is about to write `src/auth/login.ts`; user sends "不要修改 src/auth/*"                                | `before_file_write` blocks; tool returns `<tool_error>Blocked by user constraint</tool_error>`; agent re-plans with different path                                            |
| I4  | User runs a long `sleep 60` via Bash; user sends "stop"                                                       | `sleep 60` runs to completion; turn ends gracefully with "stopped as requested" (no `AbortError` in stream)                                                              |
| I5  | Agent triggers a tool requiring permission; permission modal is open; user types "use /tmp instead"           | Permission modal context list re-renders with the new instruction; user clicks allow; agent honours `/tmp`                                                              |
| I6  | Send a `pending` message; force-kill Electron; restart                                                       | Bubble still `pending` after restart; subsequent run claims and applies it                                                                                              |
| I7  | Inspect `messages` table after a full run that absorbed 5 mailbox messages                                   | Exactly **5** new user rows; the merged blocks are written as single rows, not split                                                                                     |
| I8  | Send a `pending` message; cancel it within 1s; observe next turn                                              | Bubble `cancelled`; agent does not see the content                                                                                                                       |
| I9  | Send `stop` while agent is between turns (not in a tool call)                                                | Soft interrupt: turn ends cleanly; no `AbortError`; SSE stream ends with `chat:done`                                                                                    |
| I10 | Send `abort_and_replace` while a long `sleep` is running                                                      | Hard interrupt: `AbortError` in tool result; agent aborts; new turn starts with the replacement                                                                        |
| I11 | Restart agent process while a row is `observed` (simulate crash)                                            | Next run's `claimBatch` reclaims the row; bubble stays in `observed` (UI sees `observed_at_checkpoint` unchanged, `observed_by_run_id` updates)                          |
| I12 | Force `claim_attempts` to 5 via direct DB write; one more `claimBatch`                                       | Row auto-`cancelled`; UI shows red "Agent lost this message after 5 attempts"                                                                                            |
| I13 | Permission modal open, user sends "abort this permission" + "use /tmp"; user clicks allow                   | Agent receives allow with the abort request as additional context; agent decides accordingly                                                                            |
| I14 | Long tool, user sends followup; user sends second followup **before** the first is observed                 | Both are claimed together in the next `before_model_turn` batch                                                                                                          |
| I15 | After `chat:done`, send one more `pending` message                                                            | Next user send creates a new `chat:start`; new run picks it up; old run's `chat:done` is not regressed                                                                  |

### 11.3 Regression

- Existing chat integration suite (8 files under `packages/agent/src/**/__tests__/`) must remain green.
- `npm run typecheck:all` must pass after each PR.
- `npm run electron:build` must pass after each PR.
- `electron-builder` smoke: first packaged chat turn reaches Agent `ready` (per AGENTS.md "Pre-release checks").

---

## 12. PR Roadmap

| PR  | Title                                                            | In scope                                                                                                                                                                                                                                                       | Out of scope                                                | Acceptance                                                            | Claim                                                                 |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| PR1 | **Persistent pending mailbox foundation**                         | migration; `mailboxDb` namespace; `db:request` handlers (claim/apply/defer/cancel/list); preload; `MailboxBroadcaster` (SSE); `MailboxStore`; `MailboxBubble`; `MailboxComposer` (3-chip UI); auto-kind inference hint; `claim_attempts` cap; renderer tests U15–U17, integration I6/I8/I12 | any agent-side checkpoint; any `claimBatch` call from agent; any tool guard | U15–U17, I6, I8, I12 pass; `typecheck:all` and `electron:build` green | "You can send messages during a run. They are visible across restart." — **not** "Codex-like" |
| PR2 | **In-run absorption (`before_model_turn`)**                       | `MailboxService` impl (`claimBatch`/`apply`/`defer`/`cancel`); `assertValidApply`; merged-batch inject; soft/hard interrupt; `runAbortController` (soft + hard layers); run loop patch in `packages/agent/src/index.ts`; U1–U14 except I-only tests; I1, I2, I7, I9, I14 | `before_final_answer`; tool-layer guards; permission hook | U1–U14, I1, I2, I7, I9, I14 pass                                       | "First Codex-like release: agent absorbs mid-run input at the next model turn." |
| PR3 | **`before_final_answer` checkpoint**                              | re-checkpoint before finalising; force-new-turn on absorb; `apply(promote_to_user_message)` here triggers a new turn, not a finalisation; integration I15                                                                                                     | tool-layer guards; permission hook                          | I15 passes                                                            | (extension of PR2's claim)                                            |
| PR4 | **Permission request re-checkpoint**                              | `AgentPermissionEvent.context: string[]` field; `on_permission_request` checkpoint; `PermissionPrompt` re-render; "append correction" path; I5, I13                                                                                                                | tool-layer guards                                           | I5, I13 pass                                                          | (extension of PR2's claim)                                            |
| PR5 | **Tool guard checkpoints + structured constraints**               | `before_tool_call` / `after_tool_call` / `before_file_write` / `before_shell_command`; `WriteTool`/`EditTool`/`BashTool` patches; `picomatch` integration; server-side constraint normaliser (CLI/API path); I3, I4, I10, I11 | I12 already in PR1                                          | I3, I4, I10, I11 pass                                                  | (extension of PR2's claim)                                            |
| PR6 | **Test, docs, packaged smoke**                                    | full §11 run; `ARCHITECTURE.md` AgentMailbox section; AGENTS.md Map update; `package.json:version` bump per AGENTS.md semver rules; packaged build smoke                                                                                                       | —                                                           | all green; release notes drafted                                      | n/a (housekeeping)                                                     |

Each PR is independently shippable. Any PR can be reverted without taking down the rest of the feature.

---

## 13. Risk & Mitigations

| Risk                                                                                  | Mitigation                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `coalesceWindowMs` too long → user feels ignored                                       | default 1500ms; hard cap 2000ms; PR2 includes a manual `/flush` debug button (dev only)    |
| Soft interrupt never fires if tool is in `executing_command` and never yields          | tool executor checks `runAbortController.soft` at every `updateProgress` (low cost)         |
| `claim_attempts` cap too low for legitimate long claims                                | default 5; raise per-call via config; PR2 measures real claim latency before tuning        |
| Renderer retry storms on `mail:created` SSE drop                                       | `client_msg_id` idempotency is on the **insert** path, not the event path                 |
| Mailbox row explosion (every keypress → row)                                           | MailboxComposer debounces: 300ms idle before send                                          |
| `picomatch` semantics differ from user expectation (e.g. `**` without leading `**/`)  | normaliser wraps user globs in `**/.../**` when user input is bare; document in tooltips   |
| Permission modal flicker from repeated `mail:observed` events                          | `PermissionPrompt` batches context-list updates (50ms)                                     |
| PR1 ships but PR2 is delayed — users see bubbles that "do nothing"                    | tooltip in `observed` state explains "agent will pick this up at the next model turn"     |
| MailboxBroadcaster SSE is dropped → renderer stale                                     | Renderer periodic `mailbox.list(sessionId)` reconcile (every 5s while stream active)        |

---

## 14. Open Questions

| # | Question                                                                                                | Default                                                                                  |
|---|----------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| 1 | When `claimBatch` picks rows with mixed `kind`s (followup + stop), is the merge text written or only stop fires? | Stop wins. The `apply` API takes **one** mode per call. Mixed kinds → multiple apply calls in one checkpoint, in priority order: `interrupt_signal` first, then `tool_guard`/`permission_context`, then `promote_to_user_message`/`runtime_instruction`. |
| 2 | Lease duration. 30s default OK?                                                                          | 30s. Tunable per run via constructor arg.                                                 |
| 3 | Server-side constraint normaliser rules (PR5).                                                           | Mirror the renderer's auto-kind-infer rules. The single source of truth lives in `packages/agent/src/mailbox/constraintNormaliser.ts`. |
| 4 | Should `client_msg_id` live in the renderer store or be regenerated on retry?                            | Renderer owns it for the lifetime of the bubble. Persists across reload via `mailbox.list`. |
| 5 | What if user clicks "Stop" (hard abort) AND a mailbox `stop` is pending?                                  | Hard abort wins (renderer's stop is an immediate `chat:interrupt`); mailbox `stop` is moot; UI clears the bubble as "superseded by Stop". |

---

## 15. References

- Duya architecture: `ARCHITECTURE.md` (DB schema, data flows)
- `packages/agent/src/process/agent-process-entry.ts:920` — current `handleChatStart` (PR2 patches this)
- `packages/agent/src/index.ts:1257-1720` — current `streamChat` run loop (PR2 patches this)
- `packages/agent/src/tool/StreamingToolExecutor.ts:1093` — `executeTool` (PR2 + PR5)
- `packages/agent/src/tool/WriteTool/WriteTool.ts`, `EditTool/EditTool.ts`, `BashTool/BashTool.ts` (PR5)
- `packages/agent/src/process/worker-protocol.ts:94-101, 149-157, 282-306` — protocol unions (PR2 + PR4 extend)
- `packages/agent/src/session/db.ts` — migration host; add `agent_mailbox` migration alongside existing tables
- `packages/agent/src/ipc/db-client.ts:107-238` — extend with `mailboxDb` namespace
- `src/lib/stream-session-manager.ts:967-994` — current `enqueueMessage` / `autoStartQueuedStream`; **kept** for the "user sends before any run is active" case (mailbox then drains on the very next `chat:start`)
- `packages/agent/src/hooks/matcher.ts` — glob fallback option (PR5 prefers `picomatch`); `picomatch@^4.0.4` already a direct dep
- `AGENTS.md` — code style, build gates, semver for `package.json:version`
