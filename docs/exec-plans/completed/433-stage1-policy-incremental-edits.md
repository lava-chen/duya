# 433 — Stage 1 Policy: Incremental Edits Instead of Full Rewrites

Status: In progress
Created: 2026-08-18
Priority: P0 (memory system quality)

## Problem

`stage1_policy.md` is fully rewritten on every curation update instead of
improved incrementally. Audit of `~/.duya/memory/memory-config` git history
(2026-08-12 → 08-17, 22 commits, `+964/-917`):

1. **Policy shaped by the latest session.** 08-17 session details (PDF→xlsx,
   OCR, IME, Cloudflare search failures) became "必捕信号" in the global
   policy. Program/episodic memory leaks into the permanent extraction
   focus.
2. **Inference-license rules.** Policy allowed interpreting "user just
   asked" as `goal`, and assistant "话密" as user `preference` without
   correction — temporary inferences upgraded to long-term facts.
3. **Concept churn.** Same concept renamed across versions (`watchlist` →
   `dimension checklist` → `extraction focus` → `政策`); sections reordered
   and re-leveled every rewrite.

### Root cause (confirmed from code, 2026-08-18)

Two compounding protocol flaws in `electron/memory/curation_single_shot.ts`:

- **A. The curator is told to emit the FULL policy text on every update.**
  System prompt: `op="update" with the FULL new policy text (markdown,
  <=8 KiB)`; `writePolicy()` then atomically replaces the whole file and
  bumps `.version`.
- **B. The curator never sees the current policy.** `assembleUserPrompt`
  includes rollouts + existing areas + memory panorama — but NOT
  `stage1_policy.md`. With no baseline in context, the LLM regenerates the
  policy from scratch each run, so every update rewrites everything and is
  shaped only by the current batch.

## Design: incremental, anchored, deterministic

### 1. Canonical policy format (v2)

- Fixed skeleton: `### S1: …` … `### S8: …` (eight dimensions, titles fixed,
  matching the curator prompt) + `### S9: GENERAL EXTRACTION RULES`.
- Every rule bullet carries a stable machine id: `- [r:<kebab-id>] text`.
- Preamble (before first section) preserved verbatim.
- Section ids/titles are NEVER editable by the curator → kills renaming churn.

### 2. Curation protocol change

`stage1_policy` becomes an edit list (schema in `curation_response_parser.ts`):

```json
"stage1_policy": {
  "op": "edit" | "no_change",
  "edits": [
    { "op": "upsert_rule", "section": "S4", "rule_id": "pdf-xlsx",
      "text": "…", "reason": "…" },
    { "op": "remove_rule", "section": "S6", "rule_id": "cloudflare-wri",
      "reason": "…" }
  ],
  "reason": "≤500 chars"
}
```

- 1–3 edits per run; rule text ≤500 chars; total policy ≤8 KiB.
- `upsert_rule`: replace existing rule by id, else append to section.
- `remove_rule`: delete by id. Unknown section/rule → recorded in
  `RunResult.policyErrors` (non-fatal), never a full-file write.
- Old `op:"update"` full-content shape is removed.

### 3. Curator prompt (self-improvement section rewritten)

- Current policy (anchored) is included in the user prompt as
  `current_stage1_policy` — the baseline the curator edits against.
- Rules: surgical edits only; never regenerate the file; never rename or
  reorder sections; one run changes ≤3 rules.
- Evidence gate: missing dimension must appear in ≥2 rollouts of the batch
  (or be a repeat miss across cycles); one-off observations → no edit.
- Content discipline: policy rules state what to CAPTURE ("capture when the
  user states a goal"), never an inference license ("interpret any question
  as a goal"); never session facts (specific project paths, single failures,
  topic snapshots) — those belong in `global/areas|preferences` actions.

### 4. Hard guards (code)

- Min interval between policy writes (default 30 min, 0 disables) — stops
  the observed 5-rewrites-in-105-min pattern.
- Empty-summary batch guard (existing) kept.
- Version bump only when content actually changed (existing `writePolicy`
  semantics kept).

### 5. Migration

- `migrateLegacyPolicy()` converts free-form/`维度 N:` files to the anchored
  skeleton (format-only; bullets → hash-stable `[r:…]` ids; non-dimension
  sections → S9; non-bullet lines preserved as section notes). Runs
  in-memory for the prompt, on-disk only when a write happens.
- One-time baseline rewrite of the live `stage1_policy.md` (v22 → v23):
  migrate + remove the session-detail and inference-license rules flagged
  in the audit.

## Files

| File | Change |
|---|---|
| `packages/agent/src/memory-rollout/stage1_policy_editor.ts` | NEW — format consts, parse/serialize/migrate/normalize, `applyPolicyEdits` |
| `packages/agent/src/memory-rollout/__tests__/stage1_policy_editor.test.ts` | NEW — editor tests |
| `electron/memory/curation_response_parser.ts` | stage1_policy schema → edits[] |
| `electron/memory/curation_single_shot.ts` | prompt rewrite + policy in user prompt + applyPolicyEdits + interval gate + policyErrors |
| `electron/memory/__tests__/curation_response_parser.test.ts` | update tests 14–16 |
| `electron/memory/__tests__/curation_single_shot.test.ts` | update tests 9–11, add new cases |
| `~/.duya/memory/memory-config/stage1_policy.md` | live baseline rewrite (v23) — outside repo |

Out of scope (follow-ups): canary `promotePolicy` full-swap path
(`electron/memory/stage1_canary.ts`) — proposal-driven, fixture-gated, not
the churn source; note: it should normalize through the editor later.

## Tasks

- [x] A. Plan file + README registration (this file)
- [x] B. `stage1_policy_editor.ts` + tests
- [x] C. Parser schema change + tests
- [x] D. `curation_single_shot.ts` prompt + apply loop + tests
- [x] E. `npm run typecheck:all` + vitest (electron/memory, memory-rollout)
- [x] F. Live policy baseline v23 (migrate + prune flagged rules)
- [x] G. Baseline v24 prompt-quality revision (2026-08-19): rules rewritten to
      「信号(示例触发句) → 动作」form with explicit usage directive for
      Stage 1; governance/meta text removed from the file (curator gets its
      editing rules from its own system prompt); negative rules kept only
      where v22 over-inferred; durable user hooks (Windows/Git Bash,
      E:\Projects paths) kept as generic examples inside rules
- [x] H. v25 constraint semantics (2026-08-19, user feedback): the policy is
      extraction CONSTRAINTS, not a checklist. Rules phrased as
      「when X, capture Y to depth Z」. S2 becomes the FOCUS-DOMAIN slot for
      the positive-feedback loop: curator adds [r:focus-<slug>] rules
      (「用户当前关注「X」：捕捉观察与想法/进展/新要求/来源」) when a NEW
      domain recurs across sessions, updates them as the domain evolves,
      removes them when it fades. Curator system prompt rewritten to
      maintain two rule kinds (generic constraints + focus-domain rules)
      with the same evidence gate (>=2 rollouts); JSON shape notes
      focus-<domain> ids. Live file v25 (version=25, 1.7 KiB), verified:
      round-trip, S1..S9 order, focus-rule upsert/remove in S2

## Verification

- [x] `npm run typecheck:all` passes (0 TS errors)
- [x] `npm run test` — `stage1_policy_editor` (23), `curation_response_parser`
      (28), `curation_single_shot` (17), `stage1_prompt_loader` (23) +
      canary/snapshot/staging/orchestrator suites green
- [x] Live policy file in anchored format; `.version` = 23
- [ ] Git audit of memory-config shows the NEXT curator update touching only a
      few lines instead of the whole file (pending next curation run)

Notes:
- DB-backed suites need `npm run rebuild:node` with the Electron app closed
  (better-sqlite3 ABI 119 vs Node 137) — pre-existing environment issue.
- `curation_single_shot.test.ts` tests 3 + 9 were already red at HEAD (shared
  `inputs` fixture lacked `summaryMarkdown`); fixture fixed in this plan.
