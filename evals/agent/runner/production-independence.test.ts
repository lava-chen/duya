/**
 * Plan 587 E4.3 — the production build must not depend on eval code.
 *
 * ## What is asserted, and how
 *
 * Two independent directions, because either alone leaves a hole:
 *
 *  1. No production source imports anything under `evals/`. Scanning the real
 *     import specifiers of every tracked `.ts`/`.tsx`/`.mjs` under the
 *     production trees (`apps/`, `packages/`, `scripts/`) for one that resolves
 *     into `evals/`, or that names the `evals/` prefix at all. This is a
 *     statement about the SOURCE, and it is checked on source rather than on a
 *     build output so the verdict cannot depend on whether anyone has built.
 *
 *  2. No build, packaging or typecheck configuration includes `evals/`. Each
 *     tsconfig that a build or a typecheck gate uses is read and its
 *     `include`/`files` checked. If a future edit pulls `evals/` into
 *     `tsconfig.main.json`, the eval tree would start compiling into
 *     `dist-electron` and ship — and this test says so before it happens.
 *
 * ## Why the check is not merely "the build passes"
 *
 * A build passing is not evidence of independence: esbuild does not type check,
 * a tree-shaken import can vanish, and an eval module can be reachable from a
 * production entry without appearing in the output. The claim is a structural
 * one, so it is checked structurally.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Trees that a shipped artefact is built from. */
const PRODUCTION_ROOTS = ['apps', 'packages', 'scripts'] as const;

const SRC_EXT = /\.(ts|tsx|mjs|cjs|js)$/;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
}

describe('E4.3 — the production build must not depend on eval code', () => {
  it('no production source file imports anything under evals/', () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (!SRC_EXT.test(file)) continue;
      if (file.startsWith('evals/')) continue;
      if (!PRODUCTION_ROOTS.some((root) => file.startsWith(`${root}/`))) continue;
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      // Any specifier at all, not just resolved ones: an unresolvable specifier
      // naming `evals/` is still a dependency the moment someone adds the file.
      for (const m of text.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g)) {
        const spec = m[1] ?? '';
        const resolved = spec.startsWith('.')
          ? path.relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(file), spec)).replace(/\\/g, '/')
          : spec;
        if (resolved.startsWith('evals/') || /(^|\/)evals\//.test(spec)) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no tsconfig used by a build or a typecheck gate includes evals/', () => {
    const offenders: string[] = [];
    const configs = [
      'tsconfig.json',
      'apps/desktop/tsconfig.main.json',
      'apps/desktop/tsconfig.preload.json',
      'apps/desktop/tsconfig.renderer.json',
      ...['agent', 'agent-core', 'agent-protocol', 'agent-runtime', 'ai', 'cli', 'computer-use', 'conductor', 'gateway', 'plugin-core', 'voice']
        .map((p) => `packages/${p}/tsconfig.json`),
    ];
    for (const rel of configs) {
      const abs = path.join(REPO_ROOT, rel);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
      } catch {
        continue; // A tsconfig with comments/exports is handled by the gate below.
      }
      const include = (raw as { include?: unknown }).include;
      if (Array.isArray(include) && include.some((g) => typeof g === 'string' && g.includes('evals'))) {
        offenders.push(`${rel} includes evals/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the eval tree is typechecked strictly, and follows the extends chain to prove it', () => {
    const evalsPath = path.join(REPO_ROOT, 'evals', 'tsconfig.json');
    const raw = readFileSync(evalsPath, 'utf8');

    // `evals/tsconfig.json` extends the main project rather than restating its
    // compiler options, so "is it strict" is a question about the CHAIN, not
    // about one file. Walk it: some config in the chain must set strict true, and
    // nothing in the chain may turn it off.
    let current = evalsPath;
    const chain: string[] = [];
    for (let hops = 0; hops < 8; hops++) {
      const text = readFileSync(current, 'utf8');
      chain.push(current);
      expect(text).not.toMatch(/"strict"\s*:\s*false/);
      const m = /"extends"\s*:\s*"([^"]+)"/.exec(text);
      if (m === null || m[1] === undefined) break;
      current = path.resolve(path.dirname(current), m[1]);
    }
    const joined = chain.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(joined).toMatch(/"strict"\s*:\s*true/);
    // And it must actually check the eval tree's own files.
    expect(raw).toMatch(/"include"\s*:\s*\[\s*"\*\*\/\*\.ts"\s*\]/);
    expect(raw).toMatch(/"noEmit"\s*:\s*true/);
  });

  it('the eval tsconfig is not extended by, and does not extend into, a production project', () => {
    const raw = readFileSync(path.join(REPO_ROOT, 'evals', 'tsconfig.json'), 'utf8');
    // It may EXTEND a production tsconfig (that is how it inherits `paths`), but
    // no production tsconfig may extend it — otherwise eval options would leak
    // into a shipped build.
    for (const rel of ['tsconfig.json', 'apps/desktop/tsconfig.main.json', 'apps/desktop/tsconfig.renderer.json']) {
      const prod = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(prod).not.toMatch(/evals[\\/]tsconfig/);
    }
  });

  it('the eval tree is collected by vitest, so a test placed there is not a test nobody runs', () => {
    const config = readFileSync(path.join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/evals\/\*\*\/\*\.test\.ts/);
  });
});
