#!/usr/bin/env node
/**
 * worker-module-state-gate.mjs — freeze module-level mutable state in the
 * worker's first-party source set.
 *
 * ## Why this gate exists
 *
 * A worker process is not a session. It can serve several top-level sessions
 * over its lifetime and can be running a child session at the same time, so a
 * module-level `let` or `new Map()` is process-wide state pretending to be
 * session state. PR #616 argued exactly this, then shipped a module-level
 * `readFirstGateEnabled` boolean and a `CompactionManager.compact()` that
 * cleared every session's read ledger. Both were found by hand during the PR
 * audit, not by a gate.
 *
 * This is a RATCHET, not a proof of correctness. It cannot tell a legitimate
 * process-wide cache from a session leak. What it can do is make every NEW one
 * show up in a diff: adding module-level mutable state to worker-loaded code
 * requires regenerating a checked-in baseline, which puts the addition in
 * front of a reviewer instead of in front of a user three PRs later. Debt may
 * shrink freely; it may not grow silently.
 *
 * ## Why the scope is the bundle metafile
 *
 * "Worker-loaded code" is not the same as every source under packages/. The
 * checked-in `packages/host/bundle/worker-entry.js`, whose esbuild metafile
 * records the exact input set. Scanning that set means a file nobody loads
 * cannot make the gate red, and a newly reachable file cannot slip in unseen.
 * It also means this gate has to be rerun after `bundle:worker` — the final
 * rebuild in an integration branch is the moment the scope becomes final.
 *
 * ## Why an AST and not a regex
 *
 * This tree ships prompt templates and architecture gates full of string and
 * regex literals containing `let foo = ...`. A text scan reports those, and a
 * comment-stripping scan still reports the strings. `typescript`'s parser
 * gives us actual top-level statements: only source-file statements are
 * visited, so a `let` inside a function, a class method, a `for` head or a
 * template literal is invisible by construction. No heuristic to maintain.
 *
 * ## Why "blind" is a failure
 *
 * A missing or empty metafile would otherwise produce zero findings, and zero
 * findings looks exactly like a clean repo. `bundle-verify.mjs` and
 * `gate-scan-guard.mjs` both pay for this lesson; so does this gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const METAFILE = 'packages/host/bundle/worker-metafile.json';
export const BASELINE = 'scripts/architecture/worker-module-state-baseline.json';

/** Container constructors whose instances are mutable without rebinding. */
const MUTABLE_COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** `const x = new Map()` is mutable state even though the binding never moves. */
function isMutableCollection(initializer) {
  if (initializer === undefined) return false;
  if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
    return isMutableCollection(initializer.expression);
  }
  if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    return MUTABLE_COLLECTIONS.has(initializer.expression.text);
  }
  return false;
}

/**
 * Findings in ONE source file, from the AST only.
 *
 * Exported and pure so the test can feed it synthetic source: the positive
 * cases prove the gate has teeth and the negative cases prove it does not
 * mistake a function-local `let`, a `const` scalar, a string, a regex or a
 * comment for module state.
 */
export function findingsInSource(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = [];

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const kind = (flags & ts.NodeFlags.Let) !== 0 ? 'let'
        : (flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'var';
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (kind !== 'const') {
          found.push({ name, kind });
        } else if (isMutableCollection(declaration.initializer)) {
          found.push({ name, kind: 'collection' });
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const modifiers = ts.getModifiers(member) ?? [];
        const isStatic = modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        const isReadonly = modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
        if (!isStatic || isReadonly) continue;
        found.push({ name: `${statement.name?.getText(source) ?? '<anonymous>'}.${member.name.getText(source)}`, kind: 'static' });
      }
    }
  }
  return found;
}

/**
 * The worker's first-party TypeScript inputs, sorted for a stable baseline.
 *
 * `existsSync` filters files the metafile recorded but the tree no longer has;
 * `bundle-verify` separately reports those as structural staleness, and this
 * gate is not a second opinion on bundle freshness.
 */
export function workerSourceInputs(metafile, repoRoot = ROOT, exists = fs.existsSync) {
  return Object.keys(metafile?.inputs ?? {})
    .filter((file) => file.startsWith('packages/'))
    .filter((file) => !file.includes('/node_modules/'))
    .filter((file) => !file.includes('/dist/'))
    .filter((file) => /\.[cm]?tsx?$/iu.test(file) && !/\.d\.[cm]?ts$/iu.test(file))
    .filter((file) => !/\.(?:test|spec)\.[cm]?tsx?$/iu.test(file) && !file.includes('/__tests__/'))
    .filter((file) => exists(path.join(repoRoot, file)))
    .sort();
}

/** Scan the tree. Returns a stable, JSON-serialisable report. */
export function collectWorkerModuleState({
  repoRoot = ROOT,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
} = {}) {
  const metafilePath = path.join(repoRoot, METAFILE);
  if (!exists(metafilePath)) {
    return { files: [], findings: [], error: `missing ${METAFILE}; worker scope is unknown` };
  }
  let metafile;
  try {
    metafile = JSON.parse(readFile(metafilePath, 'utf8'));
  } catch (error) {
    return { files: [], findings: [], error: `unreadable ${METAFILE}: ${error.message}` };
  }

  const files = workerSourceInputs(metafile, repoRoot, exists);
  const findings = [];
  for (const file of files) {
    const text = readFile(path.join(repoRoot, file), 'utf8');
    for (const finding of findingsInSource(file, text)) {
      findings.push({ file, ...finding });
    }
  }
  return {
    files,
    findings,
    fingerprints: [...new Set(findings.map((f) => `${f.file}#${f.name}`))].sort(),
    error: null,
  };
}

/** Compare against the frozen baseline. Pure, so the test can pin both halves. */
export function compareModuleState(report, baseline) {
  const previous = new Set(baseline?.fingerprints ?? []);
  const current = new Set(report.fingerprints ?? []);
  return {
    added: [...current].filter((key) => !previous.has(key)).sort(),
    removed: [...previous].filter((key) => !current.has(key)).sort(),
  };
}

/**
 * The verdict. A blind scan is a HARD failure (exit 2), distinct from a real
 * ratchet failure (exit 1) — re-running a blind gate gives the same blind
 * answer, so it must never be reported as a flaky red.
 */
export function evaluateModuleState(report, baseline) {
  if (report.error !== null || report.files.length === 0) {
    return {
      ok: false,
      code: 2,
      reason: report.error ?? 'blind scan: 0 first-party worker sources walked',
      added: [],
      removed: [],
    };
  }
  if (!baseline || !Array.isArray(baseline.fingerprints)) {
    return { ok: false, code: 1, reason: `missing or invalid ${BASELINE}`, added: [], removed: [] };
  }
  const { added, removed } = compareModuleState(report, baseline);
  return {
    ok: added.length === 0,
    code: added.length === 0 ? 0 : 1,
    reason: added.length === 0
      ? 'no new module-level mutable state'
      : `${added.length} new module-level mutable declaration(s)`,
    added,
    removed,
  };
}

function readBaseline(repoRoot) {
  const file = path.join(repoRoot, BASELINE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv) {
  const write = argv.includes('--write');
  const json = argv.includes('--json');
  const report = collectWorkerModuleState();

  if (write) {
    if (report.files.length === 0) {
      process.stderr.write(`worker module state: refusing to write a blind baseline (${report.error ?? '0 files'})\n`);
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(path.join(ROOT, BASELINE), `${JSON.stringify({
      version: 1,
      note: 'Module-level mutable state already present in worker-loaded first-party sources. Additions require review; removals are welcome. Regenerate with: npm run architecture:worker-module-state -- --write',
      fingerprints: report.fingerprints,
    }, null, 2)}\n`);
    process.stdout.write(
      `worker module state: baseline written — ${report.fingerprints.length} declarations / ${report.files.length} worker sources\n`,
    );
    return;
  }

  const verdict = evaluateModuleState(report, readBaseline(ROOT));
  const scope = `${report.fingerprints.length} declarations / ${report.files.length} worker sources`;
  if (json) {
    process.stdout.write(`${JSON.stringify({ scope, report, verdict }, null, 2)}\n`);
  } else {
    process.stdout.write(`worker module state: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.reason} (${scope})\n`);
    for (const key of verdict.added.slice(0, 30)) {
      process.stderr.write(`  + ${key}\n`);
    }
    if (verdict.added.length > 30) process.stderr.write(`  + ... ${verdict.added.length - 30} more\n`);
    if (verdict.added.length > 0) {
      process.stderr.write(
        '\nA worker process serves multiple sessions. Make the new state session-scoped\n'
        + '(see packages/capabilities/src/file-read-state.ts), or register it with\n'
        + '`npm run architecture:worker-module-state -- --write` and justify it in the PR.\n',
      );
    }
    if (verdict.removed.length > 0) {
      process.stdout.write(`  ${verdict.removed.length} declaration(s) retired; the baseline may be shrunk.\n`);
    }
  }
  process.exitCode = verdict.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
