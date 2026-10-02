# 443-failclosed-command-parsing-and-content-rules

> **Status**: Planning | **Priority**: P1 | **Started**: 2026-08-25

## Goal

Make bash command parsing trustworthy enough to power permission-rule
content matching (`Bash(git status)`-style rules) and an approval cache,
following the fail-closed philosophy validated by codex and
claude-code-haha. Source study:
`docs/references/harness-comparison/bash-tool-deep-dive.md`.

## Problem

duya's Bash tool is currently 透传派 with regex guardrails. Two findings
from the 2026-08-25 harness comparison block future permission UX work:

### 1. The hand-rolled parser is not fail-closed

`packages/agent/src/utils/bash/shellQuote.ts:20` — `tryParseShellCommand`
always returns `success: true` (its try/catch wraps a loop that cannot
throw). It does not model heredocs, command substitution, process
substitution, or `$(...)`; structures it does not understand pass through
silently. `packages/agent/src/utils/bash/commands.ts:24` `splitCommand`
tracks quote state and paren depth but likewise never rejects unknown
syntax.

This is acceptable for today's consumers — informational warnings
(`analyzeCommandSafety`, `permissions/policy.ts:816`) and read-only
classification (`isReadOnlyCommand`, `permissions/policy.ts:961`). It is
NOT acceptable as the basis for allow/deny decisions.

Contrast (cc-haha `ast.ts:9`): "The key design property is FAIL-CLOSED:
we never interpret structure we don't understand... It answers exactly one
question: can we produce a trustworthy argv[] for each simple command?"

### 2. Content rules are parsed but dead; no approval cache

- Rule strings support `ToolName(content)`
  (`permissions/rules.ts:76`, adapted from claude-code-haha), but the
  content matcher `getRuleByContentsForToolName`
  (`permissions/permissions.ts:158`) has zero callers repo-wide.
- Approvals are keyed by toolUseId only; there is no per-command
  approval cache (`approvedCommand` etc.: zero hits). Codex solves the
  resulting re-prompt problem with command canonicalization
  (`command_canonicalization.rs`: `/bin/bash -lc X` ≡ `bash -lc X`;
  unparseable scripts get a sentinel prefix preserving the original).

## Non-goals / recorded decisions (2026-08-25)

- extglob disable guard + background-task tree kill already landed
  directly (worktree-bash-hardening PR); not part of this plan.
- Converging `electron/lib/process-cleanup.ts:killProcessTree` with
  `packages/agent/src/utils/processTreeKill.ts` was evaluated and
  DEFERRED to plan 330 scope: import boundary is fine (electron imports
  packages/agent source in several places), but semantics differ
  (death-polling verification, `force` skips SIGTERM) and all 9 callers
  sit on lifecycle-critical shutdown paths.
- No OS-level sandbox work here; docker/bubblewrap hook points in
  BashTool.execute are already converged (plan 429 owns Windows sandbox).

## Proposed design

Phase A — fail-closed parser
- [ ] A1: Add explicit node-kind allowlist walker over a real parse
      (candidate: tree-sitter-bash WASM like cc-haha's golden corpus, or
      a strict hand-written recursive parser with resource guards —
      decide after spike; either way: unknown structure → parse failure).
- [ ] A2: Resource guards: wall-clock timeout + node cap (cc-haha: 50ms /
      50k nodes).
- [ ] A3: Output shape mirrors codex: list of `{argv[], operator}` per
      simple command, or `unparseable` — never a best-effort guess.
- [ ] A4: Golden corpus test: corpus of tricky commands (heredoc, $(),
      backticks, process substitution, brace expansion, quoting edge
      cases, Windows `2>nul`) asserting parse-or-reject behavior.

Phase B — wire content rules onto trustworthy parsing
- [ ] B1: Route `getRuleByContentsForToolName` consumers through the new
      parser: match rule only when every simple command in the chain
      yields trusted argv and matches (prefix + subcommand, e.g.
      `Bash(git push)` must not match `git push --force && rm -rf /`).
- [ ] B2: Unparseable command + content-rule present → ask (fail-closed),
      never silent allow.
- [ ] B3: Delete or wire the dead export (no third state).

Phase C — approval cache + canonicalization
- [ ] C1: Canonicalize trusted argv for cache keys (wrapper-path
      normalization à la codex; unparseable commands are never cached).
- [ ] C2: Session-scoped approval store keyed by canonical form;
      "don't ask again" UI action writes it; deny rules still win.
- [ ] C3: Cache invalidation on permission-context change.

## Verification

- Phase A: golden corpus suite green; property fuzz (random operator/
  quote soup) never returns success on unknown structure.
- Phase B: permission gate unit tests for chain/prefix/subcommand
  matching incl. adversarial cases from the corpus.
- Phase C: manual Electron session — approve `git status` once, second
  occurrence does not prompt; `bash -lc` vs full-path variant shares the
  approval.
