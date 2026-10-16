/**
 * The catalog is only useful if it stays TRUE. These tests fail when the
 * definitions drift apart, which is the failure mode the whole package exists
 * to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_SPECS,
  canonicalName,
  describeSpec,
  findSpec,
  formatSpecLabel,
  specsForSurface,
  type CommandSurface,
} from '../src/index.js';

describe('command catalog integrity', () => {
  it('has no duplicate canonical names', () => {
    const names = COMMAND_SPECS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never lets an alias shadow another command', () => {
    const canonical = new Set(COMMAND_SPECS.map((spec) => spec.name));
    const aliases = new Map<string, string>();
    for (const spec of COMMAND_SPECS) {
      for (const alias of spec.aliases ?? []) {
        expect(canonical.has(alias), `${alias} is also a canonical name`).toBe(false);
        const owner = aliases.get(alias);
        expect(owner === undefined || owner === spec.name, `${alias} claimed twice`).toBe(true);
        aliases.set(alias, spec.name);
      }
    }
  });

  it('gives every command a description in both locales it claims to have', () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.description.length, `${spec.name} description`).toBeGreaterThan(0);
      if (spec.descriptionZh !== undefined) {
        expect(spec.descriptionZh.length, `${spec.name} descriptionZh`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every desktop command a short title in both locales', () => {
    // The Desktop popup renders `label`; a missing one degrades the row to the
    // bare command name with no warning, so it is pinned here instead.
    for (const spec of specsForSurface('desktop')) {
      expect(spec.label?.length, `${spec.name} label`).toBeGreaterThan(0);
      expect(spec.labelZh?.length, `${spec.name} labelZh`).toBeGreaterThan(0);
      expect(spec.label, `${spec.name} label`).not.toBe(spec.description);
    }
  });

  it('gives every command at least one surface — a definition nobody can run is a bug', () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.surfaces.length, `${spec.name} surfaces`).toBeGreaterThan(0);
    }
  });

  it('declares every subcommand as a lower-case token', () => {
    for (const spec of COMMAND_SPECS) {
      for (const sub of spec.subcommands ?? []) {
        expect(sub).toBe(sub.toLowerCase());
        expect(sub.trim()).toBe(sub);
      }
    }
  });
});

describe('command catalog lookup', () => {
  it('resolves names and aliases regardless of surface', () => {
    expect(findSpec('model')?.name).toBe('model');
    expect(findSpec('usage')?.name).toBe('cost');
    expect(findSpec('  Quit ')?.name).toBe('exit');
    expect(canonicalName('title')).toBe('rename');
  });

  it('resolves a command the surface does not advertise (rule 1)', () => {
    // /compact is desktop-only, yet the CLI can still resolve it by name.
    expect(findSpec('compact')?.surfaces).toEqual(['desktop']);
    expect(findSpec('compact')).toBeDefined();
    expect(specsForSurface('cli').some((spec) => spec.name === 'compact')).toBe(false);
  });

  it('returns nothing for an unknown token', () => {
    expect(findSpec('definitely-not-a-command')).toBeUndefined();
    expect(canonicalName('nope')).toBeUndefined();
  });
});

describe('command catalog per-surface views', () => {
  it('gives each surface its own advertised set', () => {
    const desktop = specsForSurface('desktop').map((spec) => spec.name);
    const cli = specsForSurface('cli').map((spec) => spec.name);
    expect(desktop).toContain('review');
    expect(cli).not.toContain('review');
    expect(cli).toContain('fork');
    expect(desktop).not.toContain('fork');
  });

  it('hides session-scoped commands when there is no session', () => {
    const names = specsForSurface('cli', { hasSession: false }).map((spec) => spec.name);
    expect(names).not.toContain('compact');
    expect(names).not.toContain('context');
    expect(names).toContain('help');
  });

  it('only keeps busy-safe commands while a turn streams', () => {
    const names = specsForSurface('cli', { busy: true }).map((spec) => spec.name);
    expect(names).toContain('stop');
    expect(names).toContain('status');
    expect(names).not.toContain('model');
    expect(names).not.toContain('export');
  });

  it('preserves declaration order so the popup order is stable', () => {
    const cli = specsForSurface('cli').map((spec) => spec.name);
    const order = COMMAND_SPECS.map((spec) => spec.name).filter((name) => cli.includes(name));
    expect(cli).toEqual(order);
  });

  it('never advertises the same command twice on one surface', () => {
    for (const surface of ['desktop', 'cli'] as CommandSurface[]) {
      const names = specsForSurface(surface).map((spec) => spec.name);
      expect(new Set(names).size, surface).toBe(names.length);
    }
  });
});

describe('command catalog desktop parity', () => {
  // The Desktop composer accepted these spellings before the catalog existed
  // (`apps/desktop/src/renderer/lib/commands/registry.ts`). If the shared
  // definition ever drops one, `/reset` and friends would stop resolving there
  // for nobody better than "the definition got tidier".
  //
  // A literal list on purpose: a test generated from the catalog would assert
  // that the catalog agrees with itself.
  it('keeps resolving every alias the Desktop composer already accepted', () => {
    const preExisting: readonly [string, string][] = [
      ['reset', 'new'],
      ['?', 'help'],
      ['usage', 'cost'],
      ['summary', 'recap'],
      ['catchup', 'recap'],
      ['sessions', 'resume'],
      ['title', 'rename'],
      ['permissions', 'permission'],
      ['research', 'deep-research'],
    ];
    for (const [token, expected] of preExisting) {
      expect(findSpec(token)?.name, `/${token}`).toBe(expected);
    }
  });

  it('still resolves every command the Desktop registry listed', () => {
    const desktopOnly = [
      'clear', 'compact', 'export', 'help', 'status', 'cost', 'recap', 'model',
      'review', 'simplify', 'doctor', 'commit', 'plan', 'goal', 'resume',
      'rename', 'stop', 'queue', 'login', 'logout', 'permission', 'effort',
      'context', 'transcript', 'skills', 'deep-research', 'diff', 'loop',
      'memory', 'mcp', 'add-dir', 'image', 'btw', 'copy', 'stop',
    ];
    for (const name of desktopOnly) {
      expect(findSpec(name), name).toBeDefined();
      expect(findSpec(name)?.surfaces, name).toContain('desktop');
    }
  });

  it('does not claim desktop support for commands it lacks an executor for', () => {
    // `fork`/`archive`/`delete` exist for the CLI only. If someone later writes a
    // Desktop executor for one, the honest move is to add it here, not to let
    // the popup offer a command that only forwards to the model.
    for (const name of ['fork', 'archive', 'delete', 'exit']) {
      expect(findSpec(name)?.surfaces, name).not.toContain('desktop');
    }
  });

  it('marks exactly the three commands the gateway adapters serve', () => {
    // Gateway is a Desktop-side transport with no menu of its own, so it rides
    // as a flag. These are the same three the old registry listed as
    // platforms: ['app', 'gateway'].
    const gateway = COMMAND_SPECS.filter((spec) => spec.gateway === true).map((spec) => spec.name);
    expect(gateway).toEqual(['new', 'help', 'status']);
  });
});

describe('command catalog rendering', () => {
  it('renders a label with args and aliases', () => {
    expect(formatSpecLabel(findSpec('permission')!)).toBe('/permission [ask|auto|bypass], /permissions');
    expect(formatSpecLabel(findSpec('help')!)).toBe('/help, /?');
    expect(formatSpecLabel(findSpec('model')!)).toBe('/model [model]');
  });

  it('falls back to English when a command has no Chinese description', () => {
    // Constructed rather than borrowed from the catalog: every real command
    // is translated today, and this asserts the fallback, not the data.
    const untranslated = {
      name: 'x',
      description: 'English only',
      category: 'info',
      surfaces: ['cli'],
    } as const;
    expect(describeSpec(untranslated, 'zh')).toBe('English only');
    expect(describeSpec(findSpec('fork')!, 'zh')).toBe('把当前会话分叉成新会话');
    expect(describeSpec(findSpec('model')!, 'en')).toBe(findSpec('model')!.description);
  });
});
