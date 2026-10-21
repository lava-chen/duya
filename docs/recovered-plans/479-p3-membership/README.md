# Plan 479 Phase 3 — `update_state` membership actions (recovered)

> Recovered from the orphaned branch `phase3-membership-479` on 2026-09-19.
> Branch was based on the pre-2026-09-18 git history (initial commit
> `5aa00b52`), shares zero commits with current `origin/master`, and cannot
> be merged via PR. The membership write-side implementation is **not**
> present on the new history; this folder preserves the orphan's source so
> it can be ported later if Plan 479 P3 is resumed.

## Why this was preserved

After the 2026-09-18 history rewrite, plan 479 was re-implemented in
phases 1 and 2 (PR #36 + #37). Phase 3 — the write side of bot project
membership (`update_state` with `target='project'`, `action in
{create,join,leave}`) — was never ported. The read side lives on master:

- `packages/agent/src/prompts/bot/memory/tierReader.ts` →
  `readJoinedProjects(duyaRoot, agentId)` reads
  `<duyaRoot>/agents/<agentId>/state/projects.json`
- `readProjectTierEntries(duyaRoot, joinedProjectIds)` walks each joined
  project's tier files

But **no main-process writer** exists for the membership file. Bots that
emit `update_state` membership actions in master will fail because nothing
materializes the join/leave. The orphan's `tierMembership.ts` is the
writer the new history lacks.

## Files in this folder

| File | Lines | Origin commit | Purpose |
|------|-------|---------------|---------|
| `tierMembership.ts` | 203 | `e32f75d0` (2026-09-05) | Writer for create / join / leave; atomic file write; outcome reporting |
| `tierMembership.test.ts` | 219 | `e32f75d0` | Unit tests covering all three actions, idempotency, atomicity |

Both files were extracted verbatim from the orphan commit
`e32f75d089bc60f6a6fd932c56548aeb29ee5b32` ("feat(agent): land update_state
membership actions (plan 479 p3.0/p3.2)"). Reconstruct by running
`git show e32f75d0:<path>` against a recovery branch on the old history.

## Interface contract

```ts
export type TierMembershipAction = 'create' | 'join' | 'leave';

export interface TierMembershipInput {
  /** Bot identity whose membership file is updated. */
  actorAgentId: string;
  action: TierMembershipAction;
  projectId: string;
}

export type TierMembershipOutcome =
  | 'created'
  | 'already_exists'
  | 'joined'
  | 'already_member'
  | 'left'
  | 'not_member';

export interface TierMembershipOk {
  success: true;
  outcome: TierMembershipOutcome;
  /** Duya-root-relative membership file path (forward slashes). */
  filePath: string;
  /** Full membership list after the operation. */
  members: string[];
}

export interface TierMembershipErr {
  success: false;
  error: { code: string; message: string };
}

export type TierMembershipResult = TierMembershipOk | TierMembershipErr;
```

Exported functions:

| Function | Behaviour |
|---|---|
| `membershipRelativePath(agentId)` | `agents/<id>/state/projects.json` (validates path segment) |
| `readProjectMembership(duyaRoot, agentId)` | Reads + parses the JSON list; missing/corrupt → `[]` |
| `createProjectMembership(duyaRoot, input)` | Creates `<duyaRoot>/memory/projects/<id>/`, joins creator. Idempotent. |
| `joinProjectMembership(duyaRoot, input)` | Adds `projectId` to member list. Idempotent. |
| `leaveProjectMembership(duyaRoot, input)` | Removes `projectId` from member list. Idempotent. |
| `handleTierMembership(duyaRoot, input)` | Dispatcher used by the RPC layer |

Atomicity: writes use a `tmp + rename` pattern with a 4-byte random suffix
on the tmp file. Concurrent writers race on `rename`; OS-level atomicity
guarantees the membership file is always a complete prior state or a
complete new state, never a partial write.

## Storage layout

```
<duyaRoot>/
  agents/<actorAgentId>/
    state/
      projects.json       # JSON array of joined project ids (string[])
  memory/projects/<projectId>/   # created by `create`; namespace anchor;
                                # tierReader walks tier files for this id
```

The membership list lives under the bot's own state dir — single-writer
rule is enforced at the process boundary (agent subprocess never touches
the file directly; only the main process does).

## Porting notes (orphan → master)

The orphan's commit also touched files that **are already in master under
a different shape**:

| Orphan change | Master state |
|---|---|
| `electron/memory-state/tierWriter.ts` path: `projects/<p>/agents/<a>/<slug>.md` → `memory/projects/<p>/agents/<a>/<slug>.md` | Master kept the old `projects/<p>/...` path. Do NOT apply the orphan's path change; it is inconsistent with master. |
| `electron/memory-state/tier-rpc.ts` membership dispatcher | Master has `handleMemoryTierRpc` in `tier-rpc.ts` but no membership branch. Need to add a `handleTierMembership` dispatcher on the main side. |
| `UpdateStateTool.ts` membership action case | Master has the tool; need to verify whether `target='project'` actions are wired or no-op. |
| `electron/memory-state/tierIndex.ts` (2 lines) | Cosmetic; ignore unless master diverged |

**To port:**

1. Drop `tierMembership.ts` into `electron/memory-state/`. Adjust the
   import path for the logger (`'../logging/logger'` is correct in master
   too — verify the file exists).
2. In `tier-rpc.ts`, add a new branch for the membership payload that
   delegates to `handleTierMembership`. Keep the existing tier-write
   validation layer as the thin validator — membership does not need a DB
   handle.
3. Verify `UpdateStateTool` in master supports `target: 'project'`. If
   the action enum is missing, add `create | join | leave` to its input
   schema and wire the call.
4. **Do NOT** change the `tierWriter.ts` project path — master deliberately
   kept `projects/<p>/...`. The orphan's `memory/projects/<p>/...`
   namespace dir is a separate concern (the joined-membership anchor), not
   a tier-write path.
5. Drop the test file at `electron/memory-state/__tests__/tierMembership.test.ts`.
   Tests use `node:fs` tmpdir fixtures; verify the test framework imports
   still match master (vitest with `tmpdir` from `node:os`).

## Why the other orphan branches were discarded

| Branch | Verdict |
|---|---|
| `recovery/521-browser-lifecycle` | All 4 files (`webview-memory.ts`, `webview-bridge.ts`, `daemon.ts`, `BrowserPanel.tsx`) exist on master with current content. Re-implemented, not worth porting. |
| `recovery/237-model-provider-selector-popover` | Last 10 commits are housekeeping; plan 480 P3.2 (the only substantive late change) was re-done as `59636603` on master. No unique content. |
| `recovery/code-review-history` | Title of branch does not match the contents (no `code review history` feature commits). |
| `recovery/fix-517-local` | Plan 517 was merged into master via `febc8fd4` (old path) and re-implemented on the new history. No unique content. |
| `recovery/e43-verify` | Detached HEAD with temporary work (release bumps, computer-use shim). No persistent value. |