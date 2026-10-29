# Provider validation and TUI run finalization

Status: active. Owner: Codex chat 01a1851e-8ef5-7981-8206-55431450abf3.
Checkout: D:/codex/worktrees/tui-stall-investigation/duya (reuse owned managed checkout).
Branch: codex/provider-validation-and-run-finalization. Base: 661c966f1cbe74b32168f3b0f2d2b6825c3eecce, PR #546 (unmerged dependency).

Goal: validate staged provider credentials in Host before writing; remove client rollback claims; skip absent turn suggestions; keep lease bodies active and log non-sensitive failure causes. No live secrets/configuration changes.

Acceptance: failed/rejected/thrown probes leave files byte-identical, successful validation commits; CLI requests validation without a second save/rollback; no-suggestion is a normal outcome; real lease body heartbeats survive a short body timeout. Relevant baseline, typecheck, architecture and required bundles before commit/PR. No merge authorization.

Workspace context tools unavailable: reconciled Git/PR state instead. Current scope: Host/protocol/CLI adapters and tests, this plan and generated worker. Validation pending. Raw audit/repro is in docs-local/research/tui-stall-2026-10-29.

Implementation: HostProviderWriteInput.validateConnection requests a Host-memory candidate probe; failed probes write nothing. The Host rechecks revision after the probe to avoid overwriting external edits. CLI delegates validation, removing secret-blind rollback and misleading restoration messages. No-suggestion returns before save. Lease sends 15s newline heartbeats and clears its timer on release; client includes cause code in loss reason.

Validation, Windows / Node v24.16.0 at base + this patch:
- Baseline provider/CLI: 2 suites, 55 tests, exit 0.
- Related provider write/HTTP/CLI/suggestion/lease: 5 suites, 98 tests, exit 0; includes real Host lease heartbeat (15.2s).
- Additional HTTP candidate-validation case: 17 tests, exit 0; rejected clear-key preserves old secret/config bytes.
- Real-file provider cases cover bad key, thrown network error, successful commit and concurrent external edit.
- npm run bundle:worker exit 0; npm run architecture:check exit 0, no new violations and no baseline edits.
- Full typecheck in progress. Logs: docs-local/research/tui-stall-2026-10-29/repair-*.log.

The historical ~306s disconnect cause remains unproven; heartbeat prevents idle-body timeout and logs now distinguish future causes. Runtime cancellation/release tests remain green. No live Host/configuration restart or integration. Dirty scope is this plan, protocol field, CLI command/tests, Host validation/lease/suggestion paths/tests and regenerated worker. Next: finish gates, commit and create a stacked draft PR against #546. Do not integrate #546 before evaluating this fix.

Final verification: full npm run typecheck:all exit 0, final architecture:check exit 0, source/docs diff check exit 0. Final provider suites: 77 tests (23 CLI, 37 real-file Host, 17 HTTP), exit 0; unchanged suggestion/lease suites contribute 23 cases, previously passed, including heartbeat; production worker/provider: 4 cases, exit 0. Additive capability advertisement blocks edits against older Hosts before writing. Relevant baseline was 55 provider/CLI tests.

All generated-only EOL changes were checked against HEAD's filtered Git blobs before restoring the individual paths. No unrelated working files are staged. PR will be stacked on #546; newer main contains other runtime/bundle changes, so integration must reconcile/rebuild bundles rather than hand-merge minified output. No integration, release or live restart authorized/performed. Next: commit the three logical repairs, verify bundle freshness and publish the stacked draft PR; keep checkout until review/CI and authorized integration.

Delivery: commits 12950cf3 (provider validation), 0c9d9db6 (absent suggestions), 5454f2dc (lease/worker). Stacked draft PR https://github.com/lava-chen/duya/pull/548 targets codex/632-provider-tui-panel (#546). Post-commit bundle:verify exit 0, FRESH 0/1015 inputs. Local checks passed; PR review/CI not yet confirmed. No merge/restart performed. Current product paths committed; keep the worktree pending review, integration and validation against latest main. Next: review #548 with #546, handle generated bundles during integration, and update runnable Host/CLI only after authorization.
