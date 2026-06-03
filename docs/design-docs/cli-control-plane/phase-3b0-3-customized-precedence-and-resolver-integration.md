# Phase 3B-0.3: Customized Bundled Precedence & Resolver Integration

> **Status**: Decision Document — Locks provenance vs effective precedence semantics and resolver integration plan.
> **Created**: 2026-06-03
> **Scope**: Documents the two-layer model (origin / customized) and the unified resolver consumer wiring. No source code in this document.

---

## 1. Problem Statement (Phase 3B-0.2 Leftover)

The Phase 3B-0.2 rule set has an internal contradiction:

- A user-customized bundled-derived skill retains `origin = bundled`
- Winner precedence is `user > plugin > bundled`
- Therefore a customized bundled skill would be **shadowed by a same-named plugin skill**

This is incorrect. User modifications are persistent, intentional work. A user who edited a bundled skill has expressed a preference that should not be silently overridden by a later-installed plugin.

---

## 2. Two-Layer Model (Locked)

Every skill has **two distinct attributes**:

### 2.1 `origin` (provenance)
The original source. Stable for the lifetime of the skill.
- `bundled` — synced from app package
- `user` — user-created or user-only
- `plugin` — provided by an installed plugin

### 2.2 `customized` (modification state)
For `origin = bundled` skills only:
- `false` — content matches the bundled version
- `true` — user has modified the content (hash mismatch with manifest)

For `origin = user` or `origin = plugin`:
- always `false` (the field is unused for non-bundled origins)

### 2.3 `effectivePrecedence`
The precedence value used in winner resolution, derived from `(origin, customized)`:

| origin | customized | effective precedence |
|--------|-----------|---------------------|
| `user` | n/a | 4 (highest) |
| `bundled` | `true` | 4 (elevated to user-level) |
| `plugin` | n/a | 3 |
| `bundled` | `false` | 2 (default) |
| `bundled` | `false`, no marker | 1 (lowest, defensively user-treated) |

The key rule: **a customized bundled skill competes at the user level**.

### 2.4 Concrete Winner Outcomes

| Conflict | Winner | Rationale |
|----------|--------|-----------|
| customized bundled + plugin | customized bundled (level 4) | user work has priority over plugin |
| plain bundled + plugin | plugin (level 3) | plugin extends bundled defaults |
| user + plugin | user (level 4) | user-owned work has priority |
| user + customized bundled + plugin | user (level 4) | user owns the current truth |
| user + plain bundled | user (level 4) | user overrides bundled |
| plain bundled alone | plain bundled (level 2) | fallback default |
| customized bundled alone | customized bundled (level 4) | user-customized defaults |

---

## 3. Manifest Hash Semantic (Locked)

The `.bundled_manifest.json` stores the **last-known-on-disk hash of the bundled-derived directory**. The semantic is:

- After a successful bundled sync (no user modification): `manifest.hash == bundled-source-hash`
- After a user modification: `manifest.hash == user-modified-hash` (synced updates manifest to current state)
- After a fresh migration: `manifest.hash == bundled-source-hash` AND marker is written
- After a deletion-then-recreation as user-owned: manifest entry may still exist, but the dir has no marker, and sync must skip it

**Implication for upgrade safety**:
- When `manifest.hash == current-dir-hash`, we know the dir is in a known state
- When `manifest.hash != bundled-source-hash`, the user has modified → do not overwrite
- When `manifest.hash != current-dir-hash`, drift detected → still do not overwrite user content

**The manifest hash is the canonical "last observed" hash, not a target hash to enforce.**

---

## 4. CLI DTO Status (Re-evaluated)

Until §2.3 is locked, `duya skill list` DTO is **not** frozen.

After §2.3 lock, the v0 DTO candidates are:

### 4.1 list DTO
- `id` (frozen)
- `name`
- `description`
- `source` (the `origin`, not the effective precedence)
- `enabled`

### 4.2 info DTO
- All list fields
- `category`
- `userInvocable`
- `allowedTools`
- `platforms`

### 4.3 `customized` field — TBD

Two options:

**Option A — Hide `customized`**: DTO shows `source: bundled` whether or not customized; user cannot tell from CLI whether their modifications are at risk.

**Option B — Expose `customized`**: DTO shows `source: bundled` AND `customized: true` when the dir hash differs from bundled. This makes the resolver-level distinction visible to the CLI consumer.

**Decision deferred** — both options have trade-offs:
- A is simpler DTO; user may not realize their customized skill is at user-precedence
- B is more informative; DTO gets one extra field; semantic is "did user modify bundled content"

This decision is documented as a pending item and is **part of** the v0 DTO freeze.

---

## 5. Resolver Integration Plan (Locked)

The shared `packages/agent/src/skills/resolver.ts` must be wired into both:

### 5.1 GUI consumer chain

`skills:list` IPC handler currently:
1. Scans dirs in fixed order
2. Uses `loadedNames.add()` first-writer-wins

Required new chain:
1. Scan all dirs, classify each entry by `origin` and `customized`
2. Build a flat list of candidates with `name`, `source`, `customized`
3. Call `resolveAvailable(candidates)` to compute the final available set
4. For each winner, attach the `enabled` state from `skillEnabledOverrides`
5. Return to renderer

### 5.2 Agent runtime consumer chain

`SkillRegistry.register()` currently:
1. Calls `Map.set(name, skill)` — last-writer-wins
2. Has no notion of `customized`

Required new chain:
1. Reject duplicate names with a warning (or log + skip)
2. Trust the source of the registering skill; the resolver is applied at the discovery side, not at register time

Alternative: agent runtime also goes through the resolver, reading the same data sources as the GUI.

### 5.3 Parity Test Requirement

The parity test must prove:
- Same `candidates` input → GUI and runtime produce identical `(name, source, customized, enabled)` tuples
- The actual GUI IPC payload equals the agent runtime's `SkillRegistry.list()` projection
- No accidental ordering dependency

---

## 6. Stop Condition

`skillService.ts` extraction and `duya skill list/info` remain blocked until:

1. ✅ §2 two-layer model implemented in source
2. ✅ §3 manifest hash semantics with continuous-upgrade tests passing
3. ✅ §5 resolver integrated into both GUI IPC and agent runtime, with parity test passing
4. ⏳ §4 DTO `customized` field decision finalized
5. ⏳ All formal tests green
6. ⏳ No new typecheck errors

---

*This document supersedes §1.2 of phase-3b0-2-sync-protection-and-precedence.md regarding winner precedence for customized bundled skills.*