# CLI TUI ordering and cancellation repair

Status: implemented and locally verified; not merged. Scope: Host-backed `@duya/cli`.

## Evidence and baseline

- Existing unrelated edits in the primary checkout are preserved.
- The execution-plan index records a failing, scope-dependent full test suite;
  this slice records targeted pre-change failures rather than assuming it green.
- Screenshot session diagnostics show interrupt at 09:13:59, a refused new run
  at 09:14:03, and worker termination/settlement at 09:14:04 (2026-10-17 CST).
- The legacy Host translator reuses a per-run message ID and index zero across
  model turns. TUI identity therefore needs the accepted `turn.started` scope.

## Plan before runtime edits

1. Reproduce ordering using actual Host event shapes, including multiple model
   turns, alternating thinking/text, and authoritative final blocks.
2. Scope TUI content identity by model turn; create distinct keyed blocks and
   flush opposite-kind delta buffers before content changes.
3. Keep admission busy until remote cancellation settles. Retain unresolved
   cancellation state on errors so a new request cannot race the old run.
4. Trace the reported tool stall from persisted facts. Surface progress and
   waiting states and expose the existing diagnostics path in the TUI.
5. Run regression tests, CLI typecheck, architecture gate, build the actual
   dev CLI, and exercise the TUI in a real PTY with a browser terminal preview.

## Verification

- Pre-change focused baseline: 16/16 passed, yet repeated real Host content
  identities reproduced the missing earlier model turn in the new regression.
- Final scoped run: 668/669 passed across 52 files. The sole failure is the
  unchanged slash registry assertion missing `settings`; reproduced separately
  in the primary checkout. Includes the real engine/driver forwarding proof and
  Host HTTP plus forked-child approval, cancellation and escalation tests.
- `typecheck:all` and `architecture:check`: passed in the isolated worktree.
- `build:cli-dev`: passed including the added worker rebuild. Actual built CLI
  startup/exit in a fresh-data-root PTY exited zero and displayed the log path.
- Playwright CLI + real node-pty/xterm: verified ordered multi-turn
  thinking/text/tools, approval, denial, narrow layout, and continued input.
  Artifacts: `output/playwright/tui-foundation/`.
- `electron:build`: blocked in the unrelated gateway bundle by a damaged shared
  `proxy-agent@6.5.0` install (missing `dist/index.js`). Temporary dependency
  installation and one retry did not resolve esbuild's selected broken package.
- No live-provider tool smoke test claimed. Primary checkout remains unchanged;
  it contains unrelated dirty files and six local commits ahead of origin/master.
- Separate remaining UI defect observed: long transcript rows can still clip
  at the inline terminal width (48-column preview). This slice verifies ordering
  and approval/input lifecycles, not general transcript wrapping.
