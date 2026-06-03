# Phase 3B-0.1: Addendum — Winner Inconsistency Blocker

> **Status**: Audit Addendum — Records a blocker found during Phase 3B-0.1 verification.
> **Created**: 2026-06-03
> **Scope**: Documents a pre-existing inconsistency between GUI dedup logic and Agent runtime registry dedup logic. This is a Phase 3B-1 hard blocker.

---

## 1. Problem Statement

The two layers that decide which skill is "currently available" use **different dedup semantics**:

| Layer | Location | Dedup Strategy | Code Evidence |
|-------|----------|----------------|---------------|
| GUI `skills:list` IPC handler | `electron/ipc/skills-handlers.ts` | First-writer-wins via `loadedNames.add(name)` | Line 170, 213 (set is built as scanning proceeds; first match wins) |
| Agent runtime `SkillRegistry` | `packages/agent/src/skills/registry.ts` | Last-writer-wins via `Map.set(name, skill)` | Line 53-54 (`register` uses `Map.set`; the later call overwrites the earlier one) |

### 1.1 Concrete Failure Mode

Suppose two skills share the name `code-review`:
- A bundled `code-review` is loaded first (in agent runtime, registry sets bundled version)
- A user-customized `code-review` is loaded second (registry overwrites with user version)
- The GUI's `loadedNames` set observed the bundled version first; the IPC handler returns the bundled DTO

**Result**:
- GUI displays the **bundled** DTO (description, content, etc.)
- Agent runtime actually uses the **user-customized** version when invoking the skill
- A user reading GUI thinks they are using bundled; they are using user-customized

This is a real semantic divergence.

### 1.2 Why Phase 3A.1 Audit Missed This

The audit (phase-3a1-skill-identity-audit.md §3) assumed "first-writer-wins" based on the GUI's `loadedNames` set. The assumption was wrong: the agent runtime registry uses last-writer-wins via `Map.set`. The two layers' dedup strategies diverge on every same-name collision.

---

## 2. Phase 3B-1 Implications

### 2.1 Hard Blocker

Until the GUI and runtime dedup rules are aligned, the CLI cannot be implemented safely:

- `duya skill list` would have to pick ONE source of truth for which skill is "available"
- If the CLI uses the GUI's `skills:list` IPC, it gets the GUI's first-writer-wins winner
- If the CLI calls the agent runtime's registry, it gets a different winner
- These will disagree in collision cases

**Decision required**: which layer is the authoritative "available winner"?

### 2.2 Locked Preconditions for Phase 3B-1

Before starting `skillService.ts` extraction and `duya skill list/info` implementation, the following must be decided:

1. **Unified winner rule**: first-writer-wins, last-writer-wins, or a new explicit order?
2. **Source precedence order**: bundled vs user vs plugin vs project vs custom
3. **How `skillService.listSkills()` decides the winner**: must match the agent runtime exactly
4. **Conflict resolution UX**: if the GUI's display and the agent runtime's behavior differ, what does the user see and what does the agent actually do?

### 2.3 Decisions Deferred Until This Audit Is Resolved

- `skillService` extraction
- `duya skill list` / `duya skill info` commands
- CLI DTO frozen version bump
- Project / custom skill identity (still no stable IDs)

---

## 3. Open Questions for Resolution

1. **Which dedup rule is correct?**
   - First-writer-wins: earlier source wins (bundled always wins if listed first)
   - Last-writer-wins: later source wins (user always wins if listed after bundled)
   - Explicit precedence: bundled < user < plugin (defined in code)

2. **Is the inconsistency a real bug or a feature?**
   - If intended, document the rule explicitly
   - If a bug, fix the layer that is wrong (which one?)

3. **Should `SkillRegistry.register` reject duplicate names?**
   - Currently silent overwrite via `Map.set`
   - Could log + skip if name already registered (warning)

4. **Can the GUI use the same registry as the agent runtime?**
   - Currently the GUI's IPC handler is in the main process, not the agent process
   - Either lift the agent registry to a shared location, or accept the divergence

---

## 4. Stop Condition

**Phase 3B-1 is BLOCKED** until:
- The winner rule is decided and locked in this document or a successor
- The `SkillRegistry.register` behavior is audited and either confirmed correct or fixed
- The `skills:list` IPC handler is updated to use the unified rule (or shown to be already correct)

**No source code is written** for `skillService.ts`, `duya skill list`, or `duya skill info` until this addendum is resolved.

---

*This addendum is informational. It does not change the Phase 3B-0.1 fix (commit `13c1d24`), which only addresses the bundled-source classification bug. The winner-inconsistency problem is independent and must be resolved before Phase 3B-1.*