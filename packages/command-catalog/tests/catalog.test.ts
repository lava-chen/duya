/**
 * The catalog is only useful if it stays TRUE. These tests fail when the
 * definitions drift apart, which is the failure mode the whole package exists
 * to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_SPECS,
  availableSpecsFor,
  canonicalName,
  commandAvailability,
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
    // /loop is desktop-only, yet the CLI can still resolve it by name.
    expect(findSpec('loop')?.surfaces).toEqual(['desktop']);
    expect(findSpec('loop')).toBeDefined();
    expect(specsForSurface('cli').some((spec) => spec.name === 'loop')).toBe(false);
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
    // Session commands now exist on both surfaces.
    expect(desktop).toContain('diff');
    expect(cli).toContain('diff');
    expect(cli).toContain('compact');
    expect(cli).toContain('btw');
    expect(cli).toContain('fork');
    expect(desktop).not.toContain('fork');
    expect(cli).not.toContain('loop');
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
    // Switching the model mid-turn is not safe — the CLI handler refuses it.
    expect(names).not.toContain('model');
    // So is compacting the conversation: it rewrites the context the running
    // turn is reading from.
    expect(names).not.toContain('compact');
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
    // Every one of these has a Desktop executor. Some of them also exist on
    // the CLI now; the assertion is that the Desktop never lost one.
    const desktopCommands = [
      'clear', 'compact', 'export', 'help', 'status', 'cost', 'recap', 'model',
      'plan', 'goal', 'resume',
      'rename', 'stop', 'queue', 'login', 'logout', 'permission', 'effort',
      'context', 'transcript', 'skills', 'deep-research', 'diff', 'loop',
      'memory', 'mcp', 'add-dir', 'image', 'btw', 'copy', 'stop',
    ];
    for (const name of desktopCommands) {
      expect(findSpec(name), name).toBeDefined();
      expect(findSpec(name)?.surfaces, name).toContain('desktop');
    }
  });

  it('no longer resolves the commands that had no implementation', () => {
    // `review` duplicated `/diff` (both open the code-review panel), and
    // `simplify` / `commit` only ever produced a prompt naming a skill that
    // does not exist. duya ships six `.system` skills — none of them is one of
    // these three. Leaving them resolvable would send the user to a skill
    // that cannot be loaded.
    //
    // `doctor` used to be on this list and no longer is: it was here because
    // it named a skill that does not exist, and PR-4 gave it a real
    // implementation — the shared doctor checks, run from the CLI TUI.
    for (const name of ['review', 'simplify', 'commit']) {
      expect(findSpec(name), name).toBeUndefined();
    }
  });

  it('resolves /doctor, which PR-4 gave a real implementation', () => {
    // The counterpart to the test above: a command that used to be
    // unresolvable because it named a skill that does not exist now has an
    // executor, so the catalog may advertise it.
    const spec = findSpec('doctor');
    expect(spec).toBeDefined();
    expect(spec?.category).toBe('info');
    // Both surfaces run the same shared checks, so both advertise it.
    expect(spec?.surfaces).toEqual(['desktop', 'cli']);
    expect(spec?.requiresSession).not.toBe(true);
    expect(spec?.availableWhileBusy).toBe(true);
  });

  it('resolves /init, which writes into the session\'s checkout', () => {
    const spec = findSpec('init');
    expect(spec).toBeDefined();
    expect(spec?.category).toBe('session');
    expect(spec?.surfaces).toEqual(['desktop', 'cli']);
    // The write lands in the session's own checkout, so there has to be a
    // session to know which checkout that is.
    expect(spec?.requiresSession).toBe(true);
    // It writes a file into the user's repository.
    expect(spec?.availableWhileBusy).toBe(false);
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

describe('command availability', () => {
  it('refuses a session-scoped command when there is no session', () => {
    const spec = findSpec('rename')!;
    const verdict = commandAvailability(spec, { hasSession: false, busy: false });

    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toContain('/rename');
  });

  it('refuses a command that is not safe to run mid-turn', () => {
    // `rename` mutates the conversation, so it declares no
    // `availableWhileBusy`. The reason must name the command and say what to
    // do — a bare "unavailable" teaches the user nothing.
    const spec = findSpec('rename')!;
    const verdict = commandAvailability(spec, { hasSession: true, busy: true });

    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toContain('/rename');
  });

  it('allows a command that declares itself safe while busy', () => {
    const spec = findSpec('status')!;
    expect(spec.availableWhileBusy).toBe(true);
    expect(commandAvailability(spec, { hasSession: true, busy: true }).available).toBe(true);
  });

  it('allows a command that needs neither a session nor a free turn', () => {
    // `/help` declares itself safe while busy and needs no session.
    const spec = findSpec('help')!;
    expect(spec.availableWhileBusy).toBe(true);
    expect(spec.requiresSession).not.toBe(true);
    expect(commandAvailability(spec, { hasSession: false, busy: true }).available).toBe(true);
  });

  it('uses the spec own reason when it declares one', () => {
    const spec = { ...findSpec('rename')!, unavailableReason: '先停止当前回合。' };
    const verdict = commandAvailability(spec, { hasSession: true, busy: true });

    expect(verdict.available === false && verdict.reason).toBe('先停止当前回合。');
  });

  it('lists only the commands a surface can actually run', () => {
    const idle = availableSpecsFor('desktop', { hasSession: true, busy: false });
    const busy = availableSpecsFor('desktop', { hasSession: true, busy: true });

    expect(idle.length).toBeGreaterThan(busy.length);
    // `/status` is safe mid-turn, `/rename` is not.
    expect(busy.map((spec) => spec.name)).toContain('status');
    expect(busy.map((spec) => spec.name)).not.toContain('rename');
    expect(idle.map((spec) => spec.name)).toContain('rename');
  });

  it('keeps a hidden command resolvable — hiding is not the same as removing', () => {
    // The rule the catalog exists to enforce: a command that is unavailable
    // right now is still FOUND by name, so the surface can explain itself
    // instead of forwarding the token to the model as prose.
    expect(findSpec('rename')).toBeDefined();
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
