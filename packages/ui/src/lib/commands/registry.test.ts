/**
 * The Desktop registry is a PROJECTION of `@duya/command-catalog`. These tests
 * fail when the two drift, because a hand-maintained copy of the metadata is
 * exactly what this package was created to delete.
 */
import { describe, expect, it } from 'vitest';

import { findSpec, specsForSurface } from '@duya/command-catalog';

import {
  COMMAND_REGISTRY,
  getCommandNamesForPlatform,
  getCommandsByCategory,
  getCommandsForPlatform,
  isKnownCommand,
  resolveCommand,
} from './registry';
import { hasCommandExecutor } from './executors/registry';
// Side effect: registers every domain's executors, exactly as production does
// through `executors/index.ts`.
import './executors/index';

describe('desktop registry derivation', () => {
  it('lists exactly the commands the catalog advertises to the desktop', () => {
    expect(COMMAND_REGISTRY.map((cmd) => cmd.name)).toEqual(
      specsForSurface('desktop').map((spec) => spec.name),
    );
  });

  it('preserves the catalog presentation order', () => {
    const names = COMMAND_REGISTRY.map((cmd) => cmd.name);
    const declared = specsForSurface('desktop').map((spec) => spec.name);
    // Not `toEqual` on the whole array — that is the previous test. This one
    // fails if someone re-sorts the array here, which would silently reorder
    // the popup while every lookup still worked.
    expect(names).toEqual([...declared].sort((a, b) => declared.indexOf(a) - declared.indexOf(b)));
    expect(names[0]).not.toBe([...names].sort()[0]);
  });

  it('carries every spec field across without inventing or dropping one', () => {
    for (const cmd of COMMAND_REGISTRY) {
      const spec = findSpec(cmd.name);
      expect(spec, cmd.name).toBeDefined();
      expect(cmd.description, cmd.name).toBe(spec?.description);
      expect(cmd.descriptionZh, cmd.name).toBe(spec?.descriptionZh);
      expect(cmd.label, cmd.name).toBe(spec?.label);
      expect(cmd.labelZh, cmd.name).toBe(spec?.labelZh);
      expect(cmd.category, cmd.name).toBe(spec?.category);
      expect(cmd.argsHint ?? '', cmd.name).toBe(spec?.argsHint ?? '');
      expect([...(cmd.aliases ?? [])], cmd.name).toEqual([...(spec?.aliases ?? [])]);
      expect([...(cmd.subcommands ?? [])], cmd.name).toEqual([...(spec?.subcommands ?? [])]);
      expect(cmd.requiresSession, cmd.name).toBe(spec?.requiresSession === true);
    }
  });

  it('serves gateway for exactly the three commands the adapters handle', () => {
    expect(getCommandsForPlatform('gateway').map((cmd) => cmd.name)).toEqual([
      'new',
      'help',
      'status',
    ]);
    for (const cmd of COMMAND_REGISTRY) {
      const expected = findSpec(cmd.name)?.gateway === true;
      expect(cmd.platforms?.includes('gateway') ?? false, cmd.name).toBe(expected);
    }
  });
});

describe('desktop registry lookup', () => {
  it('resolves names and aliases, with or without the slash', () => {
    expect(resolveCommand('/model')?.name).toBe('model');
    expect(resolveCommand('MODEL')?.name).toBe('model');
    expect(resolveCommand('usage')?.name).toBe('cost');
    expect(resolveCommand('  Usage  ')?.name).toBe('cost');
    expect(resolveCommand('definitely-not-a-command')).toBeNull();
  });

  it('resolves a command the popup does not advertise (rule 1)', () => {
    // `fork` is CLI-only. The desktop popup never shows it, but a user who types
    // it should get "not available here" from the dispatch layer rather than
    // having `/fork ...` forwarded to the model as prose.
    expect(specsForSurface('desktop').some((spec) => spec.name === 'fork')).toBe(false);
    expect(resolveCommand('/fork')).not.toBeNull();
  });

  it('keeps the platform token sets disjoint per platform', () => {
    const app = getCommandNamesForPlatform('app');
    const gateway = getCommandNamesForPlatform('gateway');
    expect(gateway.size).toBeLessThan(app.size);
    for (const token of gateway) expect(app.has(token)).toBe(true);
    expect(isKnownCommand('/help', 'gateway')).toBe(true);
    expect(isKnownCommand('/model', 'gateway')).toBe(false);
  });

  it('groups by category without losing or duplicating a command', () => {
    const grouped = getCommandsByCategory('app');
    const flat = [...grouped.values()].flat().map((cmd) => cmd.name);
    expect(flat).toEqual(COMMAND_REGISTRY.map((cmd) => cmd.name));
    expect(new Set(flat).size).toBe(flat.length);
    expect(grouped.get('session')?.map((cmd) => cmd.name)).toContain('new');
    expect(grouped.get('exit')).toBeUndefined();
  });
});

describe('desktop commands have an executor', () => {
  // The rule the catalog documents as "not advertised-but-unrunnable is
  // forbidden". Before this test, `review` / `simplify` / `doctor` /
  // `commit` sat in the catalog with no executor at all — the popup offered
  // them and the composer turned them into a prompt naming a skill duya does
  // not ship.
  //
  // A literal list on purpose: a test generated from the registry would
  // assert the registry agrees with itself.
  const DESKTOP_EXECUTORS = [
    'new', 'resume', 'rename', 'clear', 'compact', 'export', 'copy', 'stop',
    'queue', 'model', 'permission', 'effort', 'login', 'logout', 'help',
    'status', 'cost', 'context', 'transcript', 'recap', 'skills', 'plan',
    'goal', 'deep-research', 'diff', 'loop', 'memory', 'mcp', 'add-dir',
    'image', 'btw', 'app', 'apps', 'plugin', 'workflow', 'doctor', 'init',
  ];

  it('registers an executor for every command the catalog advertises', () => {
    const declared = specsForSurface('desktop').map((spec) => spec.name);
    const missing = declared.filter((name) => !hasCommandExecutor(name));
    expect(missing).toEqual([]);
  });

  it('registers exactly the commands this surface owns', () => {
    // The alias entries (`usage`, `title`, `sessions`, `permissions`,
    // `research`) are dispatch keys, not commands of their own — they resolve
    // through the canonical name and are not in the catalog.
    const extra = DESKTOP_EXECUTORS.filter((name) => !specsForSurface('desktop').some((spec) => spec.name === name));
    expect(extra).toEqual([]);
  });
});
