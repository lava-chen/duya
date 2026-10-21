/**
 * Plan 610 A1 — headless load gate tests.
 *
 * ## What these tests are for
 *
 * A gate that reports a fact without checking anything is worse than a red
 * test: the next slice trusts it and deletes the real check. So this file has
 * two halves, in this order:
 *
 *   1. **NEGATIVE FIXTURES.** Every rule below is handed the exact violation it
 *      forbids and asserted to FIND it. A rule with only a positive case
 *      ("the tree is clean") cannot tell a working detector from a detector
 *      that matches nothing — the `ok = 0, bad = 0` shape.
 *   2. **THE LIVE TREE.** The shipped handlers, measured. This half asserts
 *      against `DECLARED_ELECTRON_HANDLERS`, the contract's declared subject
 *      (`00-contracts.md` §0 row 1), NOT against a number the gate itself just
 *      produced: §3.2 rejects `a === a`, so declaration and measurement have to
 *      come from different places or the comparison proves nothing.
 *
 * The negative fixtures are synthetic strings and in-memory metafiles, not
 * edits to the live tree: the shared checkout is under active modification by
 * other agents, and a test that mutates real source to prove a gate works would
 * race them. The manual mutation proof (inject a hard import into a handler,
 * watch the gate go red, revert) is recorded in the plan, not faked here.
 */

import { describe, expect, it, beforeAll } from 'vitest';

import {
  DECLARED_ELECTRON_HANDLERS,
  ELECTRON_SPECIFIER,
  HANDLER_LAYER_DIR,
  bundlerHardElectronEdges,
  collectHeadlessReport,
  electronEdges,
  handlerLayerModules,
  hasHardElectronImport,
  verdictOf,
} from './headless-load-gate.mjs';

const GUARDED = `
import { homedir } from 'node:os';
import { join } from 'node:path';
function getUserDataDir(): string {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return join(homedir(), '.duya');
  }
}
`;

const HARD = `import { app } from 'electron';
export const version = app.getVersion();
`;

const HARD_TYPE_ONLY = `import type { App } from 'electron';
export type Desktop = App;
`;

const HARD_MIXED = `import { type BrowserWindow } from 'electron';
export type AnyWindow = BrowserWindow;
`;

const DYNAMIC = `export async function version(): Promise<string> {
  const { app } = await import('electron');
  return app.getVersion();
}
`;

describe('A1a — the electron import classifier', () => {
  it('reports a hard module-scope import as an evaluation-time edge', () => {
    expect(electronEdges(HARD)).toEqual([{ line: 1, form: 'static', typeOnly: false }]);
    expect(hasHardElectronImport(HARD)).toBe(true);
  });

  it('does not report the guarded require the six correct handlers already use', () => {
    // This is the negative case for the whole rule: a detector that flagged
    // every mention of `electron` would fail the tree that is already correct.
    expect(electronEdges(GUARDED)).toEqual([{ line: 6, form: 'require-call', typeOnly: false }]);
    expect(hasHardElectronImport(GUARDED)).toBe(false);
  });

  it('does not report a type-only import, which the compiler erases', () => {
    expect(electronEdges(HARD_TYPE_ONLY)).toEqual([{ line: 1, form: 'static', typeOnly: true }]);
    expect(hasHardElectronImport(HARD_TYPE_ONLY)).toBe(false);
  });

  it('classifies an inline type-only specifier as type-only too', () => {
    expect(hasHardElectronImport(HARD_MIXED)).toBe(false);
  });

  it('classifies a dynamic import as deferred, not evaluation-time', () => {
    expect(electronEdges(DYNAMIC)).toEqual([{ line: 2, form: 'dynamic-import', typeOnly: false }]);
    expect(hasHardElectronImport(DYNAMIC)).toBe(false);
  });

  it('ignores a mention of electron inside a comment', () => {
    // `strip-comments` is what makes this pass; a raw regex would report the
    // prose in this very file's docstrings as a violation.
    expect(electronEdges('// import { app } from "electron";\n/* require("electron") */\n')).toEqual([]);
  });

  it('reads a comment-stripped copy of the sentence in its own docstring', () => {
    const prose = ' * - A1a (static) - no module carries a hard `import ... from electron`.\n';
    expect(electronEdges(prose)).toEqual([]);
  });
});

describe('A1a — the bundler cross-check classifies the same edge differently', () => {
  const metafile = {
    inputs: {
      'apps/desktop/src/main/cli/handlers/hard.ts': {
        imports: [{ path: ELECTRON_SPECIFIER, kind: 'import-statement', external: true }],
      },
      'apps/desktop/src/main/cli/handlers/guarded.ts': {
        imports: [{ path: ELECTRON_SPECIFIER, kind: 'require-call', external: true }],
      },
      'apps/desktop/src/main/cli/handlers/local.ts': {
        imports: [{ path: './sibling.js', kind: 'import-statement', external: false }],
      },
    },
  };

  it('reports the evaluation-time edge and only that one', () => {
    const graph = new Map(
      Object.entries(metafile.inputs).map(([file, info]) => [
        file,
        info.imports.map((i) => ({ spec: i.path, kind: i.kind, external: i.external, to: null })),
      ]),
    );
    expect(bundlerHardElectronEdges(graph).map((e) => e.file)).toEqual([
      'apps/desktop/src/main/cli/handlers/hard.ts',
    ]);
  });
});

describe('A1 — the shipped handler layer', () => {
  /** One measurement, shared: the build is ~7 s and the graph is the tree. */
  let report;

  beforeAll(async () => {
    report = await collectHeadlessReport();
  }, 300_000);

  it('covers a directory, and that directory still holds the contract subject', () => {
    // DECLARED (00-contracts.md §0 row 1) vs MEASURED (what is on disk now).
    // If the walker ever returned an empty set, this fails instead of the gate
    // reporting a clean bill of health for a graph it never looked at.
    const modules = handlerLayerModules();
    expect(modules.length).toBeGreaterThanOrEqual(20);
    for (const declared of DECLARED_ELECTRON_HANDLERS) {
      expect(modules).toContain(declared);
    }
  });

  it('A1a: no module in the layer carries a hard electron import', () => {
    expect(report.a1a.scope).toBe(handlerLayerModules().length);
    expect(report.a1a.hard).toEqual([]);
  });

  it('A1a: the source scanner and the bundler agree on every hard import', () => {
    // Containment in the strict direction: nothing the scanner calls hard may
    // be invisible to esbuild. An over-reporting scanner fails here; an
    // under-reporting one is caught by A1b, which loads the graph.
    expect(report.a1a.unexplained).toEqual([]);
    expect(report.a1a.bundlerHard).toBe(0);
  });

  it('A1b: the child process really refused electron', () => {
    // If the patch had not installed, every load below would have succeeded
    // for the wrong reason and this whole half of the gate would be theatre.
    expect(report.a1b.probeError).toBeNull();
    expect(report.a1b.patchArmed).toBe(true);
    expect(report.a1b.refused).toBeGreaterThan(0);
  });

  it('A1b: no handler-layer module is the origin of a load failure', () => {
    expect(report.a1b.attributed).toEqual([]);
  });

  it('A1b: every module was accounted for, and some genuinely loaded', () => {
    // `loaded + failed === scope` catches a probe that silently skipped
    // modules; `loaded > 0` catches one that failed everything, which would
    // make the verdict above meaningless.
    expect(report.a1b.loaded.length + report.a1b.failed).toBe(report.a1b.scope);
    expect(report.a1b.loaded.length).toBeGreaterThan(0);
    for (const name of report.a1b.loaded) {
      expect(handlerLayerModules()).toContain(`${HANDLER_LAYER_DIR}/${name}.ts`);
    }
  });

  it('verdict is green for the scoped claim', () => {
    expect(verdictOf(report)).toBe(true);
  });

  it('A1b-full is still OPEN, and says which files', () => {
    // Deliberately asserted RED. The full server-entry closure is NOT decoupled
    // yet: `core/window-manager.ts` (BrowserWindow / dialog), `ipc/*` (ipcMain)
    // and ~40 more still hard-import electron. Whoever closes that (A3/A4/A5)
    // has to come here and change this number on purpose, which is the point.
    expect(report.open.hardElectronImporters).toBeGreaterThan(0);
    expect(report.open.files).toContain('apps/desktop/src/main/core/window-manager.ts');
    expect(report.open.files).toContain('apps/desktop/src/main/gateway/message-bus.ts');
  });
});
