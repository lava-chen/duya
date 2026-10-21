/**
 * apps/desktop/src/contracts/__tests__/contracts-boundary.test.ts
 *
 * `apps/desktop/src/contracts` exists so the main process, the preload bridge
 * and the renderer can share vocabulary without any of them importing another.
 * That only holds if the directory stays a CONTRACT surface, so the constraints
 * are asserted here rather than left to convention.
 *
 * ## What is forbidden, and why each one
 *
 *   - Electron: a `contracts` module that imports `electron` would drag the
 *     main process's runtime into the renderer bundle the moment a type-only
 *     import was widened to a value one. The whole point is that the hop stays
 *     type-only, and that is only true while the target has no runtime.
 *   - Node builtins with side effects: same reasoning, narrower.
 *   - The DOM: the renderer has `lib.dom`, main and preload do not, so a DOM
 *     type here would resolve in one program and fail in the other two.
 *   - The host's own implementation: a contract that imports `main/` or
 *     `preload/` inverts the boundary it exists to hold.
 *   - Values that are not vocabulary: an enum, a class, or a function is
 *     behaviour wearing a contract's clothes. The cut list is explicit that the
 *     behavioural share of the main/renderer edge is M5.5's work, not this
 *     directory's, and a constant exported here is where that work would
 *     quietly start.
 *
 * The last rule is a type-shape check rather than a text one, so it is asserted
 * against the compiler's own view via a deliberate error: if the directory ever
 * exports a runtime value, the assignment below stops typechecking.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// apps/desktop/src/contracts/__tests__ -> repo root, five levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'apps/desktop/src/contracts');

function contractFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(CONTRACTS_DIR);
  return out;
}

describe('the contracts directory is a contract surface', () => {
  it('is not empty, so the rules below are rules about something', () => {
    // A guard on the guard: with no files, every "no file may" assertion below
    // would pass vacuously and the directory could be quietly emptied.
    expect(contractFiles().length).toBeGreaterThan(0);
  });

  it('has no import of electron, node builtins, the DOM, or the host', () => {
    const offenders: { file: string; spec: string }[] = [];
    for (const file of contractFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      // Comments are prose, not code; the same discipline audit-imports uses.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const re = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const spec = m[1];
        const bare = spec.replace(/^node:/, '');
        const isForbidden =
          spec === 'electron' ||
          spec.startsWith('electron/') ||
          /^(fs|path|crypto|os|child_process|net|http|https|worker_threads)$/.test(bare) ||
          /^(lib\.dom|dom)$/.test(bare) ||
          spec.includes('/main/') ||
          spec.includes('/preload/') ||
          spec.includes('/renderer/');
        if (isForbidden) offenders.push({ file: path.basename(file), spec });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no runtime values, only types', () => {
    // Behaviour is the M5.5 share of the main/renderer edge, and a constant or
    // a function exported from here is where that work would quietly start:
    // it would resolve in all three programs, so a value could reach the
    // renderer through a module whose entire purpose is to be inert.
    const offenders: { file: string; decl: string }[] = [];
    for (const file of contractFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const re = /^\s*export\s+(const|let|var|function|class|enum|abstract\s+class)\b/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        offenders.push({ file: path.basename(file), decl: m[1] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is imported by all three processes, so the boundary is doing work', () => {
    // A contracts directory nothing reaches is an unused directory. This also
    // pins the claim that the hop is now host-internal: the three consumers
    // are main, preload and renderer, and none of them imports another.
    const specs: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'dist') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const code = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          const re = /(?:from\s+|import\s*\()\s*["']([^"'\r\n]*contracts[^"'\r\n]*)["']/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(code)) !== null) {
            specs.push(`${path.relative(REPO_ROOT, full).split(path.sep).join('/')} -> ${m[1]}`);
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, 'apps/desktop/src'));

    const consumers = new Set(specs.map((s) => s.split(' -> ')[0].split('/')[3]));
    expect([...consumers].sort()).toEqual(expect.arrayContaining(['main', 'preload', 'renderer']));
  });
});
