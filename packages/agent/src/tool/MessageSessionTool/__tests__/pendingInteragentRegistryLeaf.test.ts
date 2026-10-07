/**
 * The inter-agent registry must stay a LEAF.
 *
 * ## What this guards
 *
 * `tool/MessageSessionTool/MessageSessionTool.ts` used to import
 * `registerPendingInteragentCall` / `unregisterPendingInteragentCall` as VALUES
 * from `process/agent-process-entry.ts`. `MessageSessionTool` is reachable from
 * `tool/builtin.ts` and the entry is reachable from `modes/index.ts`, so that
 * one import closed a cycle through the whole entry/agent/tool/modes component.
 *
 * The extraction into `process/pending-interagent-calls.ts` removed it, and that
 * is the only reason the component shrank. Nothing else in the test suite can
 * see this: the tool behaves identically whichever module owns the `Map`, and
 * the architecture gate is red on this component either way, so a regression
 * here is invisible to every other signal in the repo.
 *
 * ## Why the assertions are shaped this way
 *
 * The gate under test is the IMPORT GRAPH, so the test reads the import
 * specifiers out of the tool's source and resolves them against the filesystem.
 * The expected side is the set of forbidden target paths, which is a constant
 * declared here — the test never compares the tool's source to itself, and never
 * compares the two sides of an assertion to the same string.
 *
 * A vacuous pass is the failure mode worth designing against: a test that
 * asserts "no import matches X" passes just as happily if the parse found
 * nothing at all. So `READ` is asserted to be non-empty and to contain a
 * KNOWN-good specifier before the negative rows are trusted.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'MessageSessionTool.ts');
const LEAF = path.join(HERE, '..', '..', '..', 'process', 'pending-interagent-calls.ts');
const ENTRY = path.join(HERE, '..', '..', '..', 'process', 'agent-process-entry.ts');

/** Comment-strip, so a specifier named in prose is never read as an edge. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const SPECIFIER_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g;

/** Relative specifiers the file actually imports, resolved to real files. */
function relativeImportsOf(absolutePath: string): string[] {
  const text = code(fs.readFileSync(absolutePath, 'utf8'));
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SPECIFIER_RE.lastIndex = 0;
  while ((m = SPECIFIER_RE.exec(text))) {
    if (!m[1].startsWith('.')) continue;
    const base = path.resolve(path.dirname(absolutePath), m[1]);
    // `agent` sources write `.js` specifiers that resolve to `.ts`. Without
    // this stem rewrite every candidate is `worker-protocol.js.ts`, nothing
    // resolves, and the parse returns EMPTY -- which makes every "no import is
    // X" row below pass for the wrong reason.
    const ext = path.extname(base);
    const stem = ext === '.js' || ext === '.mjs' ? base.slice(0, -ext.length) : base;
    const candidates =
      ext === '.js' || ext === '.mjs'
        ? [`${stem}.ts`, `${stem}.tsx`, base, `${stem}.js`]
        : [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, base];
    candidates.push(`${base}/index.ts`, `${base}/index.tsx`);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        out.push(path.normalize(candidate));
        break;
      }
    }
  }
  return out;
}

const TOOL_IMPORTS = relativeImportsOf(TOOL);
const norm = (p: string) => path.normalize(p);

describe('the inter-agent registry is a leaf, not the worker entry', () => {
  it('reads the tool\'s imports, so the negative rows below are not vacuous', () => {
    // Anti-vacuity control: an empty parse would make every "no import is X"
    // row pass for the wrong reason.
    expect(TOOL_IMPORTS.length).toBeGreaterThan(0);
    expect(TOOL_IMPORTS.map(norm)).toContain(norm(path.join(HERE, '..', 'constants.ts')));
  });

  it('does not import the worker entry from the tool', () => {
    // The forbidden side is a path constant; the actual side is the parsed
    // graph. Different sources, so this cannot be satisfied by comparing a
    // value with itself.
    expect(TOOL_IMPORTS.map(norm)).not.toContain(norm(ENTRY));
  });

  it('gets the registry from the leaf module', () => {
    expect(TOOL_IMPORTS.map(norm)).toContain(norm(LEAF));
  });

  it('reads the same leaf the tool does, so both sides share ONE map', () => {
    // Guards the other half of the move: if the entry kept its own private Map
    // the tool would register into a map nobody drains, and the inter-agent
    // call would hang until its timeout with no test noticing.
    const entryImports = relativeImportsOf(ENTRY).map(norm);
    expect(entryImports).toContain(norm(LEAF));
  });

  it('keeps the leaf from importing anything that could close a cycle', () => {
    // worker-protocol is a leaf too, so the whole path tool -> leaf -> type is
    // acyclic. Anything else is a future back-edge wearing a new name.
    expect(relativeImportsOf(LEAF).map(norm)).toEqual([
      norm(path.join(HERE, '..', '..', '..', 'process', 'worker-protocol.ts')),
    ]);
  });
});