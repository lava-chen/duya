# Phase 3B-0.2: Bundled Sync Protection & Available Winner Precedence

> **Status**: Decision Document — Locks semantics for bundled sync protection and winner precedence.
> **Created**: 2026-06-03
> **Scope**: Records the rules for (a) bundled sync never overwriting user-owned skills, and (b) v0 available-winner precedence `user > plugin > bundled`. No source code.

---

## 1. Bundled Sync Protection (Locked)

`syncBundledSkills()` must obey the following rules in all cases. Violations are bugs and must be caught by tests.

### 1.1 Target Directory Does Not Exist

| Action | Behavior |
|--------|----------|
| `copyDir(skillSrc, skillDest)` | ✅ Yes |
| `writeSkillProvenance(skillDest, name)` | ✅ Yes |
| Resulting classification | `source = 'bundled'` |

### 1.2 Target Directory Exists AND Marker Present

The directory is known bundled-derived.

| Sub-case | Action |
|----------|--------|
| User content hash == manifest bundled hash (unmodified) | Safe to upgrade: `removeDir` + `copyDir` + `writeSkillProvenance` |
| User content hash != manifest bundled hash (user-modified) | **DO NOT** overwrite. Keep user content. Keep marker. Result: bundled-derived but user-customized; classification remains `bundled` |

### 1.3 Target Directory Exists AND No Marker

The directory is user-owned, regardless of name match with bundled.

| Action | Behavior |
|--------|----------|
| `copyDir` (overwrite) | **❌ FORBIDDEN** — must not overwrite user content |
| Write marker | **❌ FORBIDDEN** — must not classify as bundled |
| Classification | `source = 'user'` |

**Rationale**: A user-created skill with a name that happens to match a bundled name is a user choice. Bundled is the lowest-priority default and may not override explicit user ownership.

### 1.4 Old Install Migration (One-Time)

Only safe path to write marker when no marker exists:

| Condition | Action |
|-----------|--------|
| No marker + content hash == manifest bundled hash (unmodified) | Migration: write marker, classify as bundled |
| No marker + content hash != manifest bundled hash (any reason) | **❌ FORBIDDEN** to migrate. Treat as user-owned. Do not write marker. |

---

## 2. Available Winner Precedence (Locked for v0)

### 2.1 Rule

For the v0 supported source set (`bundled`, `user`, `plugin`), the available-winner precedence is:

```
user > plugin > bundled
```

**Semantics**:
- `user` always wins over same-name `plugin` or `bundled`
- `plugin` (enabled) wins over same-name `bundled`
- `bundled` is the lowest-priority default
- `project` and `custom` are NOT in v0 scope; their identity model is not yet decided

### 2.2 Why This Order

1. **User > plugin**: User-owned skills represent deliberate, persistent user customization. Plugin skills come and go with plugin install/uninstall. User work should not be silently shadowed by a plugin update.
2. **Plugin > bundled**: Plugins are explicit add-ons; they should be able to extend or override bundled defaults. Bundled is the absolute fallback.
3. **Bundled**: Last-resort default; available only when no user/plugin override exists.

### 2.3 Disallowed Patterns

- ❌ Directory scan order (first-writer-wins) — accidental
- ❌ `Map.set` last-writer-wins — accidental
- ❌ Hard-coded source-priority lists embedded in two layers
- ❌ GUI dedup ≠ runtime dedup

### 2.4 Required Architecture

- **Single resolver** that both GUI `skills:list` and agent runtime `SkillRegistry` call
- Resolver computes `(logicalName, availableWinner)` deterministically
- GUI and runtime MUST go through this resolver
- Shadowed candidates do NOT appear in any list — they are deduplicated at the resolver level

---

## 3. `enabled` Semantic (Re-Locked)

`enabled` remains a name-scoped effective state derived from `skillEnabledOverrides`:

- Override schema: `Record<directoryName, boolean>` (unchanged)
- `enabled` reflects the override applied to the **resolved winner**, not per-source
- If `user:foo` and `bundled:foo` exist, `user:foo` wins; toggling `foo` in the override toggles both views (because they share a logical name)
- No new fields (`modified`, `shadowed`, etc.) in v0 DTO

---

## 4. CLI Skill Implementation Gates

`duya skill list` and `duya skill info` are blocked until:

1. ✅ Bundled sync protection: user-owned skills are never overwritten
2. ⏳ Single resolver: GUI and runtime use the same winner rule
3. ⏳ v0 precedence `user > plugin > bundled` enforced by the resolver
4. ⏳ Tests cover: user-vs-bundled winner, plugin-vs-bundled winner, user-vs-plugin winner, three-way collision, name-scoped override on winner

When all gates are met, `skillService.ts` extraction and CLI commands may begin.

---

## 5. Out of Scope (Frozen)

- `skillEnabledOverrides` schema migration
- Project / custom skill identity
- Provider / MCP / write operations
- `duya skill enable/disable/install/remove`
- CLI installer / PATH / bundle

---

*This decision document supersedes the partial semantics in phase-3a1-skill-identity-audit.md and phase-3b0-1-winner-inconsistency-blocker.md for the v0 source set.*