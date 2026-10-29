# Fix cached-input accounting and private progress execution

Status: active. Owner: Codex chat 01a1851e-8ef5-7981-8206-55431450abf3.
Worktree: D:/codex/worktrees/tui-stall-investigation/duya (reuse own managed checkout).
Branch: codex/tui-usage-progress-fixes. Base: 4f198043de0f4c66fc2abf873d8593481d0e8247.

Scope: Host provider usage normalization and private progress dispatch, with real worker/provider regression. No live configuration changes. Workspace tools unavailable; Git and versioned plans are the shared-state fallback.

Acceptance: cached and mixed input reaches engine accounting/compaction; OpenAI totals avoid double counting; advertised progress call succeeds and emits progress; ordinary tools and truncation safety remain intact.

Steps: baseline; implement Host adapters; regression and real worker validation; typecheck/architecture/build; narrow commit and draft PR. Integration requires authorization.

Validation: baseline in progress. Current tracked changes: this plan only. No external effects beyond fetch and local task branch.

Implemented: Host normalizes full prompt input (cache reads/writes included), with provider-style deduplication and total-token lower bound. Private progress is dispatched in composition, emits tool.group_progress with model_progress_tool source, returns a correlated result to the next request, and is removed on discard. Renamed private tools are matched via the assembly's resolved name.

Validation at base + this patch, Windows / Node v24.16.0:
- Baseline: model usage + engine composition, 2 suites / 13 tests, exit 0.
- Regression: same suites, 16 tests, exit 0 (pure cache, mixed cache/write, OpenAI inclusive total).
- npm run bundle:worker: exit 0.
- Production Host/forked worker/Anthropic socket: 8 tests, exit 0; verifies cached input=12000 and progress result in next request, plus existing worktree/tool, effort, attachment and truncation safety.
- npm run architecture:check: exit 0, no new violations; baseline unchanged.
- Full typecheck still running. Raw logs in docs-local/research/tui-stall-2026-10-29/new-*.log.

Build-only BashWorker.js and bundle/package.json changes had identical Git-filtered blob hashes to HEAD and were restored individually. Dirty scope: Host model/composition/driver, two tests, worker entry/metafile and this plan. No live configuration/process changes or merge. Next: finish typecheck, inspect staged diff, commit and draft PR; retain worktree pending review and authorized integration.

Final gates: npm run typecheck:all exit 0; git diff --check (source/docs) exit 0. All required local checks passed. Current scope is the staged task files only. Ready for commit and draft PR; latest-head review/CI remain pending. Retain this managed checkout; no merge authorization.

Delivery: implementation commit 2898168061d44b39ddf799ddc75a055107f1c07e; draft PR https://github.com/lava-chen/duya/pull/540. Post-commit bundle:verify exit 0, FRESH 0/1016 inputs. CI started (architecture/test scope); required review and latest-head CI remain pending. No integration/restart performed. No uncommitted product paths. Next: inspect PR checks/review, address failures and await authorized integration. Preserve the worktree.
