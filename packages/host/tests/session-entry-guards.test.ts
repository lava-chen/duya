/**
 * session-entry-guards.test.ts — the structural guards on the unified entry.
 *
 * ## Why these are guards and not behaviour tests
 *
 * The R1.0 audit found four entry points that each started a run their own
 * way. A behaviour test cannot catch a NEW entry point appearing, and it
 * cannot catch an existing one quietly going back to calling `openRun`
 * directly — the observable result is the same, so only the failure MODE
 * differs, and a test that only checks "the turn ran" would not notice.
 *
 * These guards read the SOURCE and assert on its shape. That is unusual for
 * this codebase, and the reason is specific: the property being protected is
 * a property of the CODE, not of the runtime. A second caller of `openRun`
 * outside the admission adapter is exactly the bug this migration exists to
 * remove, and it is invisible to every other kind of test.
 *
 * The guards are deliberately narrow. They do not forbid `openRun`; they
 * forbid it in the places that would create a second admission path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * The lines that CALL `openRun`, with the file's own comments stripped.
 *
 * The comments matter: `run-execution.ts` explains at length why the
 * admission adapter calls the Control Plane directly rather than the public
 * start entry, and that explanation mentions `openRun` by name. Counting
 * occurrences in the raw source would count the documentation too.
 */
function callSites(relativePath: string): string[] {
  const source = readSource(relativePath)
    // Line comments.
    .replace(/^\s*\/\/.*$/gm, '')
    // Block comments.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.openRun\s*\(/.test(line));
}

describe('the unified session entry', () => {
  it('routes the standalone Host through the session service', () => {
    // The Host's public start entry must go through the service, or the
    // service is decoration: the service would exist, be correct, and never
    // be asked.
    const source = readSource('packages/host/src/run-execution.ts');
    expect(source).toContain('this.#sessionService.startRun(');
  });

  it('calls the Control Plane from the admission adapter, not from the start entry', () => {
    // `openRun` is the Control Plane's atomic entry, and the adapter is the
    // one place allowed to call it. A second call site in
    // `run-execution.ts` would be a second admission path — the exact bypass
    // the R1.0 audit found in the Desktop.
    expect(callSites('packages/host/src/run-execution.ts')).toEqual([]);
  });

  it('calls the Control Plane from exactly one place in the Host', () => {
    // The admission adapter is that place. The check is on the FILE COUNT,
    // not on the call count, because the adapter is the only file allowed to
    // reach the Control Plane's start entry at all.
    const hostSources = fs.readdirSync(path.join(repoRoot, 'packages/host/src'), { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
      .map((entry) => `packages/host/src/${entry}`);
    const callers = hostSources.filter((file) => callSites(file).length > 0);
    expect(callers).toEqual(['packages/host/src/session-admission.ts']);
  });

  it('keeps the Desktop router reading the shared classifier', () => {
    // The Desktop answered refusals with the Control Plane's internal stage
    // while the Host answered with a collapsed one, so the same refusal
    // produced two different answers depending on which client asked. The
    // Desktop now classifies through the shared adapter.
    const source = readSource('apps/desktop/src/main/agents/server/router.ts');
    expect(source).toContain('classifyRunStartAcceptance(');
  });

  it('starts the Desktop turn through the unified session entry', () => {
    // The Desktop's bypass was reaching for the Control Plane's start entry
    // itself. It now goes through the session service, the same one the
    // standalone Host uses.
    const source = readSource('apps/desktop/src/main/agents/server/router.ts');
    expect(source).toContain('deps.sessionService.startRun(');
  });

  it('does not let the Desktop router build its own refusal stages', () => {
    // A Desktop-local mapping would be a second answer to the same question.
    // The router may READ stages, but it may not DECIDE them.
    const source = readSource('apps/desktop/src/main/agents/server/router.ts');
    const localMapping = /stage:\s*outcome\.state\s*===\s*'admitted'\s*\?\s*undefined\s*:\s*'refused_/;
    expect(localMapping.test(source)).toBe(false);
  });

  it('wires the Desktop session service over the Desktop orchestrator', () => {
    // The wiring is in the Desktop's own server, so the Desktop's session
    // service sits over the Desktop's orchestrator — the one that reaches
    // the Control Plane over `db:request`. A service wired over anything else
    // would start runs the Desktop's ledger does not know about.
    const source = readSource('apps/desktop/src/main/agents/server/index.ts');
    expect(source).toContain('createHostSessionService<DesktopSessionStartRequest>(');
    expect(source).toContain('controlPlane: runOrchestrator');
  });
});
