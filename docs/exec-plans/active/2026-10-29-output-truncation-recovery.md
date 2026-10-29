# Restore progress after model output truncation

Status: active · Owner: Codex chat 01a1851e-8ef5-7981-8206-55431450abf3 · Updated: 2026-10-29
Branch: codex/tui-output-truncation-recovery · Base: 49800ec530d4c293eb9a88db05f0162e5d3be8bf
Worktree: D:/codex/worktrees/tui-stall-investigation/duya

## Goal and scope

Pass the Host-resolved output budget to production model requests and recover boundedly when a model stops at its output limit. Exhaustion must remain visible and must not claim successful completion. Preserve cancellation, run budgets and tool execution safety. Deliver through a PR; no merge authorization.

The initial local audit is in docs-local/research/tui-stall-2026-10-29. Three MiniMax-M3 runs on 2026-10-29 ended with length/4096 and thinking-only messages, then were marked completed. Existing lease-loss plan describes a different failure. Workspace context/activity tools are unavailable; use versioned plans and Git reconciliation.

## Acceptance

- Baseline relevant runtime and Host suites before edits.
- Verify initial output budget and explicit overrides reach the provider.
- Verify length recovery, bounded exhaustion, normal end_turn, partial tool safety and cancellation.
- Exercise actual Host/worker/provider wire with an isolated local scripted endpoint.
- Run typecheck:all, architecture:check and required worker build/freshness checks.

## Progress

- [x] Reconcile audit, managed worktree and source baseline; create task branch and dependency overlay.
- [x] Compare locally cloned harness implementations and record source provenance.
- [x] Record test baseline; implement budget propagation and bounded truncation handling.
- [x] Validate production chain and repository gates.
- [ ] Commit, draft PR, review/CI and handoff.

## Decisions and evidence

Baseline: 3 suites / 33 tests passed (exit 0) on base SHA, Windows / Node v24.16.0.

Claude reconstructed source query.ts:1183–1263 (clone 76d21dd) uses optional budget escalation and at most three continuation messages. Codex codex-api/src/sse/responses.rs:419–450 (clone c7234c1174) reports non-interrupted response.incomplete as ResponseIncomplete error. Adopt bounded continuation and explicit exhaustion, not provider-specific feature flags. Host resolves a 32768 default capped by declared output capacity; explicit generation overrides survive.

Local reference code is evidence about the checked-out sources, not proof of deployed Claude/Codex behavior.

## Handoff

Implementation is based on 49800ec5. Dirty scope: this plan and its README entry; runtime engine/port and loop tests; Host output budget, model port, composition/driver/session interfaces and tests; regenerated worker-entry.js and worker-metafile.json. Dependency setup uses junction-worktree.mjs with E:/Projects/duya as read-only dependency source. No live user sessions or settings changed.


## Validation record

| SHA / dirty scope | Environment | Command | Result |
| --- | --- | --- | --- |
| 49800ec5, unchanged | Windows / Node v24.16.0 | focused runtime loop + model port + product composition | exit 0, 3 suites / 33 tests |
| 49800ec5, old committed worker bundle | same | run-turn-provider-integration.test.ts -t effort | exit 0, 1 selected test |
| 49800ec5 + this patch | same | tsc -b packages/agent-runtime packages/host | exit 0 |
| same | same | npm run bundle:worker | exit 0; current worktree's production bundle |
| same | same | focused 5-suite regression | exit 0, 50 tests including real Host/forked worker/Anthropic HTTP |
| same | same | engine-* / run-engine* / worker-product-runtime + provider/budget tests | exit 0, 41 suites / 282 tests |
| same | same | npm run architecture:check | exit 0, no new violations, 4 old fingerprints no longer triggered; baseline unchanged |

| same patch | same | npm run typecheck:all | exit 0; includes repository build, runtime/web/CLI/web-app/voice/evals and existing Electron baseline gate |
| same patch | same | npm run architecture:check (final) | exit 0; no new boundary violations |
| same patch | same | git diff --check excluding generated bundle | exit 0 |

The cancellation propagation test now waits for an explicit port-open signal before aborting, preserving its original assertions while removing a guessed microtask count. A newly covered cancellation-before-request boundary now refuses to open a provider request.

The real provider test distinguishes main generation calls (32768 tokens) from independent title/suggestion calls (smaller budgets). Main generation recovers in two requests without another user submission; exhaustion stops after the initial request plus three recoveries. A provider-parsed tool call preceding max_tokens never reaches tool.call_started or the filesystem. Missing terminal confirmation likewise fails without executing queued calls.

No UI component changed: existing assistant.status and run.failed channels carry recovery progress and exhaustion. No user data/configuration changed. Full type/architecture gates passed. PR review and CI remain pending.


Bundle freshness checks are Git-history-based: before committing, the check correctly reports edited inputs after the old bundle commit even though the bundle has just been rebuilt. Re-run after committing source and generated output together. Build-only EOL changes in inline-content.ts, BashWorker.js and bundle/package.json have identical normalized Git blobs; restore only these known generated changes before commit. The generated minified bundle has inherited template-literal trailing spaces; no source whitespace errors were introduced.

Remaining steps: commit source+bundle, verify freshness at that SHA, publish draft PR and inspect its CI. Keep the managed worktree until integration and post-merge verification; no merge authorized.
