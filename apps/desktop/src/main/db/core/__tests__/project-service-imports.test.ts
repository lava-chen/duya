/**
 * projectService — import-graph guard.
 *
 * Plan 610 A5 wants to extract `db/core` into a package, which a package can
 * only do if it stops importing the app. `projectService` was the blocker:
 * it reached sideways into a SECOND SQLite database to unbind
 * `rollout_catalog` on project delete. The composition root now injects that
 * handle (`ProjectServiceOptions.memoryDb`), so the import must not come back
 * as a "convenient default" — that default is what makes `db/core`
 * un-extractable in the first place.
 *
 * Scoped to `projectService.ts` on purpose: other modules in this directory
 * still import app code (`logging/logger`, `config/agent-paths`,
 * `memory-state/pathUtils`, and a deep relative path into
 * `packages/agent/src`). Those are separate seams with their own plan rows.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_SERVICE = path.join(__dirname, '..', 'projectService.ts');

/** Every `import ... from '...'` / `require('...')` target in a source file. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+'([^']+)'/g,
    /\bfrom\s+"([^"]+)"/g,
    /\brequire\(\s*'([^']+)'\s*\)/g,
    /\bimport\(\s*'([^']+)'\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe('projectService import graph', () => {
  const source = fs.readFileSync(PROJECT_SERVICE, 'utf8');
  const specifiers = importSpecifiers(source);

  it('does not import anything from memory-state', () => {
    const offenders = specifiers.filter((spec) => /memory-state/.test(spec));
    expect(offenders).toEqual([]);
  });

  it('does not import another database module to default a handle', () => {
    // A regression guard for the specific shape that was removed: importing a
    // `getDb` and defaulting `memoryDb` to it.
    const offenders = specifiers.filter((spec) => /\/(db|memory-state)\b.*\bdb'?$/.test(spec));
    expect(offenders).toEqual([]);
  });

  it('still reads the core store through a db/-local seam', () => {
    // The core projects table is reached through `./project-store`, a db/-local
    // module that re-exports @duya/data/project-store, and the HANDLE ITSELF
    // is injected (`ProjectServiceOptions.projectsDb`) rather than resolved
    // from a global. So there is still no "convenient default" that would
    // make db/core un-extractable — which is what this file guards.
    //
    // The seam MOVED when the core aggregates moved to @duya/data: the module
    // used to be `../core-connection` (a `getCoreStores()` call), and that
    // import is gone. What the assertion protects is unchanged: the core
    // store is read through a db/-local module, not through an app-module
    // escape and not through a second database handle.
    expect(specifiers).toContain('./project-store');
    // No relative import may climb out of db/core for a handle — that is
    // the shape the "convenient default" would take.
    expect(specifiers.filter((spec) => spec.startsWith('../../'))).toEqual([]);
  });
});