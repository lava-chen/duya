/**
 * Module registry + split-parity tests — Plan 551 Phase 1.
 *
 * Locks the contract introduced by the prompt module registry:
 *
 *  1. Registry integrity — every `MODULES[*].path` loads and renders.
 *  2. Params merge — `renderModule` params override the base mapper slots.
 *  3. `staticModules` normalization — module references flow through the
 *     legacy `SectionDef` machinery (profile gating, cache keying).
 *  4. Split parity — the 10 content modules joined with '\n\n' reproduce
 *     the monolith `general/system-prompt.md.hbs` render byte-for-byte for
 *     every context variant. The `duyaDesktopContext` and Repl-mode tools
 *     blocks collapse to '' in the module path when their `{{#if}}` gates
 *     are off, while the monolith leaves stray blank-line residue behind;
 *     those two variants are compared after blank-line normalization
 *     (documented Phase 1 whitespace artifact, content still locked).
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

/** General config's static assembly order (mirrors the monolith layout). */
const GENERAL_ORDER: ModuleName[] = [
  'identity',
  'system',
  'destructiveActions',
  'configProtection',
  'communication',
  'tools',
  'tasks',
  'skillUsage',
  'duyaDesktopContext',
  'finalAnswer',
];

const MONOLITH = 'general/system-prompt.md.hbs';

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

/** Render the monolith (Plan 550 1b path). */
function renderMonolith(system: HbsPromptSystem, ctx: PromptContext): string {
  return system.renderStaticTemplate(MONOLITH, ctx).trim();
}

/** Render the module assembly (Plan 551 staticModules path semantics). */
function renderModules(system: HbsPromptSystem, ctx: PromptContext): string {
  return GENERAL_ORDER
    .map(name => system.renderModule(name, ctx).trim())
    .filter(rendered => rendered !== '')
    .join('\n\n');
}

/** Collapse 3+ consecutive newlines so blank-line residue does not matter. */
function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

describe('prompt module registry', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  });

  it('exposes one entry per authored module with a loadable asset path', () => {
    expect(Object.keys(MODULES).sort()).toEqual(
      [
        'communication',
        'configProtection',
        'destructiveActions',
        'duyaDesktopContext',
        'finalAnswer',
        'identity',
        'project',
        'projectContinuity',
        'projectInstructions',
        'skillUsage',
        'system',
        'tasks',
        'tools',
      ].sort(),
    );
    for (const [name, def] of Object.entries(MODULES)) {
      expect(def.path, name).toMatch(/^modules\/[a-z-]+\.hbs$/);
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

describe('PromptSystem staticModules normalization', () => {
  function buildSystem(profile?: { disableSections?: string[] }): PromptSystem {
    return new PromptSystem(
      {
        name: 'module-test',
        staticSections: [],
        staticModules: [
          { module: 'system' },
          { module: 'tasks', name: 'tasksAlias' },
          { module: 'duyaDesktopContext' },
        ],
        dynamicSections: [],
      },
      profile,
    );
  }

  function baseContext(): PromptContext {
    return context();
  }

  it('normalizes module references into named cached sections', async () => {
    const system = buildSystem();
    const sections = system.getStaticSections(baseContext());
    expect(sections.map(s => s.name)).toEqual(['system', 'tasksAlias', 'duyaDesktopContext']);
    const resolved = await Promise.all(sections.map(s => Promise.resolve(s.compute())));
    expect(resolved[0]).toContain('# System');
    expect(resolved[1]).toContain('# Doing tasks');
    // Desktop gate off (no duya_cli) → empty render collapses to null.
    expect(resolved[2]).toBeNull();
  });

  it('respects profile gating via isSectionEnabled', () => {
    const system = buildSystem({ disableSections: ['system'] });
    const sections = system.getStaticSections(baseContext());
    expect(sections.map(s => s.name)).toEqual(['tasksAlias', 'duyaDesktopContext']);
  });

  it('honours enabledWhen config gates by collapsing to null', async () => {
    const system = new PromptSystem({
      name: 'module-gate-test',
      staticSections: [],
      staticModules: [
        { module: 'system', enabledWhen: ctx => ctx.enabledTools.has('duya_cli') },
      ],
      dynamicSections: [],
    });
    const off = system.getStaticSections(context());
    expect(off.map(s => s.name)).toEqual(['system']);
    expect(await Promise.resolve(off[0].compute())).toBeNull();
  });
});

describe('module split parity vs monolith', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  });

  const parityCases: Array<[string, ReturnType<typeof context>]> = [
    ['desktop on (win32, repl off)', context({
      enabledTools: new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'duya_cli']),
    })],
    ['desktop on, repl on with todo tool', context({
      enabledTools: new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'duya_cli']),
      isReplModeEnabled: true,
    })],
    ['desktop on, posix platform', context({
      platform: 'linux',
      enabledTools: new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'duya_cli']),
    })],
    ['desktop on, output style active', context({
      outputStyleConfig: { name: 'concise' },
      enabledTools: new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'duya_cli']),
    })],
    ['desktop on, embedded search tools', context({
      hasEmbeddedSearchTools: true,
      enabledTools: new Set(['Read', 'Edit', 'Write', 'Bash', 'TodoWrite', 'duya_cli']),
    })],
  ];

  for (const [label, ctx] of parityCases) {
    it(`reproduces the monolith render byte-for-byte: ${label}`, () => {
      expect(renderModules(system, ctx)).toBe(renderMonolith(system, ctx));
    });
  }

  const residueCases: Array<[string, ReturnType<typeof context>]> = [
    // Desktop gate off: the monolith keeps one stray blank line where the
    // gated block vanished; the module path drops the empty element.
    ['desktop gate off (no duya_cli)', context()],
    // Repl mode without a todo tool: the tools module collapses to '' while
    // the monolith keeps the surrounding blank-line residue.
    ['repl on without todo tool', context({
      isReplModeEnabled: true,
      enabledTools: new Set(['Read', 'Bash', 'duya_cli']),
    })],
  ];

  for (const [label, ctx] of residueCases) {
    it(`matches the monolith modulo blank-line residue: ${label}`, () => {
      const monolith = renderMonolith(system, ctx);
      const modules = renderModules(system, ctx);
      // Content is identical; only the monolith's stray blank lines where
      // the gated block vanished differ (Phase 1 whitespace artifact).
      expect(normalizeBlankLines(modules)).toBe(normalizeBlankLines(monolith));
    });
  }
});
