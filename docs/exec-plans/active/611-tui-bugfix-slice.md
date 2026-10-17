# CLI TUI ordering and cancellation repair

Status: implemented and locally verified; not merged. Scope: Host-backed `@duya/cli`.

## Follow-up: stop and continue (2026-10-17)

The real session reached a durable failed terminal at 10:01:01 but its next
start at 10:01:08 was rejected by the Host's live-session map. The previous
CLI-only admission barrier did not cover that Host bookkeeping leak.

Before further runtime edits:

1. Extend actual Host/HTTP/child-worker cancellation tests to start another run
   immediately after both cooperative and escalated cancellation.
2. Make successful cancellation go through the orchestrator's common release
   and settlement path, preserving newer runs when an old run is cancelled.
3. Exercise the real TUI stop/continue callbacks against that Host, including
   queued prompts and startup interruption, rather than a mocked cancel API.
4. Continue narrowing the grep stall using production dispatch evidence;
   direct concurrent searches already complete in milliseconds.

Follow-up result:

- Both real Host stop/restart regressions failed before the fix with the same
  live-run refusal. Routing cancellation through `RunOrchestrator.#finish`
  releases ownership and closes the live stream before acknowledging it.
- The forced-stop regression then exposed a second race: a killed child was
  still present until its exit event. Run admission now replaces that child;
  old exit cleanup preserves the replacement's activity timestamp.
- 47/47 targeted tests passed across six files, including the actual TUI
  callbacks with real HTTP, SSE, SQLite and forked workers for cooperative and
  escalated stops. Only the terminal painter is substituted in that test.
- Playwright + real PTY also verified Esc, submitting `continue` during the
  five-second grace window, queueing, worker replacement and a completed next
  turn with the actual TUI and Host. Screenshot:
  `output/playwright/tui-foundation/host-stop-continued.png`.
- `typecheck:all`, `architecture:check` and `build:cli-dev` passed again.
- The original concurrent grep stall remains unlocated; recorded events show
  no pending permission request. Direct searches do not reproduce the stall.

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
