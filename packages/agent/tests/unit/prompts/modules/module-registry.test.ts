/**
 * Module registry + PromptSystem normalization tests — Plan 551.
 *
 * Locks the contract introduced by the prompt module registry:
 *
 *  1. Registry integrity — the core general module set exists and every
 *     `MODULES[*].path` loads and renders.
 *  2. Params merge — `renderModule` params override the base mapper slots.
 *  3. `staticModules` normalization — module references flow through the
 *     SectionDef machinery: profile gating, config-side enabledWhen gates,
 *     prompt-cache keying, and empty-collapse.
 *
 * Byte-level parity against the Plan 550 monolith was locked during the
 * Phase 1/2 migrations; the monolith is retired, and content is now
 * pinned by the per-profile suites (general assembly, code, gateway,
 * research, project modules).
 *
 * @see docs/exec-plans/active/551-prompt-module-flatten.md
 */

import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MODULES } from '../../../../src/prompts/modules/registry.js';
import type { ModuleName } from '../../../../src/prompts/modules/registry.js';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { PromptSystem } from '../../../../src/prompts/PromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function context(
  overrides: Partial<{
    platform: string;
    outputStyleConfig: unknown;
    enabledTools: Set<string>;
    hasEmbeddedSearchTools: boolean;
    isReplModeEnabled: boolean;
  }> = {},
): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: overrides.platform ?? 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools:
      overrides.enabledTools ??
      new Set<string>([
        'Read', 'Edit', 'Write', 'Glob', 'Grep',
        'Bash', 'TodoWrite', 'Task', 'AskUserQuestion',
      ]),
    sessionStartTime: 0,
    outputStyleConfig: overrides.outputStyleConfig ?? null,
    hasEmbeddedSearchTools: overrides.hasEmbeddedSearchTools ?? false,
    isReplModeEnabled: overrides.isReplModeEnabled ?? false,
  } as PromptContext;
}

describe('prompt module registry', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  });

  it('exposes the core general module set, and every entry loads', () => {
    // The general assembly depends on these ten; the registry may hold
    // additional profile-specific modules (identityCoding, rules, …).
    const core = [
      'configProtection',
      'destructiveActions',
      'duyaDesktopContext',
      'finalAnswer',
      'identity',
      'skillUsage',
      'system',
      'tasks',
      'tools',
    ];
    const keys = Object.keys(MODULES);
    for (const name of core) {
      expect(keys, name).toContain(name);
    }
    for (const [name, def] of Object.entries(MODULES)) {
      // Plan 550 1c: dynamic sections are also reachable via the registry
      // (per-module render with the same handlebars infra as authored
      // content), so the path regex accepts either tree.
      expect(def.path, name).toMatch(/^(modules|dynamic)\/[a-z-]+\.hbs$/);
      // loadHbsAssetSync throws when the asset is missing — this asserts
      // every registry entry points at a real file.
      expect(() => system.renderModule(name as ModuleName, context()), name).not.toThrow();
    }
  });

  it('renderModule merges params over the base mapper slots', () => {
    const out = system.renderModule('identity', context(), {
      cyber_risk_instruction: 'OVERRIDDEN-SLOT-MARKER',
    });
    expect(out).toContain('OVERRIDDEN-SLOT-MARKER');
    expect(out).toContain('# Identity');
  });

  it('renders the desktop context module empty when the surface gate is off', () => {
    const out = system.renderModule('duyaDesktopContext', context());
    expect(out.trim()).toBe('');
  });

  it('renders the desktop context module with automations when duya_cli is present', () => {
    const desktopCtx = context({
      enabledTools: new Set(['Read', 'duya_cli']),
    });
    const out = system.renderModule('duyaDesktopContext', desktopCtx);
    expect(out).toContain('# Duya Desktop context');
    expect(out).toContain('## Automations');
  });
});

describe('PromptSystem module reference normalization', () => {
  function buildSystem(profile?: { disableSections?: string[] }): PromptSystem {
    return new PromptSystem(
      {
        name: 'module-test',
        sections: [
          { module: 'system' },
          { module: 'tasks', name: 'tasksAlias' },
          { module: 'duyaDesktopContext' },
        ],
      },
      profile,
    );
  }

  function baseContext(): PromptContext {
    return context();
  }

  it('normalizes module references into named cached sections', async () => {
    const system = buildSystem();
    const sections = system.getAllSections(baseContext());
    expect(sections.map(s => s.name)).toEqual(['system', 'tasksAlias', 'duyaDesktopContext']);
    const resolved = await Promise.all(sections.map(s => Promise.resolve(s.compute())));
    expect(resolved[0]).toContain('# System');
    expect(resolved[1]).toContain('# Doing tasks');
    // Desktop gate off (no duya_cli) → empty render collapses to null.
    expect(resolved[2]).toBeNull();
  });

  it('respects profile gating via isSectionEnabled', () => {
    const system = buildSystem({ disableSections: ['system'] });
    const sections = system.getAllSections(baseContext());
    expect(sections.map(s => s.name)).toEqual(['tasksAlias', 'duyaDesktopContext']);
  });

  it('honours enabledWhen config gates by collapsing to null', async () => {
    const system = new PromptSystem({
      name: 'module-gate-test',
      sections: [
        { module: 'system', enabledWhen: ctx => ctx.enabledTools.has('duya_cli') },
      ],
    });
    const off = system.getAllSections(context());
    expect(off.map(s => s.name)).toEqual(['system']);
    expect(await Promise.resolve(off[0].compute())).toBeNull();
  });
});
