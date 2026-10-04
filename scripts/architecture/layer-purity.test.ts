/**
 * The layer-purity gate's own tests.
 *
 * Two jobs, in priority order:
 *
 *  1. **Prove the gate has teeth.** A gate that cannot fail is worse than no
 *     gate, because it is read as a green light. Every "can it catch a
 *     violation" case below is therefore written against a SYNTHETIC module
 *     list, so a regression in the detector is caught even if the real repo
 *     happens to be clean.
 *
 *  2. **Pin the real state.** The two `CORE_MODULES` assertions are the ones
 *     that make the `layers:` block load-bearing. If `packages/ai` grows a
 *     fourth network call, or a carve-out goes stale, these fail.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_MODULES,
  REPO_ROOT,
  findCorePurityViolations,
  findIoSites,
  findStaleCarveOuts,
  scanCoreModules,
  type CoreModule,
} from './layer-purity';

const POLICY = path.join(REPO_ROOT, 'architecture-policy.yaml');

/** A throwaway tree under the OS temp dir, cleaned up by the caller. */
function scratchTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-purity-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

describe('the IO detector has teeth', () => {
  it('flags a network call in a core root', () => {
    const dir = scratchTree({ 'src/a.ts': 'export const go = () => fetch("http://x");\n' });
    const module: CoreModule = { id: 'synthetic', roots: [dir], carveOut: [] };
    const problems = findCorePurityViolations([module]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('fetch');
    expect(problems[0]).toContain('synthetic');
  });

  it('flags a node builtin import', () => {
    const dir = scratchTree({ 'src/b.ts': "import fs from 'node:fs';\nexport const r = fs;\n" });
    const problems = findCorePurityViolations([{ id: 'synthetic', roots: [dir], carveOut: [] }]);
    expect(problems.join('\n')).toContain('node:fs');
  });

  it('does NOT flag a type-only node builtin import, which is erased at compile time', () => {
    // `packages/ai/src/api/bedrock-converse.ts:32-35` does exactly this: an
    // `import type` of `node:crypto` to name the signer types, plus a lazy
    // runtime `require`. Only the require is a capability.
    const dir = scratchTree({
      'src/c.ts': "import type { createHash } from 'node:crypto';\nexport type H = typeof createHash;\n",
    });
    expect(findCorePurityViolations([{ id: 'synthetic', roots: [dir], carveOut: [] }])).toEqual([]);
  });

  it('does NOT flag a primitive that only appears in a comment', () => {
    // A doc comment that says "this calls fetch" is documentation. Counting it
    // would flood the gate with prose and train everyone to ignore it.
    const dir = scratchTree({
      'src/d.ts': '/**\n * Calls fetch() to reach the API.\n */\nexport const pure = 1;\n',
    });
    expect(findCorePurityViolations([{ id: 'synthetic', roots: [dir], carveOut: [] }])).toEqual([]);
  });

  it('does NOT flag a line-comment mention', () => {
    const dir = scratchTree({
      'src/e.ts': 'export const n = 1; // replaced fetch() with a port\n',
    });
    expect(findCorePurityViolations([{ id: 'synthetic', roots: [dir], carveOut: [] }])).toEqual([]);
  });

  it('honours a carve-out', () => {
    const rel = 'src/f.ts';
    const dir = scratchTree({ [rel]: 'export const go = () => fetch("http://x");\n' });
    const module: CoreModule = {
      id: 'synthetic',
      roots: [dir],
      carveOut: [{ file: `${dir}/${rel}`, why: 'test', expects: ['fetch'] }],
    };
    expect(findCorePurityViolations([module])).toEqual([]);
  });

  it('rejects a carve-out that no longer matches — a stale allowance is a finding', () => {
    // The allowance says "this file fetches" and the file stopped fetching.
    // That means someone edited it, and the layer needs re-reading, so the
    // gate fails rather than going quietly quiet.
    const rel = 'src/g.ts';
    const dir = scratchTree({ [rel]: 'export const pure = 1;\n' });
    const module: CoreModule = {
      id: 'synthetic',
      roots: [dir],
      carveOut: [{ file: `${dir}/${rel}`, why: 'test', expects: ['fetch'] }],
    };
    expect(findStaleCarveOuts([module]).join('\n')).toContain('stale');
  });

  it('refuses to pass when the scan finds no core root at all', () => {
    // The vacuous-pass guard. A wrong REPO_ROOT resolves to nothing and every
    // assertion above would be trivially true.
    const problems = findCorePurityViolations([{ id: 'ghost', roots: ['does/not/exist'], carveOut: [] }]);
    expect(problems.join('\n')).toContain('pass vacuously');
  });
});

describe('the real core layer is pure', () => {
  it('declares no IO outside the recorded carve-out', () => {
    // THE assertion. Plan 587 M5.3 exit criterion: "core has no IO, directly
    // or smuggled in through an input."
    expect(findCorePurityViolations(CORE_MODULES)).toEqual([]);
  });

  it('has no stale carve-out entries', () => {
    expect(findStaleCarveOuts(CORE_MODULES)).toEqual([]);
  });

  it('actually scanned files (guards an anchored-wrong root)', () => {
    const scanned = scanCoreModules(CORE_MODULES);
    // Two genuinely pure roots plus the ai package: comfortably non-zero.
    expect(scanned.length).toBeGreaterThan(0);
    // And the pure halves of ai are really being walked, not skipped.
    const providers = fs.existsSync(path.join(REPO_ROOT, 'packages/ai/src/providers'));
    expect(providers).toBe(true);
  });

  it('confirms agent-protocol and agent-core are IO-free today', () => {
    // Recorded as a fact rather than left implicit: these two carry the
    // contract, and their purity is the reason `packages/ai` being
    // `core`-shaped is defensible at all.
    for (const id of ['agent-protocol', 'agent-core']) {
      const mod = CORE_MODULES.find((m) => m.id === id);
      expect(mod, `${id} must be declared core`).toBeDefined();
      expect(mod!.carveOut).toEqual([]);
    }
  });
});

describe('the layer contract is pinned to the policy file', () => {
  it('names the same packages as architecture-policy.yaml layers:', () => {
    // `layer-purity.ts` transcribes the `layers:` block instead of parsing it,
    // so that duplication is guarded here. If the policy drops a package, this
    // fails and the transcription gets re-checked.
    const policy = fs.readFileSync(POLICY, 'utf8');
    const layerBlock = policy.split('\nlayers:')[1]?.split('\n#')[0] ?? '';
    expect(layerBlock, 'policy must still have a layers: block').not.toBe('');

    // Lines look like:  "  - core # agent-core, agent-tools, ai"
    const named = new Set<string>();
    for (const line of layerBlock.split('\n')) {
      const m = /^\s*-\s*[\w-]+\s*#\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      for (const member of m[1]!.split(',')) {
        // Members are package names; trailing prose like "shared" is not one.
        if (/^[a-z][\w-]*$/.test(member.trim())) named.add(member.trim());
      }
    }
    expect(named.size, 'the layers: block must name at least one package').toBeGreaterThan(0);

    for (const mod of CORE_MODULES) {
      for (const root of mod.roots) {
        // The layers: block names PACKAGE basenames ("ai", "agent-core"), not
        // the directory they live in ("packages/ai", "packages/agent-core").
        const pkg = root.split('/').filter(Boolean).at(-1)!;
        expect(named.has(pkg), `${pkg} (${mod.id}) must be named in the layers: block`).toBe(true);
      }
    }
  });

  it('keeps every carve-out file inside its own module root', () => {
    // A carve-out for a file outside the `core` root it is granted to would be
    // an allowance that protects something the layer never claimed.
    for (const mod of CORE_MODULES) {
      for (const entry of mod.carveOut) {
        expect(
          mod.roots.some((r) => entry.file.startsWith(r)),
          `${entry.file} is outside ${mod.id}'s roots`,
        ).toBe(true);
      }
    }
  });
});

describe('findIoSites reports an actionable location', () => {
  it('points at the original line, not the comment-stripped copy', () => {
    const dir = scratchTree({
      'src/h.ts': ["/**", " * fetch() lives on the next line.", " */", 'export const go = () =>', '  fetch("http://x");', ''].join('\n'),
    });
    const sites = findIoSites(path.join(dir, 'src/h.ts'));
    expect(sites).toHaveLength(1);
    expect(sites[0]!.line).toBe(5);
    expect(sites[0]!.primitive).toBe('fetch');
    expect(sites[0]!.text).toContain('fetch');
  });
});
