# evals/agent — plan 587 E4.3

The evals consume the same API the product consumes. They do not wrap it, mock
around it, or re-implement any of it: every behavioural fact in a report was
observed by the **E4.1 harness** (`apps/desktop/src/main/__tests__/eval-legacy-loop.ts`),
which forks the real `agent-process-entry` bundle against a real loopback
Anthropic SSE provider on real SQLite. This tree adds the case format, the
evaluators, the runner and the report on top of that harness. It does not add a
second harness.

```
evals/agent/
  cases/        the versioned case format, and the cases themselves (*.json)
  fixtures/     the one adapter from a case to the harness's input type
  runner/       the loop over cases, the report, and the process entry point
  evaluators/   the four families, the failing-layer vocabulary, the live path
  reports/      generated output (gitignored — an artefact, not source)
```

## Why the tree is at `evals/` and not in the electron test tree

E4.1 deliberately put its harness in `apps/desktop/src/main/__tests__/`. That was
right for E4.1: the harness has to import the real main-process modules, and the
test tree is where a test that does that belongs. **The harness stays there.**
What moved out is the layer that is not a test of the harness — the case data,
the evaluators, the aggregation policy and the report.

The reason is the hard constraint: *the production build must not depend on eval
code.* Under `evals/` that is true by construction:

| | in the electron test tree | at `evals/` |
|---|---|---|
| compiled by a build tsconfig | only via an `exclude` entry in `tsconfig.main.json` | never — no build tsconfig includes it |
| visible to `architecture:check` | no (`__tests__` is skipped) | no (`evals` is not in the audit's `ROOTS`) |
| one bad edit away from shipping | yes: drop the `exclude` and it compiles into `dist-electron` | no: there is no include to add it to |
| typechecked | **no** — `tsconfig.main.json` excludes `**/__tests__/**` | yes, via `evals/tsconfig.json` |

The last row is the other reason. E4.1's harness, living under `__tests__`, is
excluded from every tsconfig in the repo, so it has never been typechecked —
which is how four real type errors sat in it (a permission mode the product does
not have, a `maxTurns` field that never existed on the command, an untyped
iteration, and a string recorded as a number). Those are fixed, and
`typecheck:evals` now covers the tree. Putting the eval layer where it is
typechecked was worth a directory.

`production-independence.test.ts` asserts all of this from the source, in both
directions, so the claim cannot rot.

### No private workspace

The plan allows one "when dependency management requires it". Nothing here does:
the eval tree needs `vitest`, `vite-node` and `better-sqlite3`, all of which the
root already manages, and it shares the root's `ensure-sqlite-abi` handling
because it runs through the same toolchain. A private workspace would add a
second `package.json`, a second install, and a second place for the
`better-sqlite3` V8-ABI split to go wrong — for zero new dependencies.

## The case format

A case is **versioned JSON on disk**. JSON, not typed modules, for two reasons:

1. A case must survive a refactor of the code that runs it. As a typed module it
   would be refactored alongside the runner, and a `git blame` on a red eval
   could no longer tell you whether the *meaning* changed or the *wiring* did.
   As JSON the case is inert: the runner can be rewritten under it, and the diff
   shows whether the meaning moved.
2. A case must be reviewable as a semantic diff. The question a reviewer asks is
   "did this PR weaken an expectation?", and the answer has to be legible.

The cost is that nothing checks the shape at author time. That is paid back by
`parseCase`, which is strict and names every problem it finds, and which every
case must pass before it can run.

A case declares:

- `input` — the prompt, and the files seeded into the temp workspace
- `scenario` — the mock provider script: the turns, the blocks, the declared
  usage, and whether to tamper the manifest binding
- `policy` — the run's whole-turn permission mode
- `budget` — `maxTurns` and `timeoutMs`
- `expect.invariants` — declarations from the structure, safety and
  cost/performance families
- `expect.artefacts` — the task-artefact declarations
- `live` — the fixed parameters a live run would use, and how many measurements
  it would take

### How a case keeps its meaning across a run-layer change

Three mechanisms, in increasing order of strength.

1. **`formatVersion` + a migration table.** A loader with no migration for a
   case's version **refuses to run it**, and the case is reported as `skipped`
   naming the version it cannot read. An old case never silently runs under a
   changed interpretation. This is the hard guarantee.
2. **`pinnedContract`.** Every case names the run-layer contract its expectations
   were written against. When the run layer moves, the report shows a
   `stalePin` next to the case. A stale pin is *not* a failure — it is a prompt
   to re-read the expectation and decide whether it still holds.
3. **A closed vocabulary of invariant kinds.** Expectations are declared against
   named facts — terminal status, a tool's name and outcome, usage equal to what
   the fixture declared, a real file's bytes on disk — never against a recorded
   frame trace. A refactor that renames an internal frame does not touch a case.
   A refactor that changes what `completed` *means* does, and that is a change
   worth a case edit.

## The four evaluator families

| family | the question it answers |
|---|---|
| `structure` | what did the run layer do — terminal, durability, manifest binding, run control |
| `safety` | what must NOT have happened, and what must not have leaked |
| `task-artefact` | does something real exist on disk, or did a real tool really run |
| `cost-performance` | the budget the run was held to |

`task-artefact` is the family with the most obvious way to be wrong, so the rule
is stated rather than assumed: **the transcript is never consulted.** A case may
assert a real file's bytes, or that a real tool returned success. There is
deliberately no artefact kind for "the model said it finished" — a model that
writes "Done! I wrote summary.txt" produces no file, and that run fails.

## The failing-layer vocabulary

`contract`, `host-adapter`, `model-decision`, `tool`, `storage`, `policy`,
`environment`, plus `unknown`.

The layer is **derived, never chosen**. A layer a human picks reflects the
author's belief about the system under test, which is the belief the eval exists
to check. So attribution is a table over the protocol's own closed `ErrorCode`
set, plus a small ordered set of artefact signals. Three outcomes are handled
explicitly:

- a real code nobody classified is **`unknown`** — not guessed from its name
  (`internal` is deliberately in this bucket, with a written reason);
- a code **outside** the closed set is **`contract`**: an emitter using vocabulary
  the contract does not define is a contract violation by definition;
- a failed terminal naming **no** code is **`unknown`** — "it failed" is not "the
  tool failed".

`codeCoverage()` is the pressure that keeps the table honest: a new protocol code
that nobody has classified fails a test, so a code cannot arrive without a layer.

## `unknown` and `skipped` are results, not holes

- `unknown` — the check ran and could not decide. A fact about the system's
  observability.
- `skipped` — the check did not run. A fact about the evaluation's reach.

A case's status is the **worst** of its checks, ordered
`fail > unknown > skipped > pass`. `skipped` outranks `pass` deliberately: a case
whose other four checks passed and whose fifth could not run is `skipped`, not
`pass`, because a reader who sees `pass` stops looking.

Exit codes:

| code | meaning |
|---|---|
| 0 | every check passed; nothing unknown, nothing skipped |
| 1 | at least one check failed |
| 2 | nothing failed, but something was unknown or skipped — **not success** |
| 3 | the suite could not run at all (the environment, not the system) |

`fail` outranks `unknown`/`skipped` so a regression is never masked by a gap, and
2 is distinct from 0 so a job running the fixed set cannot go green on a set that
silently shrank.

## Offline and live, reported separately

The offline path is deterministic: the loopback provider serves declared bytes,
the real adapter parses them, and the report asserts exact traces and artefacts
(`determinism: 'exact-assertion'`).

The live path is sampled, not controlled. It fixes what it can (model, temperature,
max tokens, measurement count), takes N ≥ 2 measurements, and reports the sample
with its min/max/mean/variance/spread under `determinism: 'not-claimed'`. A live
case is **never** answered by the offline provider: `toHarnessInput` refuses a
live case outright, because a report labelled `live` whose bytes came from a
fixture is the exact fabrication the plan forbids.

A live run needs a provider credential and explicit network authorisation. With
neither, the case is `skipped` with the missing capability named and the report
exits 2.

## Running it

```bash
npm run eval:agent:smoke       # the small fixed high-value set
npm run eval:agent:extended    # every case on disk
node scripts/eval-agent.mjs --list
```

Both exit with the report's own code. `smoke` requires completeness: any unknown
or skipped check is exit 2. `extended` reports reach gaps as data.

**No automated trigger is added.** These are the two named commands and the data
contract; whether and when they run is the user's call under the authorisation
they already have.
