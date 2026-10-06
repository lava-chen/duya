#!/usr/bin/env node
/**
 * CLI entry for the plan 600 boundary gates. Self-contained: no `tsx`, no
 * vitest, no new dependency.
 *
 * ## Why a second file instead of running the .ts directly
 *
 * `tsx` is not a dependency of this repository, so `npm run` cannot execute a
 * TypeScript file. Rather than add a devDependency to run one script, the
 * detector logic lives in plain ESM JavaScript (`boundary-gates.mjs`) and the
 * TypeScript file is only the typed re-export used by the unit tests.
 *
 * The duplication is deliberate and narrow: the LOGIC is written once, in the
 * `.mjs`. `boundary-gates.ts` imports that module and adds type annotations,
 * so there is no second implementation to drift.
 *
 * Run:  node scripts/architecture/boundary-gates.mjs [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './strip-comments.mjs';
import { importsOf } from './import-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'bundle') continue;
      walk(abs, out);
    } else if (SRC_EXTS.has(path.extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

export function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const readSource = (abs) => fs.readFileSync(abs, 'utf8');
/** Comment-stripped source; `stripComments` preserves byte offsets. */
const code = (abs) => stripComments(readSource(abs)).text;

function importSpecifiers(abs) {
  const out = [];
  const src = code(abs);
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]);
  return out;
}

// ── layers ──────────────────────────────────────────────────────────────────

export const LAYERS = [
  { name: 'protocol', packages: ['@duya/agent-protocol'] },
  { name: 'core', packages: ['@duya/agent-core', '@duya/ai'] },
  {
    name: 'runtime',
    packages: ['@duya/agent-runtime', '@duya/agent', '@duya/capabilities', '@duya/connectors', '@duya/memory'],
  },
  { name: 'host', packages: ['@duya/desktop', '@duya/cli', '@duya/gateway'] },
];

/**
 * Export-path overrides, matched longest-prefix first. `@duya/cli/contract` is a
 * pure descriptor contract the agent legitimately depends on, while the bare
 * `@duya/cli` is a host adapter (HTTP to 127.0.0.1 plus node:fs). Classifying
 * the package as a whole made the gate report a correct edge as a violation.
 *
 * The `@duya/ai` pair is the SPLIT THAT DOES NOT EXIST YET, declared so the
 * gate is already correct on the day S5 cuts it. `00-contracts.md` §A.3
 * requires a mixed package to be split into a pure core export and an adapter
 * export, and forbids making a `fetch`-capable package core-reachable by
 * relabelling it. Today `packages/ai/package.json` publishes ONE export path
 * (`.`) whose barrel re-exports both the pure transforms and the `fetch`
 * clients, so there is no sub-path to classify and the whole package has to be
 * treated as core — a lie of convenience. Declaring `/core` and `/adapter`
 * changes no verdict today (nothing imports either) and makes the split the
 * intended target rather than an accident. G9 is what actually enforces it: it
 * measures whether a `core`-classified package can REACH IO, which a sub-path
 * declaration alone would only assert.
 */
export const SUBPATH_LAYERS = new Map([
  ['@duya/cli/contract', 'runtime'],
  ['@duya/ai/core', 'core'],
  ['@duya/ai/adapter', 'runtime'],
]);

const layerOf = (pkg) => LAYERS.find((l) => l.packages.includes(pkg))?.name;

export function layerOfSpecifier(spec) {
  let best;
  for (const [prefix, layer] of SUBPATH_LAYERS) {
    if (spec === prefix || spec.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, layer };
    }
  }
  if (best) return best.layer;
  const owner = LAYERS.flatMap((l) => l.packages)
    .filter((name) => spec === name || spec.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  return owner ? layerOf(owner) : undefined;
}

function packageRoots() {
  const root = path.join(REPO_ROOT, 'packages');
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgJson = path.join(root, dir.name, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      if (parsed.name) map.set(parsed.name, path.join(root, dir.name, 'src'));
    } catch {
      // A malformed package.json is a different gate's problem.
    }
  }
  return map;
}

export function findReverseEdges(roots = packageRoots()) {
  const findings = [];
  for (const [pkg, srcDir] of roots) {
    const fromLayer = layerOf(pkg);
    if (!fromLayer) continue;
    const fromIndex = LAYERS.findIndex((l) => l.name === fromLayer);
    for (const file of walk(srcDir)) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith('@duya/')) continue;
        const toLayer = layerOfSpecifier(spec);
        if (!toLayer) continue;
        if (LAYERS.findIndex((l) => l.name === toLayer) <= fromIndex) continue;
        findings.push({ file: rel(file), from: pkg, to: spec, fromLayer, toLayer });
      }
    }
  }
  return findings;
}

// ── G3 ──────────────────────────────────────────────────────────────────────

export const HOST_ONLY = [
  {
    re: /from\s+['"]electron['"]/,
    why: 'electron main',
    sample: "import { app } from 'electron';",
    clean: "import { app } from './app.js';",
  },
  {
    re: /from\s+['"][^'"]*\/renderer\//,
    why: 'renderer module',
    sample: "import { store } from '../renderer/store';",
    clean: "import { store } from './store.js';",
  },
  {
    re: /from\s+['"][^'"]*apps\/desktop\/src\/main\/(?:db|logging|ipc)\//,
    why: 'Desktop main internals',
    sample: "import { open } from 'apps/desktop/src/main/db/core/database';",
    clean: "import { open } from '@duya/agent-protocol';",
  },
];

export function findRuntimeHostLeaks(pkg = '@duya/agent-runtime') {
  const srcDir = packageRoots().get(pkg);
  if (!srcDir) return [];
  const findings = [];
  for (const file of walk(srcDir)) {
    const src = code(file);
    for (const rule of HOST_ONLY) {
      if (rule.re.test(src)) findings.push({ file: rel(file), why: rule.why });
    }
  }
  return findings;
}

// ── G4 ──────────────────────────────────────────────────────────────────────

export const WORKER_ENTRY = 'packages/agent/src/process/agent-process-entry.ts';

const BYPASS_SYMBOLS = [
  { symbol: 'DuyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
  { symbol: 'duyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
];

export function findWorkerSeamBypasses(entryRel = WORKER_ENTRY) {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return [];
  const findings = [];
  code(abs)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const { symbol, why } of BYPASS_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(line) && /import|new\s+/.test(line)) {
          findings.push({ file: entryRel, line: i + 1, symbol, why });
        }
      }
    });
  return findings;
}

export function workerImplementsExecutionChannel(entryRel = WORKER_ENTRY) {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return false;
  const src = code(abs);
  return /implements\s+ExecutionChannel|:?\s*ExecutionChannel\s*=/.test(src);
}

// ── the turn loop, located by SHAPE rather than by name ─────────────────────

/**
 * ## Why "reachability" instead of "does the entry say `DuyaAgent`"
 *
 * The name check is necessary and nowhere near sufficient. Plan 600
 * `04-runtime-owns-execution.md` §2 names the bypass exactly: wrap
 * `DuyaAgent.streamChat` in an adapter, call the adapter, and the name check
 * goes green while the loop is still the old one in the old package. An
 * adapter cannot avoid IMPORTING the module it wraps, so reachability is the
 * property that actually holds the boundary.
 *
 * ## Where "the loop implementation" is, precisely
 *
 * `00-contracts.md` §A and `04` §2 define the loop by responsibility, not by
 * file name: a cycle of model request, tool execution, result backfill, and
 * next turn. So it is detected by SHAPE — a module that (a) iterates, (b) opens
 * a model stream, and (c) dispatches tools, because a cycle is exactly those
 * three things.
 *
 * ### Clause (b) had drifted to a spelling, not the responsibility (2026-10-05)
 *
 * It used to be `/\.streamChat\s*\(/` alone, and the docstring above it claimed
 * the predicate selected "the real loop, the worker entry, and one integration
 * test". Re-measured on this tree it selected **only the worker entry**:
 * slice S2 moved the model request behind the `model-leg` seam
 * (`buildTurnModelLeg` / `createTurnLegModelPort`), so `DuyaAgent.ts` no longer
 * contains a literal `.streamChat(` call, while `agent-process-entry.ts` still
 * does. A gate that fires on the entry and not on the loop is worse than no
 * gate: it points the next slice at the wrong file.
 *
 * So (b) now also accepts the *seam* that opens the turn's model stream, not
 * only a direct call. Selectivity was measured rather than assumed — over the
 * 2194 non-test source files under `packages/`, `apps/desktop/src`, `electron/`
 * and `scripts/`, requiring all three clauses together:
 *
 *   | (b) variant                | files matched |
 *   | -------------------------- | ------------- |
 *   | `streamChat(` only (old)   | 1 — the entry, NOT the loop |
 *   | `+ model-leg seam`         | 3 — the loop, the entry, `agent-runtime/src/engine/ports.ts` |
 *   | `+ llmClient / AIClient`   | 5 — starts matching unrelated files |
 *
 * `agent-runtime/src/engine/ports.ts` is the known over-read: it DECLARES the
 * loop's ports, so it carries (a) and (c) and names the seam. It is reported
 * rather than hidden, because the same "report more, never less" rule that
 * governs the limits below applies to an ambiguous shape.
 *
 * The selectivity is the evidence the predicate has teeth; a variant matching
 * hundreds of files would be a grep with extra steps.
 *
 * ## What replaced the three name clauses, and why (2026-10-06)
 *
 * The three clauses were `repetition` AND `modelStream` AND `toolExecution`,
 * matched per MODULE over comment-stripped source. Two of the three are NAME
 * clauses, and a conjunction of name clauses is satisfiable by DELETION. This
 * repo has already shipped that fake green once, recorded at
 * `packages/agent-runtime/src/engine/ports.ts:12-15`:
 *
 *     headless-run-host.ts:22-28 "wires a real `RunController` around an
 *     executor that still calls `duyaAgent.streamChat`, and that combination
 *     passes the old acceptance gate while the loop has not moved at all."
 *
 * Measured on this tree, immediately before this change, against
 * `packages/agent/src/agent/DuyaAgent.ts`: deleting ONLY the model-leg markers
 * (`buildTurnModelLeg` / `TurnModelLeg` / `ModelPort`) left `repetition` and
 * `toolExecution` true, flipped `modelStream` false, and turned
 * `isTurnLoopModule` false — with the whole cycle still in place. The other two
 * clauses are deletable the same way. A gate that
 * reports "clean" when the loop has not moved is worse than a gate that is
 * always red, because the next slice trusts it and stops looking.
 *
 * ## The replacement: ONE loop body driving BOTH legs
 *
 * The loop is defined by RESPONSIBILITY, and both responsibilities are visible
 * in the source as SYNTAX rather than as spelling. One loop body must drive at
 * least `TURN_LOOP_SHAPE.legs` async streams to exhaustion, i.e. contain that
 * many `for await (... of ...)` headers. The real cycle does exactly this, and
 * the two headers are the two legs.
 *
 * ⚠️ **THE LINE REFERENCES BELOW ARE MEASURED, NOT COPIED — and the previous
 * version of this comment was copied.** It named `DuyaAgent.ts:1825`, `:2464`
 * and `:2764`; all three were stale. `:1825` is a *comment line*
 * (`// The resolved modes + ctx are stored on this ...`), not a loop opener, and
 * the two leg headers sit elsewhere. That stale comment was read as a
 * measurement, propagated into the plan document, and then re-measured and
 * re-propagated by two further people before it was caught — which is why the
 * numbers below are stated as `turnLoopSites()` output rather than as citations,
 * and why the plan's own span figures were wrong twice.
 *
 * `turnLoopSites()` is the only authority on where the loop is. If you need a
 * line number, ask the gate; do not read it here.
 *
 * Both leg headers sit inside the single `while` body that
 * `while (!this.abortController.signal.aborted)` opens. Requiring them to
 * co-occur in one loop BODY, rather than anywhere in a
 * 5000-line module, is what makes the clauses inseparable: a module cannot
 * satisfy the predicate by putting a model call in one function and a tool
 * dispatch in a different one.
 *
 * ## Rename-resistance is a REQUIREMENT of this predicate, not an accident
 *
 * The property the next person must preserve: **renaming any identifier in the
 * loop must not change the verdict.** This predicate contains no identifier at
 * all — no `streamChat`, no `ToolExecutionPipeline`, no `getRemainingResults`,
 * no `DuyaAgent`. It reads only `for`, `await`, `{` and `}`. Both
 * `mutation-proof-a1.mjs` and `boundary-gates.test.ts` assert that directly, by
 * renaming every identifier in a fixture loop and requiring the gate to still
 * report it, so the property cannot rot into an accident unnoticed.
 *
 * The same property is what closes the deletion hole: there is no marker left to
 * remove. To make this predicate false you must delete an entire `for await`
 * stream consumption — that is deleting the behaviour the gate protects, not
 * editing a spelling.
 *
 * The line being drawn, stated so the next person does not have to guess it:
 * any conjunction can be falsified by deleting a conjunct, so the question is
 * never "can this be silenced" but "what has to be deleted to silence it". Here
 * the answer is a driven stream — measured by mutation, deleting the tool leg
 * turns both G7 and G8 green. That is accepted because it
 * deletes real work from the cycle. The hole this replaced was answered
 * differently: deleting `buildTurnModelLeg` / `TurnModelLeg` / `ModelPort`
 * silenced the old gate while the cycle ran exactly as before, because that
 * model leg was already dead code. Behaviour-preserving silence is the failure
 * mode; behaviour-destroying silence is an architectural change a reviewer can
 * see in the diff.
 *
 * ## Selectivity, measured rather than assumed
 *
 * Over the 2253 non-test source files under `packages/`, `apps/desktop/src`,
 * `electron/` and `scripts/`, requiring two driven streams in one loop body:
 *
 *   | predicate                                            | files matched |
 *   | ---------------------------------------------------- | ------------- |
 *   | three name clauses (previous)                        | 5             |
 *   | two driven streams in ONE loop body                  | 1             |
 *   | two driven streams, one CALL FRAME down (current)    | 2             |
 *
 * The count went from 1 to 2 and that is the intended movement, not a regression:
 * the added match is `packages/agent-runtime/src/engine/run-engine.ts`, the
 * runtime execution owner, which the inline-only rule could not see because its
 * two legs are private methods the loop body calls. Both matches are loop
 * implementations, so nothing was absorbed that is not a cycle.
 *
 * `packages/agent-runtime/src/engine/ports.ts` — the types-and-docs module the
 * clause docstring above recorded as a known over-read — has no loop body at
 * all under this scanner, so that over-read is gone rather than tolerated.
 *
 * ## What this still cannot see, stated rather than assumed
 *
 * A turn loop that drives its two legs as plain `await`ed calls instead of as
 * consumed streams is NOT reported. The threshold stays at the weakest value
 * that still means "both legs" on purpose: raising it to `forAwait >= 3` selects
 * the same files, so 2 carries no tuning risk, and no lower value has a
 * defensible meaning. The measured cost of the next step down — accepting one
 * driven stream plus any other awaited call — is 4 files (`DuyaAgent.ts`,
 * `SessionSearchTool.ts`, `packages/ai/src/utils/retry.ts`,
 * `apps/desktop/src/main/services/backup.ts`), i.e. a retry helper and a backup
 * scan. Whoever widens this must re-measure that column rather than assume it.
 *
 * Exactly ONE call frame is followed, and the limit is real: a loop body that
 * calls `a()` which calls `b()` which drives both streams is NOT reported,
 * because the legs are two frames down. A transitive call graph would close that
 * and is deliberately out of scope — it is a different analysis with a different
 * false-positive surface. A loop whose legs live in ANOTHER MODULE is likewise
 * not reported, which is the same limit stated along the import axis rather than
 * the call one.
 *
 * A COPY of the loop pasted into a new module matches the same shape and is
 * caught as a second owner by G8. A loop reached only through a dynamic
 * `import(variable)` is not resolved — `importsOf` reads static specifiers
 * only, the same documented limit `import-graph.mjs` carries.
 */
export const TURN_LOOP_SHAPE = {
  /**
   * How many `for await (... of ...)` streams ONE loop body must drive to
   * exhaustion before the module is taken to own a turn loop. Two is not a
   * tuned constant fitted to one file: it is the number of legs a turn cycle
   * has — the model request and the tool-result backfill.
   */
  legs: 2,
};

/** `for await`, allowing any whitespace run, which is all the grammar allows. */
const FOR_AWAIT = /\bfor\s+await\b/g;

/** Cheap necessary condition; short-circuits the tokeniser for most files. */
function countForAwait(src) {
  FOR_AWAIT.lastIndex = 0;
  let n = 0;
  while (FOR_AWAIT.exec(src) !== null) n++;
  return n;
}

/**
 * Tokenise JS/TS source just deeply enough to locate `for await` headers and the
 * block each one lives in.
 *
 * Strings, template literals (including `${}` nesting) and regex literals are
 * skipped as opaque. That is not tidiness: a `}` inside any of them would
 * unbalance the block scan and silently truncate the enclosing loop body, which
 * is precisely the under-reporting direction that makes a gate untrustworthy.
 * The regex-vs-division heuristic is the one `strip-comments.mjs` uses, for the
 * same reason and with the same error direction; keep the two in sync.
 */
function tokenize(src) {
  const DIVISION_PRECEDERS = new Set("(,=:[!}&|?{};+-*%~^<>\n".split(''));
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
  ]);
  const out = [];
  let i = 0;
  let lastSignificant = '\n';
  let lastWord = '';
  const note = (ch) => {
    lastSignificant = ch;
    lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : '';
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let k = i + 1;
      let interpolationDepth = 0;
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue; }
        // A `${` opens real code inside a template; its `}` must not be read as
        // the end of the literal, so the two are counted against each other.
        if (ch === '`' && src[k] === '$' && src[k + 1] === '{') { interpolationDepth++; k += 2; continue; }
        if (ch === '`' && src[k] === '}' && interpolationDepth > 0) { interpolationDepth--; k++; continue; }
        if (src[k] === ch && interpolationDepth === 0) break;
        k++;
      }
      const end = Math.min(k + 1, src.length);
      out.push({ kind: 'opaque', start: i, end });
      for (let j = i; j < end; j++) note(src[j]);
      i = end;
      continue;
    }
    if (ch === '/') {
      const canBeRegex = REGEX_KEYWORDS.has(lastWord) || DIVISION_PRECEDERS.has(lastSignificant);
      if (canBeRegex) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < src.length) {
          const c = src[k];
          if (c === '\\') { k += 2; continue; }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { closed = true; break; }
          k++;
        }
        if (closed) {
          out.push({ kind: 'opaque', start: i, end: k + 1 });
          for (let j = i; j <= k; j++) note(src[j]);
          i = k + 1;
          continue;
        }
      }
      out.push({ kind: 'op', value: ch, start: i, end: i + 1 });
      note(ch);
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let k = i;
      while (k < src.length && /[A-Za-z0-9_$]/.test(src[k])) k++;
      out.push({ kind: 'id', value: src.slice(i, k), start: i, end: k });
      lastWord = src.slice(i, k);
      lastSignificant = 'x';
      i = k;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let k = i;
      while (k < src.length && /[0-9a-zA-Z_.]/.test(src[k])) k++;
      out.push({ kind: 'num', value: src.slice(i, k), start: i, end: k });
      lastWord = '';
      lastSignificant = '0';
      i = k;
      continue;
    }
    out.push({ kind: 'op', value: ch, start: i, end: i + 1 });
    note(ch);
    i++;
  }
  return out;
}

const CLOSERS = { '{': '}', '(': ')', '[': ']' };
const OPENERS = { '}': '{', ')': '(', ']': '[' };

/** Index of the bracket closing the one at `openIdx`, or -1 when unbalanced. */
function matchBracket(tokens, openIdx) {
  const stack = [];
  for (let i = openIdx; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (CLOSERS[value]) stack.push(CLOSERS[value]);
    else if (OPENERS[value]) {
      if (stack.pop() !== value) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the `(` that opens the group closed at `closeIdx`, or -1.
 *
 * The backwards scan is its own function because the forward one cannot be run
 * from a closer: `matchBracket(tokens, closerIdx)` would treat the `)` as an
 * opener and match it against the next `(` in the file, which is how an earlier
 * draft of this scanner silently found no loops at all.
 */
function matchOpenBackwards(tokens, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const value = tokens[i].value;
    if (value === ')') depth++;
    else if (value === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 1-based line of a byte offset, so a finding can point at the loop. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** The `{ … }` block opening right after the parameter list that starts at `parenIdx`. */
function blockAfterParen(tokens, parenIdx) {
  if (parenIdx < 0 || !tokens[parenIdx] || tokens[parenIdx].value !== '(') return null;
  const close = matchBracket(tokens, parenIdx);
  if (close < 0) return null;
  return blockAfterClose(tokens, close);
}

/**
 * The block body whose parameter list closes at `closeIdx`.
 *
 * A TypeScript return-type annotation sits between the `)` and the `{` —
 * `async #drainOutcomes(…): Promise<void> {` — so the `)` alone does not locate
 * the body. The annotation is skipped rather than parsed: the scan stops at the
 * first `{` at the top level of the annotation, at `;` or `=`, or after a bounded
 * number of tokens, and an object-type literal inside the annotation is consumed
 * with its own braces so its `{` is not mistaken for the body.
 *
 * This is the one place the scanner reads TypeScript syntax rather than
 * JavaScript, and it is bounded on purpose: an exotic annotation this fails to
 * skip makes the scan UNDER-detect that method's legs, which is the direction
 * this file treats as dangerous, so the bound is stated rather than implied.
 */
function blockAfterClose(tokens, closeIdx) {
  let i = closeIdx + 1;
  if (tokens[i] && tokens[i].kind === 'op' && tokens[i].value === ':') {
    i++;
    for (let guard = 0; i < tokens.length && guard < 64; guard++) {
      const t = tokens[i];
      if (t.kind === 'op' && (t.value === ';' || t.value === '=' || t.value === '=>')) break;
      if (t.kind === 'op' && t.value === '{') {
        const inner = matchBracket(tokens, i);
        // `{ … } {` — the first pair is an object type, the second is the body.
        if (inner >= 0 && tokens[inner + 1] && tokens[inner + 1].kind === 'op' && tokens[inner + 1].value === '{') {
          i = inner + 1;
          continue;
        }
        break;
      }
      i++;
    }
  }
  const brace = tokens[i];
  if (!brace || brace.kind !== 'op' || brace.value !== '{') return null;
  const end = matchBracket(tokens, i);
  if (end < 0) return null;
  return { start: i, end };
}

/**
 * Words that sit immediately before a `(` and open a block, so the `(` … `)` … `{`
 * shape is a control-flow HEADER rather than a function definition.
 *
 * Without this, `if (…) {` would register a definition named `if` and a loop body
 * calling any `if (` would count as delegating a leg.
 */
const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'return',
  'typeof', 'new', 'delete', 'void', 'await', 'yield', 'throw', 'case',
]);

/**
 * Functions and methods DEFINED in this module, as `name -> [body token range]`.
 *
 * Same-module only, and that is the whole design constraint: the delegation the
 * predicate follows is a CALL into a function the reader can see in the same
 * file. A callee that lives in another module is deliberately NOT followed —
 * following it would turn this into a transitive call graph, which is a
 * different (and much larger) analysis with its own false-positive surface.
 *
 * Four declaration shapes are recognised, because that is what real turn-loop
 * decompositions use: a `function` declaration, a class or object method, a
 * `#private` method, and a function/arrow expression bound to a name. Each is
 * found from bracket structure and the `function` keyword — never from an
 * identifier the loop happens to use — so the rename-resistance requirement
 * above survives the widening.
 *
 * Returns `{ byName, all }`. `all` carries every definition regardless of name,
 * which is what lets a callee exclude the functions nested inside itself — see
 * `countForAwaitIn`.
 */
function localDefinitions(tokens) {
  const defs = new Map();
  const add = (name, block) => {
    if (!name || !block) return;
    if (CONTROL_KEYWORDS.has(name)) return;
    if (!defs.has(name)) defs.set(name, []);
    const seen = defs.get(name);
    // `function f(…) {}` is reachable from two of the shapes below, and a
    // name registered twice would have its legs counted twice.
    if (seen.some((b) => b.start === block.start && b.end === block.end)) return;
    seen.push(block);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // `function name(…) {` and `async function name(…) {`.
    if (t.kind === 'id' && t.value === 'function') {
      let j = i + 1;
      if (tokens[j] && tokens[j].kind === 'op' && tokens[j].value === '*') j++;
      const name = tokens[j] && tokens[j].kind === 'id' ? tokens[j].value : null;
      const paren = tokens[j + 1] && tokens[j + 1].value === '(' ? j + 1 : -1;
      add(name, blockAfterParen(tokens, paren));
      continue;
    }

    if (t.kind !== 'op' || t.value !== '(') continue;
    const close = matchBracket(tokens, i);
    if (close < 0) continue;

    // `name(…) {` — a class or object method; `this.#name(…) {` is the same
    // shape, and the tokeniser splits the `#` off as its own operator.
    const before = tokens[i - 1];
    if (before && before.kind === 'id') {
      add(before.value, blockAfterParen(tokens, i));
    } else if (
      before && before.kind === 'op' && before.value === '#' &&
      tokens[i - 2] && tokens[i - 2].kind === 'id'
    ) {
      add(tokens[i - 2].value, blockAfterParen(tokens, i));
    }

    // `const name = (…) => {`, `const name = async (…) => {`, and
    // `const name = (x) => {`. The parameter list closes at `close`, `=>` is
    // the two operators `=` `>` that follow it, and the block opens next. An
    // arrow returning a parenthesised object has no block body and is skipped.
    const eq = tokens[close + 1];
    const gt = tokens[close + 2];
    const brace = tokens[close + 3];
    if (!eq || eq.kind !== 'op' || eq.value !== '=') continue;
    if (!gt || gt.kind !== 'op' || gt.value !== '>') continue;
    if (!brace || brace.kind !== 'op' || brace.value !== '{') continue;
    // The bound name is before the parameter list, not inside it: `tokens[i]`
    // is the `(`, and `async` may sit between the name and the `(`.
    let back = i - 1;
    if (tokens[back] && tokens[back].kind === 'id' && tokens[back].value === 'async') back -= 1;
    if (!tokens[back] || tokens[back].kind !== 'op' || tokens[back].value !== '=') continue;
    const name = tokens[back - 1];
    if (!name || name.kind !== 'id') continue;
    const end = matchBracket(tokens, close + 3);
    if (end < 0) continue;
    add(name.value, { start: close + 3, end });
  }
  // `all` is every definition in the module regardless of name. It exists so a
  // callee can tell its OWN legs from the legs of a function declared inside
  // it; without it the range scan below would silently reach two frames.
  return { byName: defs, all: [...defs.values()].flat() };
}

/**
 * `for await` headers in a token range, skipping any range in `excluded`.
 *
 * With no `excluded` this counts the whole range including nested blocks,
 * which is what the INLINE loop-body count has always done and must keep doing:
 * a turn loop's own legs are nested stream pumps.
 */
function countForAwaitIn(tokens, start, end, excluded = []) {
  let legs = 0;
  for (let k = start; k < end; k++) {
    if (excluded.some((b) => k > b.start && k < b.end)) continue;
    const t = tokens[k];
    if (t.kind !== 'id' || t.value !== 'for') continue;
    const next = tokens[k + 1];
    if (next && next.kind === 'id' && next.value === 'await') legs++;
  }
  return legs;
}

/**
 * Names of same-module definitions CALLED from a token range.
 *
 * A call is recognised structurally: a callee identifier immediately followed
 * by `(`, and not preceded by a `.`/`#` that is not `this`. That admits the
 * three spellings a loop body actually uses — `name(…)`, `this.name(…)` and
 * `this.#name(…)` — while refusing `other.name(…)`, where the identifier names a
 * property on an object this scanner cannot see the body of.
 *
 * The `#` is its own operator to the tokeniser, so `this.#name(` reads as four
 * tokens and `this` sits three back, not two. That offset is the difference
 * between seeing the engine's two private legs and seeing none of them.
 */
function calledDefinitions(tokens, start, end, defs) {
  const called = new Set();
  for (let k = start; k < end; k++) {
    const t = tokens[k];
    if (t.kind !== 'id') continue;
    const next = tokens[k + 1];
    if (!next || next.kind !== 'op' || next.value !== '(') continue;
    if (!defs.has(t.value)) continue;
    const prev = tokens[k - 1];
    const prev2 = tokens[k - 2];
    const prev3 = tokens[k - 3];
    const isPrivateMember =
      prev && prev.kind === 'op' && prev.value === '#' &&
      prev2 && prev2.kind === 'op' && prev2.value === '.' &&
      prev3 && prev3.kind === 'id' && prev3.value === 'this';
    const isMember =
      prev && prev.kind === 'op' && prev.value === '.' &&
      prev2 && prev2.kind === 'id' && prev2.value === 'this';
    const chained = prev && (
      (prev.kind === 'op' && (prev.value === '.' || prev.value === '#' || prev.value === ')' || prev.value === ']')) ||
      (prev.kind === 'id' && !CONTROL_KEYWORDS.has(prev.value)) ||
      prev.kind === 'num' || prev.kind === 'opaque'
    );
    if (!isPrivateMember && !isMember && chained) continue;
    called.add(t.value);
  }
  return called;
}

/**
 * Every loop body in the module that drives at least `TURN_LOOP_SHAPE.legs`
 * async streams, as `{ line, legs }`.
 *
 * A block counts as a loop body when the token before its `{` is the `)` that
 * closes a `while (...)` or `for (...)` header. Testing the header's own keyword
 * rather than searching for `while`/`for` anywhere is what keeps a call named
 * `forEach` or a property access from opening a phantom body, and it is why
 * the rename-resistance property survives: the decision is made from bracket
 * structure and two keywords, never from an identifier's spelling.
 *
 * `for await` headers are counted anywhere inside the body, including nested
 * blocks, because a turn loop's legs are themselves nested stream pumps — that
 * is the shape the real cycle has; ask `turnLoopSites()` for where it is today.
 *
 * ## A leg one CALL FRAME down counts too, and that is the point (2026-10-06)
 *
 * The inline-only count made the predicate sensitive to DECOMPOSITION STYLE
 * rather than to RESPONSIBILITY, and it was measured doing so. On this tree
 * `isTurnLoopModule` was false for `packages/agent-runtime/src/engine/run-engine.ts`
 * — the runtime execution owner, whose turn cycle is the one the whole cutover
 * is moving towards. Its `for (let turn = 1; ; turn++)` body spans **286 lines
 * containing zero `for await`**: the two legs live one call frame down, in
 * `#streamModel` and `#drainOutcomes`, which the body calls. A module that
 * correctly delegates its cycle to well-named private methods was judged "not a
 * turn loop".
 *
 * The failure that makes this urgent rather than cosmetic: slice A3-2b6 deletes
 * the legacy `DuyaAgent` cycle, and both G7 and G8 would then go green — but only
 * because the predicate could not see the engine at all. That green is
 * structurally indistinguishable from "somebody deleted every turn cycle", and a
 * reader who trusted it would stop looking.
 *
 * So a leg counts when it is EITHER inline in the loop body OR inside a
 * definition in the SAME module that the body calls, and the count is the sum.
 * Exactly one call frame is followed, deliberately: a transitive call graph is a
 * larger analysis with a larger false-positive surface, and the deletion hole
 * this predicate exists to close is already closed by the one-frame rule (a loop
 * still has to drive two real streams to reach the threshold).
 *
 * The sum cannot double-count. A definition nested INSIDE the loop body is
 * already inside the inline range, so it is skipped as a delegate and only
 * counted once; a definition the body calls by name is outside the body, and each
 * such name contributes its own `for await` count once no matter how many times
 * it is called.
 *
 * ⚠️ **This rule reached TWO frames for one revision, and the docstring was the
 * only thing claiming otherwise.** The first implementation indexed every
 * definition in the module and, for each callee, counted `for await` across that
 * callee's whole block range. A block range textually CONTAINS any function
 * declared inside it, so a callee that called a leg-bearing helper dragged that
 * helper's leg into the total — depth two, while the comment above said depth
 * one. Caught on review, not by a test: the depth-2 test that shipped was built
 * with BOTH legs two frames down and nothing in between, so it returned 0 and
 * passed without ever touching the leak.
 *
 * The fixture that exposed it is the shape worth remembering — the intermediate
 * contributes a leg of its OWN:
 *
 *     async function outer() {
 *       for (let t = 0; t < 3; t++) { await middle(); }
 *     }
 *     async function middle() {
 *       async function inner() { for await (const a of s()) {} }
 *       await inner();                          // depth 2 — must NOT count
 *       for await (const b of s()) {}           // depth 1 — counts as 1
 *     }
 *
 * `middle` contributes exactly 1, so the module is not a turn loop. A callee now
 * contributes its OWN inline legs only: `countForAwaitIn` takes an `excluded`
 * list built from the definitions nested inside that callee. The live engine is
 * unaffected and was re-measured, not assumed — its loop body calls
 * `#streamModel` and `#drainOutcomes` DIRECTLY and each holds exactly one inline
 * `for await`, so one frame is sufficient and `run-engine.ts` still matches.
 */
export function turnLoopSites(src) {
  if (typeof src !== 'string' || src.length === 0) return [];
  if (countForAwait(src) < TURN_LOOP_SHAPE.legs) return [];
  const tokens = tokenize(src);
  const { byName: defs, all } = localDefinitions(tokens);
  const sites = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'op' || tokens[i].value !== '{') continue;
    const prev = tokens[i - 1];
    if (!prev || prev.kind !== 'op' || prev.value !== ')') continue;
    const headerOpen = matchOpenBackwards(tokens, i - 1);
    if (headerOpen < 0) continue;
    const keyword = tokens[headerOpen - 1];
    if (!keyword || keyword.kind !== 'id') continue;
    if (keyword.value !== 'while' && keyword.value !== 'for') continue;
    const bodyEnd = matchBracket(tokens, i);
    if (bodyEnd < 0) continue;
    // No exclusions here: the loop body's OWN legs may sit in nested blocks, and
    // that is the pre-existing inline behaviour this gate shipped with.
    let legs = countForAwaitIn(tokens, i, bodyEnd);
    if (legs < TURN_LOOP_SHAPE.legs && defs.size > 0) {
      for (const name of calledDefinitions(tokens, i, bodyEnd, defs)) {
        for (const block of defs.get(name)) {
          // Already inside the body's own range: counted by the inline pass.
          if (block.start >= i && block.end <= bodyEnd) continue;
          // A callee contributes its OWN inline legs only. Definitions declared
          // inside it are a SECOND frame, and counting them is what made this
          // reach two frames by accident — see the docstring above.
          const nested = all.filter(
            (b) => b.start > block.start && b.end < block.end,
          );
          legs += countForAwaitIn(tokens, block.start, block.end, nested);
        }
      }
    }
    if (legs >= TURN_LOOP_SHAPE.legs) {
      sites.push({ line: lineAt(src, tokens[i].start), legs });
    }
  }
  return sites;
}

/** Test trees are not the subject: a test may drive a loop legitimately. */
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(relFile) {
  return TEST_PATH.test(relFile);
}

/**
 * Does this module's CODE drive a turn cycle?
 *
 * The input is expected to be comment-stripped, and every caller here does
 * that. It matters for the same measured reason it always did, and the reason
 * still holds under the new predicate: `packages/agent-runtime/src/engine/ports.ts`
 * is a types-and-docs-only module (every import in it is `import type`) whose
 * clause hits were all prose. A caller that forgets to strip gets an answer
 * about documentation rather than about code.
 *
 * The verdict is `turnLoopSites(src).length > 0`, i.e. at least one loop body
 * drives `TURN_LOOP_SHAPE.legs` async streams. See the docstring above
 * `TURN_LOOP_SHAPE` for the measurement that replaced the three name clauses,
 * and in particular for the rename-resistance requirement this predicate is
 * required to keep: no identifier from the loop may appear in it, or deleting
 * a marker would make the gate green again with the cycle untouched.
 */
export function isTurnLoopModule(src) {
  return turnLoopSites(src).length > 0;
}

/**
 * Resolve an in-repo specifier to the repo-relative source file it names.
 *
 * `import-graph.mjs`'s `resolveTarget` maps `@duya/x` to `packages/x`, which is
 * the package ROOT; every source file actually lives under `packages/x/src`, so
 * a bare `@duya/ai` never resolved there. Reachability that silently fails to
 * resolve a package edge under-reports, which is the dangerous direction, so the
 * workspace half is resolved here instead.
 *
 * Returns null when nothing resolves — an unresolved specifier is a different
 * gate's finding, and treating it as "no edge" only ever adds reachability back.
 */
export function resolveRepoSpecifier(spec, fromRel, roots = packageRoots()) {
  const candidates = [];
  if (spec.startsWith('@duya/')) {
    const [, pkgDir, ...rest] = spec.split('/');
    const srcDir = [...roots.values()].find((dir) => path.basename(path.dirname(dir)) === pkgDir);
    if (!srcDir) return null;
    const base = path.join(srcDir, ...rest);
    candidates.push(base, base.replace(/\.js$/, ''));
  } else if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(path.join(REPO_ROOT, fromRel)), spec);
    candidates.push(base, base.replace(/\.js$/, ''));
  } else {
    return null;
  }
  const suffixes = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
  for (const base of candidates) {
    for (const suffix of suffixes) {
      const abs = `${base}${suffix}`;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel(abs);
      } catch {
        // An unreadable candidate is not an edge; the next one may still resolve.
      }
    }
  }
  return null;
}

/**
 * The value-import closure of `entryRel`, as `file -> the file that reached it`.
 *
 * Value edges only: `import type` is erased by the compiler and creates no
 * runtime coupling, so a type-only reference to the old loop is not a way to run
 * it. The parent map is what lets a finding name the SHORTCUT a real violation
 * arrived through, rather than just the module it landed in.
 */
export function reachabilityFrom(entryRel, roots = packageRoots()) {
  const parent = new Map([[entryRel, null]]);
  const queue = [entryRel];
  while (queue.length > 0) {
    const current = queue.shift();
    const abs = path.join(REPO_ROOT, current);
    if (!fs.existsSync(abs)) continue;
    for (const { spec, typeOnly } of importsOf(abs)) {
      if (typeOnly) continue;
      const to = resolveRepoSpecifier(spec, current, roots);
      if (!to || parent.has(to)) continue;
      parent.set(to, current);
      queue.push(to);
    }
  }
  return parent;
}

/**
 * G7 — the worker entry must not DIRECTLY own a turn-loop implementation.
 *
 * ## Why this is not plain reachability
 *
 * The first version of this gate reported every turn-loop-shaped module in the
 * entry's value-import closure. That predicate is not satisfiable, and the
 * measurement is the reason: the worker entry is the process root, so any
 * module the running worker loads by static value import is in its closure BY
 * DEFINITION. Three probes measured it, each injected and reverted:
 *
 *   - loop moved into `packages/agent/**` and value-imported  -> 1 -> 2 findings
 *   - loop moved into `agent-runtime/**` (the owner G8 names) -> 1 -> 2 findings,
 *     because `agent-runtime/src/index.ts` is already in the closure via
 *     `packages/agent/src/process/run-engine-model.ts`
 *   - the entry's direct `DuyaAgent` import removed (G4 fixed) -> still 2,
 *     because `MessageSessionTool.ts:7` value-imports the entry
 *
 * Relocating the loop therefore made the gate WORSE, and the only ways to make
 * a reachability predicate go green were a dynamic `import()` (which
 * `importsOf` cannot see, and which would be gaming the gate rather than
 * changing the architecture) or moving the loop into another process.
 *
 * ## What is actually checkable here
 *
 * The regression this gate exists to catch is the one plan 600 S1a described:
 * the worker entry CONSTRUCTS the loop itself instead of driving the
 * `ExecutionChannel` the runtime owns. That is a statement about the entry and
 * its immediate collaborators, not about the whole graph. So the predicate is
 * now bounded by depth:
 *
 *   - depth 0 (the entry itself) and depth 1 (a module the entry imports
 *     directly) are checked. A loop there is a bypass.
 *   - beyond depth 1 the module is loaded BY the loop's own caller chain, which
 *     is normal and expected: the loop calls tools, tools call back into the
 *     entry, and every real turn goes through that graph.
 *
 * G8 already carries the ownership half (a loop outside `@duya/agent-runtime`
 * is reported per package), so bounded G7 + G8 together still account for both
 * ways the loop can be in the wrong place, and each can actually go green.
 *
 * ## Depth 0 is INCLUDED, and that is a decision rather than a skip
 *
 * This scan used to open with `if (file === entryRel) continue`. The entry was
 * therefore never G7's subject, and the exclusion was silent: nothing recorded
 * why the process root — the one module whose job is to drive the loop — was
 * exempt from the gate about driving the loop.
 *
 * It is now included, on two measured grounds.
 *
 *  1. Including it costs nothing today. The entry's 33 loops contain zero
 *     driven streams, so `turnLoopSites` finds no site in
 *     `agent-process-entry.ts` and the finding set is unchanged. The entry
 *     CALLS the loop (`agent-process-entry.ts:3047`, `agent.streamChat(...)`);
 *     calling a loop is not owning one, and the new predicate says so instead
 *     of the old one, which matched the entry only because it is a 5292-line
 *     file that happens to mention the right words.
 *  2. The exclusion was a hole shaped exactly like the one this slice closed.
 *     Had the entry grown its own turn cycle — the regression G7 exists to
 *     catch, in its most direct possible form — the `continue` would have
 *     hidden it. A gate that skips the module most able to violate it is not a
 *     narrower gate, it is a gate with a marked exemption nobody wrote down.
 *
 * So the entry is now a subject like any other, and the honest report is that
 * it produces no finding: the bypass this gate reports on the live tree is the
 * entry's direct value import of the loop module
 * (`agent-process-entry.ts:76`), which G4 already records in the baseline and
 * which G7 reports at depth 1.
 *
 * ## Modules inside the SANCTIONED EXECUTION OWNER are excluded (2026-10-06)
 *
 * A module whose path is inside `EXECUTION_OWNER_PACKAGE` is not a G7 subject.
 * The reason is a cutover, and it is written down here rather than left as a
 * silent `continue` — a silent skip is exactly the defect PR #249 and #232 fixed
 * twice in this same file, and a skip whose reason lives only in the diff is a
 * skip the next reader cannot audit.
 *
 * **What A3-2b6 does.** It deletes the legacy `DuyaAgent` cycle so the runtime
 * engine becomes the single driver. After that lands the worker entry is
 * SUPPOSED to construct the engine and drive it — importing it at depth 1 and
 * calling into it is the intended end state, not the bypass this gate reports.
 * G8 owns the complementary half ("the cycle must live in the runtime execution
 * package") and already skips the owner package for exactly that reason
 * (`if (pkg === ownerPkg) continue` in `findLoopMisownership`). Without the
 * mirrored exclusion here, A3-2b6 would trade one false red for another: G7
 * would go red on the very import that is the point of the cutover.
 *
 * **What this is NOT.** It is not a mute. G7 still reports a loop in ANY other
 * package at depth 0 or 1, and the live red today is one of those
 * (`packages/agent/src/agent/DuyaAgent.ts`, reached at depth 1 from the entry).
 * The exclusion is scoped to a package path, not to "looks like an engine", so it
 * cannot absorb a loop that migrates back out of the owner — that is G8's
 * finding, and G8 does not consult this skip.
 *
 * **Measured, and the honest caveat.** On this tree the exclusion moves no
 * number: G7's depth-<=1 set holds 46 modules and **zero** of them are inside
 * `packages/agent-runtime/`, because the entry reaches the engine through
 * `run-engine-model.ts` -> `agent-runtime/src/index.ts`, deeper than the bound.
 * So the exclusion is a forward-looking guard for A3-2b6 rather than something
 * that fixed a live false positive. It was added in the same change that made
 * the engine DETECTABLE, which is the only moment adding it is cheap: had the
 * predicate widened first, A3-2b6 would have inherited a gate that could not
 * distinguish the intended import from the bypass it exists to report.
 */
export const WORKER_LOOP_MAX_DEPTH = 1;

/** True when `file` is a source file inside the execution owner package. */
function isInOwnerPackage(file, ownerPkg, roots) {
  const ownerSrc = srcRootOf(ownerPkg, roots);
  if (!ownerSrc) return false;
  const abs = path.resolve(REPO_ROOT, file);
  // The trailing separator matters: without it `packages/agent-runtime-legacy`
  // would count as inside `packages/agent-runtime`.
  return abs === ownerSrc || abs.startsWith(`${path.resolve(ownerSrc)}${path.sep}`);
}

export function findWorkerLoopReach(
  entryRel = WORKER_ENTRY,
  roots = packageRoots(),
  maxDepth = WORKER_LOOP_MAX_DEPTH,
  ownerPkg = EXECUTION_OWNER_PACKAGE,
) {
  const ifAbsent = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(ifAbsent)) return [];
  const depth = importDepthFrom(entryRel, roots, maxDepth);
  const findings = [];
  for (const [file, at] of depth) {
    if (isTestPath(file)) continue;
    if (isInOwnerPackage(file, ownerPkg, roots)) continue;
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const site = turnLoopSites(code(abs))[0];
    if (!site) continue;
    findings.push({
      file,
      from: entryRel,
      via: at.via,
      why: at.depth === 0
        ? `the worker entry IS the turn loop: it drives ${site.legs} async streams inside one loop body at line ${site.line}; the loop belongs to the runtime execution owner, reached through ExecutionChannel`
        : `the worker entry reaches a turn-loop implementation within ${at.depth} import hop(s); the loop belongs to the runtime execution owner, reached through ExecutionChannel`,
    });
  }
  return findings;
}

/**
 * Files within `maxDepth` VALUE-import hops of `entryRel`, as
 * `file -> { via, depth }`.
 *
 * Breadth-first so the first hop recorded is the shortest, which is the hop a
 * finding has to name for the next slice to know which edge to cut.
 */
function importDepthFrom(entryRel, roots, maxDepth) {
  const seen = new Map([[entryRel, { via: entryRel, depth: 0 }]]);
  let frontier = [entryRel];
  for (let d = 1; d <= maxDepth; d += 1) {
    const next = [];
    for (const current of frontier) {
      const abs = path.join(REPO_ROOT, current);
      if (!fs.existsSync(abs)) continue;
      for (const { spec, typeOnly } of importsOf(abs)) {
        if (typeOnly) continue;
        const target = resolveRepoSpecifier(spec, current, roots);
        if (!target || target === entryRel) continue;
        if (seen.has(target)) continue;
        seen.set(target, { via: current, depth: d });
        next.push(target);
      }
    }
    frontier = next;
  }
  return seen;
}


/**
 * The package that is supposed to OWN the loop once plan 600 S2 lands.
 *
 * `@duya/agent-runtime` is the choice because it already owns the port the
 * worker is supposed to implement (`ExecutionChannel`) and the controller that
 * mints `runId`, so it is the only package that can decide a turn without
 * knowing about Project or Session (`00-contracts.md` §A, §D).
 */
export const EXECUTION_OWNER_PACKAGE = '@duya/agent-runtime';

/** Repo-relative source root of a package name, or null. */
function srcRootOf(pkg, roots = packageRoots()) {
  return roots.get(pkg) ?? null;
}

/**
 * G8 — the loop implementation must be owned by the execution owner package.
 *
 * Reported per OWNING PACKAGE rather than per file, so migrating the loop is
 * one deliberate step that clears every file at once, and so the count says
 * "two packages still hold a loop" rather than "two files happen to match a
 * regex".
 */
export function findLoopMisownership(ownerPkg = EXECUTION_OWNER_PACKAGE, roots = packageRoots()) {
  const findings = [];
  for (const [pkg, srcDir] of roots) {
    if (pkg === ownerPkg) continue;
    const holders = [];
    for (const abs of walk(srcDir)) {
      const fileRel = rel(abs);
      if (isTestPath(fileRel)) continue;
      if (isTurnLoopModule(code(abs))) holders.push(fileRel);
    }
    if (holders.length > 0) {
      findings.push({
        file: rel(srcDir),
        table: pkg,
        to: `${EXECUTION_OWNER_PACKAGE} owns the turn loop; this package still holds one`,
        owners: holders.sort(),
      });
    }
  }
  return findings;
}

// ── G6, continued: lifecycle coupling the DDL does not prove ───────────────

/** Where the host keeps its durable stores; also the default G6 scan root. */
export const HOST_DB_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

/**
 * ## Why the DDL column test is not the question
 *
 * `session_id TEXT NOT NULL` says the COLUMN is mandatory. It does not say the
 * Run's lifecycle is independent of the Session's, and the plan's real claim
 * (`00-contracts.md` §C) is about lifecycle: a Session may be rebuilt, replaced
 * or archived without changing any durable entity. Three couplings break that
 * while the DDL stays exactly as it is, and all three are CODE facts:
 *
 *  1. `CreateRunInput.sessionId: string` — a Run cannot be STARTED without a
 *     Session, because the create input requires the key.
 *  2. `WHERE session_id = ?` over a durable table — the Run's identity is
 *     DERIVED from the Session, so it is only addressable through one.
 *  3. `DELETE FROM <durable table> ... session_id` — archiving a Session DROPS
 *     the Runs, so the durable entity dies with a projection.
 *
 * A fourth is in the DDL but is not a column test: `UNIQUE(session_id)` on
 * `session_goals` caps the table at one row per Session. Nulling the column
 * would not decouple it — a Run-rooted goal still could not exist without
 * consuming the session's slot.
 *
 * Every rule below matches on SQL / TypeScript structure, and every rule has a
 * negative case in `boundary-gates.test.ts` that builds the violation it
 * forbids rather than breaking the detector.
 */
/**
 * Each coupling declares what it is allowed to match, because "a statement
 * scoped by session_id" is only a DURABLE-IDENTITY coupling when the statement
 * names a durable identity table.
 *
 * `session_runtime_locks` is the worked example: it is deleted by session_id
 * all over `stores.ts`, and it is a transient lock — a row that expires and is
 * meant to be swept. Reporting it against G6 would send S1 to migrate a table
 * that has no durable identity at all. `scope: 'statement-table'` restricts the
 * rule to statements naming one of the file's durable tables; `scope: 'file'`
 * is for shapes that are not inside a SQL statement (a TypeScript field), where
 * file scope is the tightest bound available.
 */
export const LIFECYCLE_COUPLINGS = [
  {
    id: 'required-session-key',
    scope: 'file',
    // A non-optional `sessionId: string` / `session_id: string` field: the
    // store's own type contract demands the key, so the row cannot be created
    // without one. The trailing `;` is what makes `sessionId?: string` fail to
    // match, which is the whole difference between the two states, and `m` is
    // what makes `^` mean "start of a line" rather than "start of the file" —
    // without it the rule silently finds nothing past line one, which is the
    // vacuous shape: a gate that reports zero and is believed.
    re: /^[ \t]*(?:readonly[ \t]+)?session_?[iI]d[ \t]*:[ \t]*string[ \t]*;/gm,
    why: 'the durable store requires a session key, so the entity cannot exist without a Session',
  },
  {
    id: 'session-keyed-read',
    scope: 'statement-table',
    // A statement over a durable table whose predicate is the session column:
    // the entity is only addressable through the Session that owns it.
    re: /\b(?:SELECT|UPDATE)[^;]{0,400}?\bFROM\s+\w+[^;]{0,400}?\bWHERE[^;]{0,200}?\bsession_id\b\s*(?:=|\bIN\b|\bLIKE\b)/gis,
    why: 'the durable entity is read through its session, so its identity is derived from a Session',
  },
  {
    id: 'session-scoped-delete',
    scope: 'statement-table',
    // Deleting durable rows scoped by the session column: the classic cascade
    // the DDL cannot express.
    re: /\bDELETE\s+FROM\s+\w+[^;]{0,400}?\bsession_id\b/gis,
    why: 'deleting the durable entity is scoped to a session, so a Session cleanup can drop it',
  },
  {
    id: 'session-unique-constraint',
    scope: 'statement-table',
    // One row per session. Nulling the column does not decouple this.
    re: /\bUNIQUE\s*\(\s*session_id\s*\)/gi,
    why: 'one durable row per Session caps the table, so the entity cannot exist without consuming the Session slot',
  },
];

const TABLE_SQL = /\b(?:FROM|INTO|UPDATE|TABLE\s+IF\s+NOT\s+EXISTS|TABLE)\s+[`"']?(\w+)[`"']?/gi;

/**
 * The durable-identity tables a lifecycle rule applies to, resolved from the
 * DDL rather than assumed — a coupling only matters if the table is durable.
 */
function durableTablesIn(raw) {
  const found = new Set();
  for (const match of raw.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"']?(\w+)[`"']?/gi)) {
    found.add(match[1]);
  }
  return found;
}

/**
 * The SQL or type statement a match sits in.
 *
 * Bounded by the nearest statement delimiter on each side, because a ±400
 * character window spans several statements and attributes a coupling to
 * whichever durable table happens to come first: `UNIQUE(session_id)` on
 * `session_goals` would be filed under `tasks` purely because `tasks` was
 * declared earlier in the file. A finding that names the wrong table sends the
 * next slice to the wrong migration, so the attribution is either exact or null
 * — never a guess.
 */
function enclosingStatement(src, index) {
  const before = src.lastIndexOf(';', index);
  const after = src.indexOf(';', index);
  return src.slice(before < 0 ? 0 : before + 1, after < 0 ? src.length : after);
}

/** The durable table this statement names, or null when it names none. */
function tableOfStatement(statement, owned) {
  const named = [...statement.matchAll(TABLE_SQL)].map((m) => m[1]).filter((n) => owned.includes(n));
  return named[0] ?? null;
}

/**
 * G6 — lifecycle coupling, measured over the modules that own durable tables.
 *
 * Walks the same `apps/desktop/src/main` tree as the DDL rule and keeps only
 * files that actually declare one of `DURABLE_IDENTITY_TABLES`, so a coupling
 * found in an unrelated store is not reported against this gate.
 *
 * `dbDir` is a parameter so the negative cases can point the scan at a fixture
 * store. It defaults to the live tree, and the tests that assert a violation is
 * found always pass their own directory — a fixture scanned against the live
 * tree would prove nothing about the fixture.
 */
export function findLifecycleCouplings(tables = DURABLE_IDENTITY_TABLES, dbDir = HOST_DB_DIR) {
  const findings = [];
  for (const abs of walk(dbDir)) {
    const fileRel = rel(abs);
    if (isTestPath(fileRel)) continue;
    const raw = readSource(abs);
    const declared = durableTablesIn(raw);
    const owned = tables.filter((t) => declared.has(t));
    if (owned.length === 0) continue;
    // SQL lives inside template literals; string literals too, so both the raw
    // text and the comment-stripped text are searched — a coupling inside a
    // `db.prepare(\`...\`)` block must not be lost to a `//` inside it.
    const haystacks = [raw, code(abs)];
    for (const rule of LIFECYCLE_COUPLINGS) {
      for (const haystack of haystacks) {
        // Every match, not the first: `stores.ts` scopes two different durable
        // tables by session (`DELETE FROM tasks` and `DELETE FROM
        // session_goals`), and stopping at the first would report one coupling
        // where there are two.
        for (const match of haystack.matchAll(rule.re)) {
          const table = tableOfStatement(enclosingStatement(haystack, match.index), owned);
          // A `statement-table` rule that lands on a statement naming no
          // durable identity table is not this gate's business: the file owns a
          // durable table somewhere, but THIS statement is about something
          // else. Skipping keeps the gate from pointing S1 at a lock table.
          if (rule.scope === 'statement-table' && table === null) continue;
          findings.push({
            // `table` is the durable table this exact statement names, and is
            // null only for `scope: 'file'` rules — a TypeScript field
            // declaration is not inside a SQL statement at all. `scopedTo`
            // records the file's durable tables so a null stays readable.
            table,
            scopedTo: owned.join('+'),
            file: fileRel,
            coupling: rule.id,
            column: rule.why,
            database: databaseOfFile(fileRel),
          });
        }
        break;
      }
    }
  }
  // One finding per (file, coupling, table): the same coupling on two durable
  // tables in one file is two subjects, while the same coupling matched twice on
  // ONE table is one. The fingerprint carries no line number, so collapsing by
  // table is what keeps the two apart without reintroducing the line drift that
  // once produced false regressions.
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}|${f.coupling}|${f.table ?? f.scopedTo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── G9 — a `core` classification has to survive measurement ────────────────

/**
 * IO primitives, kept in step with `layer-purity.ts`'s `IO_PRIMITIVES`.
 *
 * Duplicated rather than imported because `layer-purity.ts` is TypeScript and
 * this gate must run under plain `node` (there is no `tsx` in this repo). The
 * duplication is deliberate and bounded: both lists encode the same published
 * definition, and the cross-check that matters is measured, not assumed — G9
 * and `layer-purity.ts`'s `CORE_MODULES` list independently name the SAME
 * `@duya/ai` files, by different routes (transitive reachability vs. a direct
 * scan), which is the evidence that the two have not drifted apart in a way
 * that hides IO.
 *
 * The list was FIVE files as of plan 610 A0, not six: A0 moved the Bedrock
 * SigV4 signer from `node:crypto` to `globalThis.crypto.subtle`, so
 * `packages/ai/src/api/bedrock-converse.ts` stopped reaching a Node built-in and
 * was retired from both this gate's test and `layer-purity.ts`'s carve-out
 * list. `layer-purity.ts`'s `findStaleCarveOuts` test fails if a record there
 * outlives its file, so the two lists cannot silently diverge on this.
 *
 * `this.fetchFn(` is deliberately NOT matched: an injected transport is the
 * point of the exercise, and `system-one/client.ts` is the working example.
 */
export const IO_PRIMITIVES = [
  { name: 'fetch', re: /(?<![\w.$])fetch\s*\(/ },
  { name: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch\s*\(/ },
  { name: 'node:http', re: /from\s+['"]node:https?['"]/ },
  { name: 'node:net', re: /from\s+['"]node:net['"]/ },
  { name: 'node:fs', re: /from\s+['"](?:node:)?fs(?:\/promises)?['"]/ },
  { name: 'node:fs/promises', re: /from\s+['"]node:fs\/promises['"]/ },
  { name: 'node:crypto', re: /from\s+['"]node:crypto['"]/ },
  { name: 'node:child_process', re: /from\s+['"]node:child_process['"]/ },
  { name: 'node:worker_threads', re: /from\s+['"]node:worker_threads['"]/ },
  { name: 'node:os', re: /from\s+['"]node:os['"]/ },
  { name: 'node:process', re: /from\s+['"]node:process['"]/ },
  { name: 'setTimeout/setInterval', re: /(?<![\w.$])(?:setTimeout|setInterval)\s*\(/ },
  { name: 'WebSocket', re: /(?<![\w.$])new\s+WebSocket\s*\(/ },
];

/** Which IO primitives (if any) this module's code actually calls. */
export function ioPrimitivesIn(src) {
  return IO_PRIMITIVES.filter((p) => p.re.test(src)).map((p) => p.name);
}

/**
 * G9 — a package classified `core` must not be able to REACH IO.
 *
 * `00-contracts.md` §A.3: a mixed package must be split into a pure core export
 * and an adapter export, and may not be made core-reachable by relabelling it.
 * A layer table cannot enforce that by itself
 * — the table only says which label a package wears — so this measures the
 * property the label is asserting: start at the package's public entry and walk
 * the value-import closure, and report any module in it that performs IO.
 *
 * This is what makes the `@duya/ai` classification falsifiable. G1's layer table
 * calls the package core; G9 asks whether that is true, and today it is not:
 * `@duya/ai`'s single barrel reaches six IO-performing modules. Until S5 splits
 * the package into a pure core export and an adapter export, those six are the
 * price of the convenient classification, recorded rather than hidden.
 */
export function findCoreIoReach(layer = 'core', roots = packageRoots()) {
  const findings = [];
  const pkgs = LAYERS.find((l) => l.name === layer)?.packages ?? [];
  for (const pkg of pkgs) {
    const srcDir = srcRootOf(pkg, roots);
    if (!srcDir) continue;
    const entry = rel(path.join(srcDir, 'index.ts'));
    const reachable = reachabilityFrom(entry, roots);
    for (const file of reachable.keys()) {
      if (isTestPath(file)) continue;
      const abs = path.join(REPO_ROOT, file);
      if (!fs.existsSync(abs)) continue;
      const primitives = ioPrimitivesIn(code(abs));
      if (primitives.length === 0) continue;
      findings.push({
        file,
        from: pkg,
        to: primitives.sort().join('+'),
        why: `${pkg} is classified ${layer} but its public entry reaches IO`,
      });
    }
  }
  return findings;
}

// ── G6 ──────────────────────────────────────────────────────────────────────

export const DURABLE_IDENTITY_TABLES = ['runs', 'tasks', 'session_goals'];

/** `db/core/**` is duya-core.db; the rest of db/ is duya-main.db. */
export function databaseOfFile(relFile) {
  return relFile.includes('/db/core/') ? 'core.db' : 'main.db';
}

/** DDL that exists but has no reader or writer. */
export const DEAD_TABLE_DEFINITIONS = [
  { file: 'apps/desktop/src/main/db/schema.ts', table: 'tasks', database: 'main.db' },
];

export function findSessionRootedTables(tables = DURABLE_IDENTITY_TABLES, dir = HOST_DB_DIR) {
  const findings = [];
  const dbDir = dir;
  const isDead = (file, table) =>
    DEAD_TABLE_DEFINITIONS.some((d) => d.file === file && d.table === table);
  for (const file of walk(dbDir)) {
    const raw = readSource(file);
    for (const table of tables) {
      const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'g');
      let m;
      while ((m = create.exec(raw)) !== null) {
        const bodyStartLine = raw.slice(0, m.index).split(/\r?\n/).length;
        const fileRel = rel(file);
        const database = databaseOfFile(fileRel);
        m[1].split(/\r?\n/).forEach((row, i) => {
          if (/^\s*session_id\s+TEXT\s+NOT\s+NULL/i.test(row)) {
            findings.push({
              table,
              file: fileRel,
              line: bodyStartLine + i,
              column: 'session_id NOT NULL',
              database,
              live: !isDead(fileRel, table),
            });
          }
        });
      }
    }
  }
  return findings;
}

// ── report + baseline ───────────────────────────────────────────────────────

export function collectBoundaryReport() {
  return [
    { gate: 'G1', title: 'no reverse dependency edge between layers', findings: findReverseEdges() },
    { gate: 'G3', title: 'runtime does not reach into host internals', findings: findRuntimeHostLeaks() },
    {
      gate: 'G4',
      title: 'worker implements ExecutionChannel, not DuyaAgent',
      findings: findWorkerSeamBypasses(),
    },
    {
      gate: 'G6',
      title: 'durable identity is not rooted at session_id',
      // The DDL column rule and the lifecycle rules answer different questions
      // and are reported under one gate because they are one contract. A fix
      // that nulls `session_id` without touching the lifecycle leaves this gate
      // RED, which is the entire point: the column was never the claim.
      findings: [...findSessionRootedTables(), ...findLifecycleCouplings()],
    },
    {
      gate: 'G7',
      title: 'worker entry does not reach the turn-loop implementation',
      findings: findWorkerLoopReach(),
    },
    {
      gate: 'G8',
      title: 'the turn loop is owned by the runtime execution package',
      findings: findLoopMisownership(),
    },
    {
      gate: 'G9',
      title: 'a core-classified package cannot reach IO',
      findings: findCoreIoReach(),
    },
  ];
}

export const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'architecture', 'boundary-gates-baseline.json');

/**
 * Identity for one finding, used as the baseline key.
 *
 * ## The line number is deliberately NOT part of this
 *
 * An earlier version keyed on `gate|file|line|identity`, reasoning that a
 * moved violation is a rewritten table and S1 should look at it. Measured
 * against 134 upstream commits that reasoning was wrong: every one of those
 * commits shifted line numbers in files nobody had touched, and the gate
 * reported 3 regressions where the real change was 0. Every NEW had a
 * matching FIXED at the same file — pure drift, reported as breakage.
 *
 * A line number is not an identity. What identifies a violation is WHAT it
 * is and WHERE the subject is: which gate, which file, and which of the
 * few discriminating attributes (the imported symbol, the table, the column).
 * That is stable across reformatting and upstream churn, and it still
 * distinguishes the two findings in the same file that a message-only
 * comparison would merge.
 *
 * If a violation genuinely moves to a different file or changes its subject,
 * the key changes and the gate fails — which is the case worth failing on.
 *
 * The discriminator is the FIRST defined attribute, in the order below, because
 * each gate has a different notion of "the same subject twice in one place":
 * G4 spells one subject two ways (`DuyaAgent` and `duyaAgent`), G6 finds the
 * same table coupled in two different ways, G8 names one owning package per
 * file, and G9 names one package per reachable module. Each of those is
 * deliberately a DIFFERENT field from the middle column — a discriminator that
 * repeats it would append the same text twice and pad the key for nothing.
 */
export function fingerprint(report, finding) {
  const f = finding ?? {};
  const discriminator = f.symbol ?? f.coupling ?? f.database ?? f.table ?? f.from ?? '';
  return [report.gate, String(f.file ?? f.table ?? '?'), String(f.to ?? f.column ?? f.why ?? ''), discriminator]
    .filter(Boolean)
    .join('|');
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return new Set();
  const data = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return new Set(data.entries ?? []);
}

export function evaluate(reports = collectBoundaryReport(), override) {
  const baseline = override ?? readBaseline();
  const seen = new Set();
  const outcomes = reports.map((report) => {
    // Dedupe by key: two findings that resolve to the same key are one
    // subject, and counting them twice would report "known: 3" for a defect
    // that exists once.
    const keys = [...new Set(report.findings.map((f) => fingerprint(report, f)))];
    const known = [];
    const newFindings = [];
    for (const key of keys) {
      seen.add(key);
      (baseline.has(key) ? known : newFindings).push(key);
    }
    return { gate: report.gate, title: report.title, known: known.length, newFindings, stale: [] };
  });
  return outcomes.map((o) => ({
    ...o,
    stale: [...baseline].filter((k) => k.startsWith(`${o.gate}|`) && !seen.has(k)),
  }));
}

export function writeBaseline(reports = collectBoundaryReport()) {
  // A Set, not a sort: the same key can be produced more than once (G4 matches
  // two symbol spellings on one import line, G6 finds the same table declared
  // in two databases), and writing the duplicate would imply two independent
  // findings where there is one subject.
  const entries = [...new Set(reports.flatMap((r) => r.findings.map((f) => fingerprint(r, f))))].sort();
  fs.writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        $comment:
          'Plan 600 boundary-gate baseline. Entries are KNOWN findings, recorded so the gate fails only on NEW ones while G4/G6 stay open. Regenerate with `npm run architecture:boundaries -- --write` after a fix and review the diff: a shrinking set is a real fix, an unchanged one means nothing moved.',
        gate: 'plan-600-boundaries',
        entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(`wrote ${entries.length} fingerprints to ${rel(BASELINE_PATH)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    writeBaseline();
    process.exit(0);
  }
  const outcomes = evaluate();
  let newTotal = 0;
  for (const o of outcomes) {
    newTotal += o.newFindings.length;
    process.stdout.write(
      `${o.gate} ${o.newFindings.length === 0 ? 'BASELINED' : 'NEW'} — ${o.title}\n` +
        `    known: ${o.known}   new: ${o.newFindings.length}   stale: ${o.stale.length}\n`,
    );
    for (const k of o.newFindings) process.stdout.write(`    NEW    ${k}\n`);
    for (const k of o.stale) process.stdout.write(`    FIXED  ${k}\n`);
  }
  if (newTotal > 0) {
    process.stdout.write(`\n${newTotal} new finding(s) not in the baseline — these are regressions.\n`);
    process.exit(1);
  }
  process.stdout.write('\nno new findings. Known defects remain recorded in the baseline.\n');
  process.exit(0);
}
