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
 * A turn loop by SHAPE, spelled the way the shipped predicate recognises.
 *
 * It never mentions `DuyaAgent`, so a name-based detector would miss it and the
 * proof below would be a false negative that silently passed. The local
 * spelling (`openModelStream` / `runTools`) is deliberately NOT used: that case
 * is the recorded gap at the bottom of this file.
 */
const LOOP = [
  "import { modelPort } from './model-port.js';",
  "import { ToolExecutionPipeline } from './tools.js';",
  '',
  'export async function driveSession(request) {',
  '  const pipeline = new ToolExecutionPipeline();',
  '  let pending = request;',
  '  while (pending !== null) {',
  '    const stream = await modelPort.createTurnLegModelPort(pending);',
  '    pending = await pipeline.executeAll(stream);',
  '  }',
  '}',
  ''
].join('\n');

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
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tools.ts'), 'export class ToolExecutionPipeline { async executeAll() { return null; } }\n');
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
writeTree();
let findings = [];
try {
  findings = findWorkerLoopReach(REL_ENTRY);
  const hit = findings.find((f) => f.file === REL_LOOP);
  check(
    'a loop behind 3 adapters is reported',
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
} finally {
  removeTree();
}

// ---------------------------------------------------------------- direction 2
// The SAME gate, same call, with the chain gone. It MUST now report nothing.
// Without this, direction 1 could pass by the gate always returning findings.
const afterRemoval = findWorkerLoopReach(REL_ENTRY);
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
 * KNOWN GAP — measured, not assumed.
 *
 * A loop that is a cycle by every structural measure (it iterates, it opens a
 * model stream, it dispatches tools) but spells NONE of the names the current
 * `TURN_LOOP_SHAPE` recognises is NOT reported:
 *
 *     while (p !== null) { const s = await openModelStream(p); p = await runTools(s); }
 *
 * The reachability closure DOES contain such a module; it is `isTurnLoopModule`
 * that declines it. So the gate reports strictly LESS, which contradicts the
 * docstring above `TURN_LOOP_SHAPE` ("All three limits make the check report
 * MORE, never less"). Whoever widens the predicate should correct that sentence.
 *
 * The cost of widening was measured rather than guessed. Requiring all three
 * clauses over 2248 non-test source files:
 *
 *   | predicate                          | files selected |
 *   | ---------------------------------- | -------------- |
 *   | current                            | 5              |
 *   | widened (modelStream + toolExecution) | 6            |
 *
 * The single real file gained is `packages/agent/src/agent/session/agent-shell.ts`.
 * Six is still selective, so the gap is real and cheap to close -- but widening
 * a gate's semantics is the slice owner's decision, not something a proof script
 * should do silently. Hence: recorded here, not patched here.
 */
console.log(
  `\nKNOWN GAP (recorded, not patched): a turn loop spelled openModelStream/runTools is not reported.\n` +
    `  clause modelStream/toolExecution match names, not the responsibility.\n` +
    `  measured cost of widening: selectivity 5 -> 6 real files (gains agent-shell.ts).`
);

process.exit(failed === 0 ? 0 : 1);
