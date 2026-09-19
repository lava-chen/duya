/**
 * Code-profile module parity tests — Plan 551 Phase 2.
 *
 * Locks each code-profile module render byte-for-byte against the legacy
 * TS section function across the conditional dimensions (output style,
 * capability regexes, todo-tool gate, embedded search, duya_cli) before
 * the legacy section tree is swept.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import { getIdentitySection } from '../../../../src/prompts/code/sections/identity.js';
import { getSystemSection } from '../../../../src/prompts/code/sections/system.js';
import { getPersonalitySection } from '../../../../src/prompts/code/sections/personality.js';
import { getWorkingWithTheUserSection } from '../../../../src/prompts/code/sections/workingWithTheUser.js';
import { getRulesSection } from '../../../../src/prompts/code/sections/rules.js';
import { getDuyaDesktopContextSection } from '../../../../src/prompts/sections/duyaDesktopContext.js';
import { getConfigProtectionSection } from '../../../../src/prompts/general/sections/configProtection.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function context(overrides: {
  enabledTools?: Set<string>;
  outputStyleConfig?: unknown;
  hasEmbeddedSearchTools?: boolean;
} = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: overrides.enabledTools
      ?? new Set<string>(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']),
    sessionStartTime: 0,
    outputStyleConfig: overrides.outputStyleConfig ?? null,
    hasEmbeddedSearchTools: overrides.hasEmbeddedSearchTools ?? false,
  } as PromptContext;
}

const BASE_TOOLS = new Set<string>(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
const ALL_CAPABILITY_TOOLS = new Set<string>([
  'Read', 'settings', 'hooks_manager', 'permission_mode', 'compact_context',
]);

describe('code profile modules parity vs legacy TS sections', () => {
  // Both sides are trimmed: the production pipeline trims module renders,
  // and the legacy template literals for configProtection /
  // duyaDesktopContext carry trailing newlines that the module path drops
  // (documented Phase 2 whitespace artifact, content locked byte-for-byte).
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  const rendered = (name: Parameters<HbsPromptSystem['renderModule']>[0], ctx: PromptContext) =>
    system.renderModule(name, ctx).trim();

  it('identity-coding: plain and output-style variants', () => {
    expect(rendered('identityCoding', context()))
      .toBe(getIdentitySection(context()).trim());
    expect(rendered('identityCoding', context({
      outputStyleConfig: { name: 'concise' },
    })))
      .toBe(getIdentitySection(context({ outputStyleConfig: { name: 'concise' } })).trim());
  });

  it('system-coding: no capabilities vs all capabilities', () => {
    expect(rendered('systemCoding', context({ enabledTools: BASE_TOOLS })))
      .toBe(getSystemSection(context({ enabledTools: BASE_TOOLS })).trim());
    expect(rendered('systemCoding', context({
      enabledTools: ALL_CAPABILITY_TOOLS,
    })))
      .toBe(getSystemSection(context({ enabledTools: ALL_CAPABILITY_TOOLS })).trim());
  });

  it('personality and working-with-the-user render statically', () => {
    expect(rendered('personality', context()))
      .toBe(getPersonalitySection(context()).trim());
    expect(rendered('workingWithTheUser', context()))
      .toBe(getWorkingWithTheUserSection(context()).trim());
  });

  it('rules: todo-tool on/off and embedded search on/off', () => {
    const withTodo = context({
      enabledTools: new Set([...BASE_TOOLS, 'TodoWrite']),
    });
    const withoutTodo = context({ enabledTools: BASE_TOOLS });
    const embedded = context({
      enabledTools: new Set([...BASE_TOOLS, 'TodoWrite']),
      hasEmbeddedSearchTools: true,
    });
    expect(rendered('rules', withTodo)).toBe(getRulesSection(withTodo).trim());
    expect(rendered('rules', withoutTodo)).toBe(getRulesSection(withoutTodo).trim());
    expect(rendered('rules', embedded)).toBe(getRulesSection(embedded).trim());
  });

  it('duya-desktop-context-code: automations on/off', () => {
    const withCli = context({ enabledTools: new Set([...BASE_TOOLS, 'duya_cli']) });
    const withoutCli = context({ enabledTools: BASE_TOOLS });
    expect(rendered('duyaDesktopContextCode', withCli))
      .toBe(getDuyaDesktopContextSection(withCli).trim());
    expect(rendered('duyaDesktopContextCode', withoutCli))
      .toBe(getDuyaDesktopContextSection(withoutCli).trim());
  });

  it('config-protection matches the shared legacy section', () => {
    expect(rendered('configProtection', context()))
      .toBe(getConfigProtectionSection(context()).trim());
  });
});
