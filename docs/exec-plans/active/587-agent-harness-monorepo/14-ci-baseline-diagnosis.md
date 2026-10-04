# 14 — CI baseline diagnosis (master red on all three platforms)

**Status:** diagnosis only. **No production or test code was changed to produce this document.**
**Branch:** `diag/587-ci-baseline` · **Base:** `origin/master` = `5dc45fcf` · **Run analysed:** `37180632253`
**Date:** 2026-10-04

---

## 0. TL;DR

Master is red because **the test gate has never once been green since it started
running**, and it started running only 3 days ago. Of the 216 ubuntu failures:

- **~99 are one family**: test fixtures hardcoded to Windows path/temp semantics
  that were never guarded, and that nobody could see because CI never ran on Linux
  before 2026-10-01.
- **~10 are a CI-config gap** we can prove and fix without touching product code
  (the agent bundle is never built; macOS `vite build` OOMs).
- **~37 are small, mechanical test↔source contract drift** (imports of symbols that
  no longer exist, a missing DB column in two fixtures, two wrong relative paths).
- **~59 are a long tail** of individually-unclassified failures that each need triage.

The single most important framing fact: **123 of 123 runs of this workflow since
2026-10-01 are `failure`; there is not one green run.** This is not a regression
introduced by a recent commit. It is a gate being switched on over standing debt.

---

## 1. Measured baseline

All four runs collected an **identical** test set (1091 files / 12890 tests), so
the vitest config and include-globs are *not* part of the problem. Only pass/fail differs.

| run | failed files | failed tests | collection |
|---|---|---|---|
| CI ubuntu (`5dc45fcf`) | 72 | **216** (+2 suite-level) | 1091 files / 12890 tests |
| CI macos (`5dc45fcf`) | **80** | **247** | 1091 / 12890 |
| CI windows (`5dc45fcf`) | 49 | 123 | 1091 / 12890 |
| local, clean worktree, no bundle | 47 | 113 | 1091 / 12890 |
| local, clean worktree, **after** `npm run bundle:agent` | 44 | 103 | 1091 / 12890 |

**macOS is the worst leg, not ubuntu.** The briefing framed ubuntu as the reference;
macos actually has 31 more failures. Any fix slice validated on ubuntu alone will
under-count.

### CI history

```
push runs in window (2026-10-02 → 2026-10-04): 51      green: 0
all runs since workflow first executed (2026-10-01T02:28Z): 123   green: 0
```

The workflow's first-ever run is on `0bc78551` (2026-10-01). `42cef0f0`
*(2026-10-03, "ci: wire architecture gate and stop skipping electron:build")* added
the `push: branches: [master]` trigger. The workflow's own header comment records
that it previously watched `main`/`develop`, **neither of which exists in this
repository**, so the push trigger never matched and the gate never ran.

> **587 did not break master. 587 turned on a CI gate that had never run, and the gate is red on arrival.**

---

## 2. Root causes

Counts are failing-test headers from the vitest `Failed Tests` summary region,
attributed per file, and are exact against the totals above.

| # | root cause | files | ubuntu | macos | windows | local |
|---|---|---|---|---|---|---|
| **A** | test fixtures hardcoded to Windows path/temp semantics | 39 | **99** | **127** | 5 | **0** |
| **B** | agent bundle never built by `pretest` or CI | 3 | 8 | 8 | 8 | 0 → **0 after build** |
| **C** | test imports a symbol the source no longer exports | 4 | 14 | 14 | 14 | 14 |
| **D** | hand-rolled DB fixture predates a migration | 3 | 14 | 14 | 14 | 14 |
| **E** | wrong-depth relative path in the test file | 2 | 9 | 9 | 9 | 9 |
| **F** | test depends on `rg` being installed | 1 | 7 | 8 | 7 | 1 |
| **G** | `@lobehub/ui` nested-`node_modules` resolution | 2 | 2 | 2 | 2 | 2 |
| **H** | recorded architecture inventory is stale | 1 | 6 | 6 | 6 | 2 |
| **I** | RAG hook exits 0 and emits nothing | 2 | 10 | 10 | 10 | 10 |
| **J** | individually-unclassified long tail | 30 | 49 | 49 | 48 | 49 |
| | **total** | 87 | **218** | **247** | **123** | **105** |

Windows' 5 and local's 0 under family A are the *inverse* signal: 3 of those files
(`run-store-migration`, `memory-rag-lib`, `SubagentTool/worktree`) are
**Windows-only** tests. Family A is better read as **"platform-specific fixtures
with no platform guard"**, failing in whichever direction the fixture assumes.

### A — Windows-assuming fixtures, unguarded (99 ubuntu / 127 macos / 5 windows / 0 local)

The dominant cause, and the one the briefing's `vi.mock` hypothesis missed.
Three proven sub-mechanisms:

**A1 — Windows temp env vars only** (`apps/desktop/src/main/core/media-allowlist.test.ts:55`, 21 failures)

```ts
const realTemp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
```

`TEMP`/`TMP` are Windows-only; the POSIX variable is `TMPDIR`. On ubuntu/macos both
are unset, so it falls back to a hardcoded Windows path that does not exist there:

```
Error: ENOENT: no such file or directory, mkdtemp 'C:\Windows\Temp/duya-media-allowlist-XXXXXX'
 ❯ apps/desktop/src/main/core/media-allowlist.test.ts:60:16
```

`beforeEach` throws, so **all 21 tests in the file fail** from one line. A literal
`C:\Windows\Temp` path inside the *ubuntu* log is the giveaway.

**A2 — Windows drive-letter path fixtures** (`workspace-resolver.test.ts`, 12 failures; also `projectResolver` 12, `securityPolicy` 8, `cua-handlers` 8, …)

`apps/desktop/src/main/db/core/__tests__/workspace-resolver.test.ts:58` seeds
`canonical_root: 'E:/repos/duya'`. On POSIX `E:/repos/duya` is **not absolute**, so
the production code's `path.resolve(cwd)` rebases it onto the runner's CWD:

```
AssertionError: expected 'no_workspace' to be 'bound'      // workspace-resolver.test.ts:101
AssertionError: expected '/home/runner/work/duya/duya/D:/projec…' to be 'd:/projects/alpha'
```

The second line is the mechanism in one string: the CI CWD got prepended to a
Windows path. Note the expected value is *lowercase* `d:` — the suite also asserts
Windows drive-letter case-insensitivity.

`packages/agent/tests/permissions/securityPolicy.test.ts:124` asserts
`isCatastrophicPath('C:\\Windows\\System32\\evil.dll') === true`; on Linux that is
correctly not a catastrophic path, so 8 assertions fail.

**A3 — macOS/host-API and platform-shell assumptions** (also fails only off Windows)

- `apps/desktop/src/main/services/__tests__/orb-insert-tab.test.ts` (6) — see family E; it fails off-Windows because the *real* OS-context bridge loads and is disabled there.
- `packages/agent/src/hooks/__tests__/executor.test.ts` (2) — `expect(exitCode).toBe(1)` receives **127**, the POSIX "command not found" code, not the Windows value; and line 181 asserts `resolveProcessSpawn('C:\\Tools\\node.exe')` returns `process.execPath`.
- `packages/voice/tests/env.test.ts` (1) — "finds the binary via the platform-native PATH separator".

**A is not product-logic breakage.** The product behaves correctly for real POSIX
paths. What is broken is that the suite encodes Windows assumptions as universal
truth. The repo already knows the fix shape — `GrepTool.test.ts:157` uses
`describe.skipIf(process.platform !== 'win32')`.

### B — the agent bundle is never built (8 per platform; **proved fixable**)

```
Error: agent bundle missing at /home/runner/work/duya/duya/packages/agent/bundle/agent-process-entry.js
  — run `npm run bundle:agent`. The tsc dist/ output cannot be forked
    (ESM reaching plugin-core src), so the bundle is the only build that reaches the executor.
```

`pretest` is `npm run build:packages && node scripts/ensure-sqlite-abi.mjs node`.
`build:packages` compiles `dist/` but **not** `packages/agent/bundle/`, which is
produced only by `bundle:agent` (a sub-step of `electron:build`). The `test` job
runs `npm ci → typecheck:all → npm test` and never builds it. 26 such lines in the
ubuntu log.

Affects `eval-legacy-loop.test.ts` (4), `eval-baseline-comparison.test.ts` (2),
`evals/agent/runner/run-suite.test.ts` (2).

**Proved, not inferred.** In a clean worktree of `origin/master`:

```
before npm run bundle:agent : 47 files / 113 tests failed
after  npm run bundle:agent : 44 files / 103 tests failed
cleared: run-suite 2, eval-baseline-comparison 2, eval-legacy-loop 4  (8 failures)
new failures introduced: 0
```

Targeted re-run of those three files after the build: `Test Files 3 passed (3) / Tests 12 passed (12)`.

This also explains a chunk of the "local is greener than CI" illusion: the **shared
checkout has `packages/agent/bundle/agent-process-entry.js` present; a clean
worktree does not.** Any local run in the shared checkout skips this failure mode
entirely.

### C — tests import symbols the source no longer exports (14 per platform)

`TypeError: (0 , getSubagentToolDefinition) is not a function`
` ❯ packages/agent/tests/unit/AgentTool/AgentTool.test.ts:16:20`

`getSubagentToolDefinition` is no longer exported from
`packages/agent/src/tool/SubagentTool/SubagentTool.ts`. That suite was last touched
by `2bf48d61` — *"test(agent): repoint five suites left behind by the SubagentTool
rename"* — i.e. the commit that tried to fix exactly this class repointed five
suites and **missed this one**.

Same family: `packages/agent/tests/unit/tools/ReadTool.test.ts` (4,
`_resetSharedParser is not a function` — left behind by `86f68e9e` *"chore: remove
document parser service"*), `packages/agent/tests/tool/byte-budget.test.ts` (2,
`APP_CONNECTION_SPEC_BYTE_BUDGET` is `undefined`), `app-connection-tool.test.ts` (2),
`run-display/node-detail.test.tsx` (1).

### D — hand-rolled SQLite fixture predates a migration (14 per platform)

```
SqliteError: table app_connections has no column named connection_slug
 ❯ ConnectionStore.upsert apps/desktop/src/main/services/app-connections/connection-store.ts:90:8
```

`connection_slug` arrived with **plan 580** D7 (migration 58,
`apps/desktop/src/main/db/schema.ts:2677`). Three sibling suites were updated
(`connection-store.test.ts:44`, `token-service.test.ts:49`,
`app-connection-service.test.ts:66` all have the column); two were not:
`app-connections/__tests__/connector-service.test.ts:41` (6) and
`oauth-flow.test.ts:101` (2), plus `security.test.ts` (6). Because the fixture is
`CREATE TABLE` inline, the migration never runs and the `INSERT` fails.
**This is plan 580 debt, not 587.**

### E — wrong-depth relative path in the test file (9 per platform)

Two files, one mistake each, and the failure text names the wrong path outright:

`apps/desktop/src/main/memory/__tests__/phase_d_no_dangling.test.ts:19`
```ts
const p = path.join(__dirname, '../../../packages/agent/src/memory-state/reconcile.ts');
// ENOENT .../apps/desktop/src/packages/agent/src/memory-state/reconcile.ts
```
From `apps/desktop/src/main/memory/__tests__/` the repo root is **five** `..`, not three.

`apps/desktop/src/main/services/__tests__/orb-insert-tab.test.ts:38`
```ts
vi.mock('../../../packages/agent/dist/context/os-context/index.js', () => ({ ... }));
```
The module under test (`orb-insert-tab.ts:27`) imports
`'../../../../../packages/agent/dist/context/os-context/index.js'` (five `..`).
The mock registers a path that **no module ever resolves to**, so it never applies;
the real bridge loads, `isEnabled()` is false off Windows, and all 6 tests
short-circuit on `os-context-bridge-disabled`. The test's own header comment
already documents this exact failure mode and names the intended fix (a vitest
alias for `@duya/agent/context/os-context`, as ISS-02 did for `allowedRoots`).

A repo-wide scan for structurally-wrong relative references into `packages/` finds
**8 references across 6 files**; 4 of the 6 files (`memory-worker.test.ts:21`,
`shadow-mode.test.ts:23`, `curation_integration.test.ts:24`,
`memory-worker.curation.test.ts:14`) point at `packages/agent/package.json` and are
currently *tolerant* of the bad path — latent, not red.

Both red files were last moved by `ce9366c9` *"refactor(desktop): relocate electron
and src under apps/desktop"* (2026-10-01), which changed the depth from under
`electron/` to under `apps/desktop/src/` and invalidated the relative paths.

### F — the test depends on `rg` being installed (7–8 per platform)

```
AssertionError: expected 10 to be 51      // GrepTool.test.ts:114
AssertionError: expected 0 to be greater than 0   // GrepTool.test.ts:85
```

`GrepTool` probes for ripgrep and silently falls back to a pure-Node search. The
Node fallback **cannot scan a bare file path** — the suite says so itself at
`GrepTool.test.ts:297`. The describes at lines 77–131 construct `new GrepTool(...)`
and call `execute` with no engine forcing, so they exercise whichever engine the
host happens to have. A dev machine with `rg` on PATH gets the `rg` engine and the
suite's expectations; a clean CI runner gets the fallback and different `total`
semantics. The file already has a `forceEngine(...)` helper (line 282) — it is just
not used by these describes.

### G — `@lobehub/ui` resolution fails in any clean install (2 suites)

```
Error: Cannot find module '.../node_modules/@lobehub/ui/es/node_modules/@base-ui/react/tooltip'
  imported from .../node_modules/@lobehub/ui/es/Tooltip/TooltipGroup.mjs
Did you mean to import "@base-ui/react/tooltip/index.js"?
```

Fails **identically in CI and in a clean local worktree**, so it is not a CI/local
difference — it is a real dependency-resolution bug that only appears after a
clean `npm ci` (npm's hoisting does not create the nested `node_modules` the
package's built `.mjs` expects). Kills both suites at collection time:
`ProviderList.test.tsx`, `ProviderManagement.test.tsx`.

### H — the recorded architecture inventory is stale (6 per platform)

```
AssertionError: expected { excluded: 379, recorded: 373 } to deeply equal { excluded: 373, recorded: 373 }
```

`scripts/architecture/slice-classification.test.ts` asserts the recorded inventory
still describes the tree; 6 files moved out of the classified set without the
record being re-cut. Last relevant commit `83508431` *"chore(arch): re-record the
M5.1 inventory for the C6.2 files"*. **This one is 587's own bookkeeping.**

### I — the RAG hook exits 0 and emits nothing (10 per platform)

```
SyntaxError: Unexpected end of JSON input
 ❯ scripts/__tests__/memory-rag-hook.test.ts:286:27
```

`runHook` (line 131) spawns `node scripts/memory-rag-hook.mjs`, asserts
`code === 0` (**passes**), then `JSON.parse(stdout)` on an **empty string**.
Reproduced by hand: with `DUYA_RAG_CONFIG_DIR` pointed at a dir containing
`[memory.rag] enabled = true`, the hook exits 0 and writes nothing. The harness
captures only stdout (`stdio: ['pipe','pipe','pipe']`, no stderr drain), so **the
underlying error is invisible from the test output**. Also hits
`memory-search-skill.test.ts` (1) and, on windows only, `memory-rag-lib.test.ts` (1).

### J — long tail (49 per platform, 30 files)

Not yet attributed. Largest single contributor is
`WorkflowPanel.test.tsx` (12, fails everywhere): the panel renders but the suite's
`data-testid` hooks are gone —

```
TestingLibraryElementError: Unable to find an element by: [data-testid="workflow-def-repo-digest"]
TestingLibraryElementError: Unable to find an element by: [data-testid="workflow-tab-runs"]
```

— i.e. family C again, at the UI level: component markup moved, suite not updated.
Also `MemoryRagCard.test.tsx` (4, missing `settings.memory.ragAdvanced` control),
and a tail of 1–2 failure files (`13-citation-drift`, `stream-session-manager`,
`workflow-store > migration 30`, `useContextUsage`, `HoverPopover`, …) that each
need an individual look.

---

## 3. The macOS `build` failure (separate job, separate cause)

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
sh: line 1:  6675 Abort trap: 6           vite build
Process completed with exit code 134.
```

`build (macos-latest)` dies in `vite build` at ~2042 MB. ubuntu and windows pass the
identical step.

The `test` job **already carries the fix** for this exact failure mode, on the
`typecheck` step only:

```yaml
# .github/workflows/test.yml:210-218
- name: Run typecheck
  # The renderer's `tsc --noEmit` aborts the Node process with
  # `Abort trap: 6` (exit 134) on the macOS runner under the default
  # heap — a V8 out-of-memory, not a type error. ...
  env:
    NODE_OPTIONS: --max-old-space-size=6144
  run: npm run typecheck:all
```

That mitigation landed in `5bf3220a` *"ci: give the typecheck step enough heap on the
macOS runner"*. The `build` job (line 305 onward) has **no `env:` block on any
step**, so `npm run electron:build` runs at the default heap and OOMs. Same
footgun, same runner, same signal — one step over.

**Assessment: CI config, not code.** One line, zero product risk, and it is the
fix 587 already applied once to a sibling step.

---

## 4. Classification

| class | meaning | ubuntu | files |
|---|---|---|---|
| **(a) caused by 587** | 587 moved/renamed/re-exported something and left a consumer stale | **~21** | 4 |
| **(b) pre-existing debt** | standing rot from 2025 → 2026-09, invisible until CI started running | **~180** | 74 |
| **(c) environment / CI-config** | the harness, not the code | **~10** + 1 job | 5 |

### (a) caused by 587 — high confidence, ~21 failures

| failures | file | evidence |
|---|---|---|
| 6 | `slice-classification.test.ts` | 587's own recorded inventory (H); commit `83508431` re-records M5.1 |
| 6 | `orb-insert-tab.test.ts` | mock path invalidated by `ce9366c9` (E); header comment already prescribes the 587-style fix |
| 3 | `phase_d_no_dangling.test.ts` | same relocation, same mistake (E) |
| 6 | `AgentTool.test.ts` | `2bf48d61` repointed five SubagentTool suites, missed this one (C) |

Confidence note: the first four rest on direct code/commit evidence. The
`byte-budget` / `app-connection-tool` pair (4) are *probably* 587 rename fallout
too, but I did not confirm the removing commit, so they are counted under (b).

### (b) pre-existing, unrelated to 587 — ~180 failures

- Family A, the non-587 portion: `securityPolicy` (8, 2026-08 commits),
  `workspace-resolver` / `projectResolver` (24), `cua-handlers` (8),
  `ide-handlers`, `project-entity-handlers`, `ApplyPatchTool`, `voice/env`, and ~20
  single-failure files. Authored 2025 → 2026-09.
- Family D, 14 — plan **580** migration 58 fixtures.
- Family C, 8 — `ReadTool` (from `86f68e9e`, 2026-09-09, the document-parser removal).
- Family F, 7; Family I, 10; Family G, 2; Family J, 49.
- The two documented local pre-existing failures, `13-citation-drift` (1) and
  `workflow-store.test.ts > migration 30` (1), are both in this bucket and both
  confirmed present in this run.

### (c) environment / CI-config — 10 failures + 1 job

- **Agent bundle never built** (8 per platform) — proven, fixed by a build step.
- **macOS `vite build` OOM** (1 job) — one-line `NODE_OPTIONS`.
- **`@lobehub/ui` hoisting** (2) — arguably a dependency bug that only *manifests*
  in a clean install; I have put it here rather than in (b) because the developer's
  working `node_modules` hides it.

### 587-attributable share

**~21 of 216 (10%)** are 587's own; **~180 (83%)** are standing debt that 587's
CI-enablement exposed; **~10 (5%)** plus the macOS build job are CI configuration.
587 is the reason the failure is *visible*, not the reason it exists.

---

## 5. Recommended fix scope — ordered by leverage

**Do not start these yet; this section is for scoping review.**

| # | slice | kind | files | failures cleared (per platform) | risk |
|---|---|---|---|---|---|
| **1** | Add `NODE_OPTIONS: --max-old-space-size=6144` to the `build` job | CI config | 1 | **1 job (macOS build → green)** | none |
| **2** | Build the agent bundle in the `test` job (`pretest` += `bundle:agent`, or a workflow step) | CI config | 1 | **8** | none — measured, 0 new failures |
| **3** | Repair stale test↔source contracts (C + D + E) | tests | 9 | **37** | low — mechanical, no product code |
| **4** | Platform-guard the Windows-assuming fixtures (A) | tests | 39 | **99 ubuntu / 127 macos** | medium — needs per-file triage: some fixtures are wrong, some assert behaviour the product only has on one platform |
| **5** | Force the GrepTool engine in tests (F) | tests | 1 | **7** | low — `forceEngine` already exists |
| **6** | Re-cut the architecture inventory (H) | 587 docs | 1 | **6** | none — but **do not** use `architecture:baseline --write` without review |
| **7** | Triage family J individually | mixed | 30 | **~49** | unknown — this is where the real product bugs, if any, are hiding |
| **8** | Root-cause the RAG hook (I) and the `@lobehub/ui` resolution (G) | mixed | 4 | **12** | unknown — both need stderr/diagnostics that the harnesses currently discard |

Slices **1 + 2** are ~30 minutes, touch no product code, and clear a whole job plus
8 failures per platform. Slice **3** is the best failure-per-effort ratio in the
test tree: 37 failures across 9 files, every one with a named root cause already
identified above. Slice **4** is the only slice that moves the ubuntu/macos totals
substantially, and it is the one that most needs a human decision about which of
"fix the fixture" vs "guard the suite" vs "the product really is wrong on POSIX"
applies per file — it should be split by subsystem, not taken as one unit.

**Sequencing note:** slices 1 and 2 are independent of everything else and can land
immediately. Nothing in slices 3–8 depends on them.

---

## 6. Reproducing this cheaply

The 10-minute CI round trip is not needed. In a clean worktree of `origin/master`:

```bash
git worktree add .claude/worktrees/<name> -b <branch> origin/master
cd .claude/worktrees/<name>
npm ci --offline --ignore-scripts     # 1708 pkgs, ~40s; better-sqlite3 13.0.3 is
                                     # NAPI — prebuilds ship in the tarball, so
                                     # --ignore-scripts is safe, no ABI swap needed
npm test                              # ~150-170s locally; 113 failures, matches CI
```

- Matches CI collection exactly (**1091 files / 12890 tests**) and reproduces the
  ubuntu failure set almost exactly (113 local vs 216 ubuntu; the delta is family A).
- `npm run bundle:agent` first → **103** failures, and slice 2 is thereby *measured*
  rather than argued.
- `npx vitest run <file>` isolates a single file in ~10-15s.
- `npm run electron:pack` is **not** needed and must not be run for this.

Log-analysis helpers used to produce this document, if re-running the CI side:
download a job log with
`gh api "repos/lava-chen/duya/actions/jobs/<jobId>/logs" > <file>`, then **decode it
as UTF-16LE** — PowerShell's `>` redirect emits a BOM and NUL-interleaved text, so
naive UTF-8 reads silently match nothing. Strip the per-line
`2026-10-04T05:47:24Z ` prefix and ANSI codes before grepping. Job ids for run
`37180632253`: ubuntu test `111372319161`, macos test `111372319223`, windows test
`111372319231`, macos build `111372520333`.

**The cheap standing check:** `npm test` on any clean checkout is the whole
baseline. If a slice claims to have fixed N failures, re-run it — do not infer it
from a CI run.
