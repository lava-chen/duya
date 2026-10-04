/**
 * Profile / mode / permission are three ORTHOGONAL layers (plan 587 M5.3).
 *
 * AGENTS.md states the contract: "Profile, mode and permission are three
 * orthogonal layers". Nothing in the repo enforced it, and the risk is
 * concrete rather than theoretical — a mode that grows a permission field, or a
 * profile that starts reading the active mode set, collapses three independent
 * selectors into one coupled axis, and the collapse is invisible until a user
 * cannot explain why a tool was blocked.
 *
 * These assertions are deliberately about the SHAPE of the three layers rather
 * than about any one mode's behaviour:
 *
 *  1. The mode layer's data carrier carries no profile and no permission axis.
 *     A mode is handed session, cwd and its OWN state. If it also received the
 *     profile or the permission mode, the layers would already be joined.
 *  2. The mode layer does not import the profile or permission modules, so it
 *     cannot reach them even by accident.
 *  3. The mode RESOLUTION is a pure function of the active mode ids, so
 *     changing the profile or the permission mode cannot change what the modes
 *     resolve to.
 *
 * On point 3, note what is deliberately NOT asserted: the three id namespaces
 * are NOT string-disjoint, and cannot be made so. `'research'` is both a
 * `ModeModifierId` and an `AgentProfile.promptSystem` value; `'plan'` is a
 * permission mode while `'plan-task'` is a mode. That overlap is correct — they
 * are different axes that happen to share a word — and a test demanding string
 * disjointness would push someone to rename one of them, which would be a
 * behaviour change made to satisfy a rule about spelling.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModeModifierRegistry } from '../registry.js';
import type { ModeModifier } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = path.resolve(HERE, '../..');
const MODES_SRC = path.join(AGENT_SRC, 'modes');

/** Read a repo file as UTF-8, failing loudly rather than silently. */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** The body of a `export interface X { ... }` declaration. */
function interfaceBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export\\s+interface\\s+${name}\\b`));
  expect(start, `interface ${name} must exist`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`interface ${name} is never closed`);
}

describe('the mode layer carries no profile or permission axis', () => {
  it('ModeModifierContext exposes only session, cwd and mode-private state', () => {
    const body = interfaceBody(read(path.join(MODES_SRC, 'types.ts')), 'ModeModifierContext');

    // The three things a mode is allowed to know.
    expect(body).toMatch(/\bsessionId\s*:/);
    expect(body).toMatch(/\bworkingDirectory\s*:/);
    expect(body).toMatch(/\bstate\s*:/);

    // And explicitly not the other two layers. Matching on the field name only
    // is not enough — the leak could be spelled `approvalMode` — so the
    // forbidden vocabulary is checked as whole words across the body.
    for (const forbidden of [
      'agentProfileId',
      'profileId',
      'promptSystem',
      'permissionMode',
      'permission',
      'approval',
    ]) {
      expect(
        new RegExp(`\\b${forbidden}\\b`).test(body),
        `ModeModifierContext must not carry ${forbidden}`,
      ).toBe(false);
    }
  });

  it('the modes subtree never imports the profile or permission modules', () => {
    // A type-only import would still couple the layers, because the coupled
    // field is what the next change adds.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const src = read(full);
        if (
          /from\s+['"][^'"]*agent-profile\//.test(src) ||
          /from\s+['"][^'"]*\/permissions\//.test(src)
        ) {
          offenders.push(path.relative(AGENT_SRC, full).split(path.sep).join('/'));
        }
      }
    };
    walk(MODES_SRC);
    expect(offenders, 'modes/ must not reach into the profile or permission layers').toEqual([]);
  });
});

describe('mode resolution is independent of profile and permission', () => {
  /** A minimal declarative mode: the `modifier` paradigm, nothing else. */
  function modifier(id: string, block: readonly string[] = []): ModeModifier {
    return {
      id,
      kind: 'session',
      tools: { block: [...block] },
    } as unknown as ModeModifier;
  }

  it('resolves the same way regardless of anything but the active ids', () => {
    const registry = new ModeModifierRegistry();
    registry.register(modifier('a', ['write']));
    registry.register(modifier('b', ['bash']));

    const first = registry.resolve(['a', 'b']);
    const second = registry.resolve(['a', 'b']);

    // Resolution is a pure function of its input ids. There is no profile or
    // permission input to vary, which is the point: the function's signature
    // has no room for them.
    expect(first.tools.blocked.sort()).toEqual(second.tools.blocked.sort());
    expect(first.tools.blocked.sort()).toEqual(['bash', 'write']);
  });

  it('does not consult any ambient state — a fresh registry resolves identically', () => {
    // If resolution depended on a singleton, a second instance could differ.
    const build = (): string[] => {
      const r = new ModeModifierRegistry();
      r.register(modifier('solo', ['write']));
      return r.resolve(['solo']).tools.blocked;
    };
    expect(build()).toEqual(build());
  });

  it('keeps the two axes independent when only the mode set changes', () => {
    // Adding a mode changes the mode axis. It must not disturb the tool
    // permissions the profile and permission layers already decided, which is
    // only observable as: the newly added mode's block lands and the
    // pre-existing resolution is untouched.
    const r = new ModeModifierRegistry();
    r.register(modifier('plan-task', ['write']));
    const before = r.resolve(['plan-task']).tools.blocked;

    r.register(modifier('research', ['bash']));
    const after = r.resolve(['plan-task']).tools.blocked;

    expect(after).toEqual(before);
    expect(r.resolve(['plan-task', 'research']).tools.blocked.sort()).toEqual(['bash', 'write']);
  });
});
