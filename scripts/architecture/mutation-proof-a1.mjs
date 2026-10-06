/**
 * A1 mutation proof — an executable check, not a claim in a docstring.
 *
 * 610 §4 rule 2: "每条门禁必须做变异证明:制造它要防的那种回归 → 确认变红 →
 * 完全回退 → 确认树干净。没做变异证明的门禁不算存在。"
 *
 * The regression G7 exists to catch is: the worker entry reaches the turn loop
 * INDIRECTLY, through one or more adapter modules, so a gate that only inspects
 * the entry's own imports sees nothing. The shipped fixtures cover ONE adapter
 * hop. This proof covers THREE hops.
 *
 * It proves two things a green G7 cannot:
 *   1. DIRECTIONALITY — a loop reachable through 3 adapters IS reported, and
 *      the finding names the hop the bypass arrived through.
 *   2. NEGATIVE    — remove the chain and the same gate reports nothing, so
 *      the positive result is not the gate always saying yes.
 *
 * Run:  node scripts/architecture/mutation-proof-a1.mjs
 * Exit: 0 = both directions behaved. Non-zero = the gate is not trustworthy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findWorkerLoopReach } from './boundary-gates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The fixture must live INSIDE a scanned package root. `findWorkerLoopReach`
// defaults its roots to `packageRoots()`, which is built from
// `packages/<dir>/src` (boundary-gates.mjs:118-133). A fixture parked under
// `fixtures/` is outside every root, so the reachability closure is EMPTY from
// the start and the gate reports "nothing found" no matter what the fixture
// contains.
//
// That is the `ok = 0, bad = 0` shape: a green-looking result that checked
// nothing. The first run of this proof failed for exactly that reason, which is
// why the negative direction below is mandatory: it distinguishes "the gate
// found nothing" from "the gate was never able to look".
const FIXTURE_DIR = path.join(REPO_ROOT, 'packages', 'agent', 'src', '__mutation_proof_a1__');

/**
 * A turn loop by SHAPE: one loop body that drives BOTH legs as consumed
 * streams — the model request and the tool-result backfill.
 *
 * It never mentions `DuyaAgent`, so a name-based detector would miss it and the
 * proof below would be a false negative that silently passed. The two
 * `for await` headers are the entire detection surface; see the docstring above
 * `TURN_LOOP_SHAPE` in `boundary-gates.mjs` for why the predicate is forbidden
 * from naming anything, and `RENAME_MAP` below for the proof that it obeys.
 */
const LOOP = [
  "import { modelPort } from './model-port.js';",
  "import { ToolExecutionPipeline } from './tools.js';",
  '',
  'export async function* driveSession(request) {',
  '  const pipeline = new ToolExecutionPipeline();',
  '  let pending = request;',
  '  while (pending !== null) {',
  '    for await (const event of modelPort.createTurnLegModelPort(pending)) {',
  '      yield event;',
  '    }',
  '    for await (const result of pipeline.drain()) {',
  '      pending = result;',
  '    }',
  '  }',
  '}',
  ''
].join('\n');

/**
 * Every identifier the fixture loop owns, mapped to a name that appears nowhere
 * in `TURN_LOOP_SHAPE`.
 *
 * This is the rename-resistance proof, and rename-resistance is a REQUIREMENT of
 * the predicate rather than a property that happened to hold. The previous
 * three-name-clause version failed exactly here: deleting `buildTurnModelLeg` /
 * `TurnModelLeg` / `ModelPort` from `DuyaAgent.ts` turned the gate green with
 * the cycle still in place. A predicate that renaming can silence is not a
 * boundary gate.
 */
const RENAME_MAP = {
  driveSession: 'alpha',
  pipeline: 'beta',
  pending: 'gamma',
  event: 'delta',
  result: 'epsilon',
  request: 'zeta',
  streamGenerator: 'eta',
  createTurnLegModelPort: 'theta',
  drain: 'iota',
  ToolExecutionPipeline: 'kappa',
  modelPort: 'lambda',
};

const renameAll = (src) => {
  let out = src;
  for (const [from, to] of Object.entries(RENAME_MAP)) out = out.split(from).join(to);
  return out;
};

const RENAMED_LOOP = renameAll(LOOP);

const ADAPTERS = [
  ['hop-1.ts', "export { driveSession } from './hop-2.js';"],
  ['hop-2.ts', "export { driveSession } from './hop-3.js';"],
  ['hop-3.ts', "export { driveSession } from './session-runner.js';"]
];

const ENTRY = [
  "import { driveSession } from './hop-1.js';",
  '',
  'export const worker = () => driveSession();',
  ''
].join('\n');

const REL_ENTRY = 'packages/agent/src/__mutation_proof_a1__/entry.ts';
const REL_LOOP = 'packages/agent/src/__mutation_proof_a1__/session-runner.ts';

function writeTree() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'entry.ts'), ENTRY);
  fs.writeFileSync(path.join(FIXTURE_DIR, 'session-runner.ts'), LOOP);
  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'model-port.ts'),
    'export const modelPort = { createTurnLegModelPort: async (r) => r };\n'
  );
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tools.ts'), 'export class ToolExecutionPipeline { async drain() { return null; } }\n');
  for (const [name, body] of ADAPTERS) {
    fs.writeFileSync(path.join(FIXTURE_DIR, name), body + '\n');
  }
}

function removeTree() {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail });
}

// ---------------------------------------------------------------- direction 1
// The loop IS reachable through three adapters. The gate MUST report it.
//
// The depth argument is explicit rather than left at the default. G7's default
// bound is 1 hop (a loop the entry reaches DIRECTLY), because the worker entry
// is the process root and an unbounded reachability predicate can never go
// green — plan 610 §5.2 rule 1. This proof deliberately asks about the full
// chain, which is the property the bound does NOT give up: when a caller raises
// the bound, the gate still resolves a multi-hop chain and still names the hop.
// Leaving the default here would silently turn this proof into an assertion
// that the gate reports nothing, which is the failure mode §4 rule 2 exists to
// prevent.
//
// The number is the MEASURED hop count of the fixture above, not a guess:
// entry -> hop-1 -> hop-2 -> hop-3 -> session-runner is four edges. Setting it
// lower is exactly how this proof goes quietly vacuous: the gate reports
// nothing, and "nothing" satisfies a `Boolean(hit)` check only if the caller
// forgets to look at the count. The negative direction below is what catches
// that, which is why both directions must run.
const PROOF_DEPTH = 4;
writeTree();
let findings = [];
try {
  findings = findWorkerLoopReach(REL_ENTRY, undefined, PROOF_DEPTH);
  const hit = findings.find((f) => f.file === REL_LOOP);
  check(
    `a loop behind 3 adapters is reported (depth ${PROOF_DEPTH})`,
    Boolean(hit),
    hit ? `reported via ${hit.via}` : `findings = ${JSON.stringify(findings.map((f) => f.file))}`
  );
  check(
    'the finding names the hop the bypass arrived through',
    // The gate reports the LAST hop before the loop (hop-3), not the first
    // (hop-1). That is the more useful half to report: hop-3 is the edge whose
    // removal actually severs the bypass, and `reachabilityFrom` is a BFS so
    // "nearest to the loop" is what falls out of it for free. The first run of
    // this proof asserted hop-1 and failed — the assertion was wrong, not the
    // gate, and the fix belongs here rather than in the gate.
    hit?.via === 'packages/agent/src/__mutation_proof_a1__/hop-3.ts',
    `via = ${hit?.via}`
  );
  check(
    'the loop is found without any DuyaAgent mention in it',
    !LOOP.includes('DuyaAgent') && Boolean(hit),
    'shape-based, not name-based'
  );
  // ---------------------------------------------------------------- direction 1b
  // RENAME RESISTANCE — the direction the previous predicate failed.
  //
  // The same loop, the same three adapters, the same gate, with EVERY identifier
  // the loop owns replaced by a name the predicate has never seen. The gate must
  // still report it. If this check fails, the gate has gone back to matching
  // spellings, and the fix is to the predicate rather than to this map.
  fs.writeFileSync(path.join(FIXTURE_DIR, 'session-runner.ts'), RENAMED_LOOP);
  const renamed = findWorkerLoopReach(REL_ENTRY, undefined, PROOF_DEPTH);
  const renamedHit = renamed.find((f) => f.file === REL_LOOP);
  check(
    'renaming every identifier in the loop does not change the verdict',
    Boolean(renamedHit),
    renamedHit
      ? `still reported; ${Object.keys(RENAME_MAP).length} identifiers renamed`
      : `findings = ${JSON.stringify(renamed.map((f) => f.file))}`
  );
  // The renamed fixture must be genuinely renamed, or the check above is
  // asserting nothing. `for await` is the only syntax that must survive.
  check(
    'the renamed fixture really is renamed (only `for await` survives)',
    !RENAMED_LOOP.includes('driveSession') &&
      !RENAMED_LOOP.includes('ToolExecutionPipeline') &&
      RENAMED_LOOP.includes('for await'),
    'control: the rename map covered the identifiers it claims to'
  );
} finally {
  removeTree();
}

// ---------------------------------------------------------------- direction 2
// The SAME gate, same call, with the chain gone. It MUST now report nothing.
// Without this, direction 1 could pass by the gate always returning findings.
const afterRemoval = findWorkerLoopReach(REL_ENTRY, undefined, PROOF_DEPTH);
check(
  'the same gate reports nothing once the chain is removed',
  afterRemoval.length === 0,
  `findings = ${JSON.stringify(afterRemoval.map((f) => f.file))}`
);

// ------------------------------------------------------------------- tree clean
check('fixture tree removed', !fs.existsSync(FIXTURE_DIR), FIXTURE_DIR);

// ---------------------------------------------------------------------- report
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok ? '' : `  <- ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} mutation-proof checks passed`);

/**
 * KNOWN GAP — re-measured after the 2026-10-06 predicate change, because the
 * gap recorded here used to be a contradiction in the gate's own docstring.
 *
 * The gap WAS: a loop that is a cycle by every structural measure but spells
 * none of the names `TURN_LOOP_SHAPE` recognised was not reported, which
 * contradicted the claim that the check reports "MORE, never less". That claim
 * was false, and it was false because two of the three clauses were names.
 *
 * The gap NOW: a turn loop that drives its two legs as plain `await`ed calls
 * rather than as consumed streams (`for await (... of ...)`) is not reported.
 * This is a narrowing that was chosen, not a name-matching defect: the
 * predicate is now free of identifiers, so the old counter-example
 * (`openModelStream` / `runTools`) IS reported, and the cost of the predicate
 * is paid in the other direction.
 *
 * The cost was measured rather than guessed, over 2250 non-test source files:
 *
 *   | predicate                                            | files selected |
 *   | ---------------------------------------------------- | -------------- |
 *   | previous three name clauses                          | 5              |
 *   | two driven streams in one loop body (shipped)       | 1              |
 *   | one driven stream + any other awaited call          | 4              |
 *
 * The extra three files the last row buys are `SessionSearchTool.ts`,
 * `packages/ai/src/utils/retry.ts` and `apps/desktop/src/main/services/backup.ts`
 * — a tool, a retry helper and a backup scan. Widening to them is a deliberate
 * decision with a measured price, and is recorded here rather than taken.
 */
console.log(
  `\nKNOWN GAP (recorded, not patched): a turn loop whose two legs are plain awaited calls,\n` +
    `  not consumed streams, is not reported. The shipped predicate selects 1 of 2250 files;\n` +
    `  accepting one stream plus any other awaited call would select 4.`
);

process.exit(failed === 0 ? 0 : 1);
