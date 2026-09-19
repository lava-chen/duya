/**
 * Gateway module parity tests — Plan 551 Phase 2.
 *
 * Locks each gateway assembly entry byte-for-byte against the legacy TS
 * section function — including the eight reused general sections that
 * fed the Plan 550 monolith — before the legacy section tree is swept.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import { TOOL_NAMES } from '../../../../src/prompts/types.js';
import { getGatewayIntroSection } from '../../../../src/prompts/gateway/sections/intro.js';
import { getGatewayRoleSection } from '../../../../src/prompts/gateway/sections/gatewayRole.js';
import { getToneAndStyleSection } from '../../../../src/prompts/gateway/sections/toneAndStyle.js';
import { getSystemSection } from '../../../../src/prompts/general/sections/system.js';
import { getCommunicationSection } from '../../../../src/prompts/general/sections/communication.js';
import { getFinalAnswerSection } from '../../../../src/prompts/general/sections/finalAnswer.js';
import { getTasksSection } from '../../../../src/prompts/general/sections/tasks.js';
import { getDestructiveActionsSection } from '../../../../src/prompts/general/sections/destructiveActions.js';
import { getConfigProtectionSection } from '../../../../src/prompts/general/sections/configProtection.js';
import { getToolsSection } from '../../../../src/prompts/general/sections/tools.js';
import { getSkillUsageSection } from '../../../../src/prompts/general/sections/skillUsage.js';
import { getProjectSection } from '../../../../src/prompts/general/sections/project.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function context(overrides: {
  enabledTools?: Set<string>;
  communicationPlatform?: string;
} = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: overrides.enabledTools
      ?? new Set<string>(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']),
    sessionStartTime: 0,
    communicationPlatform: overrides.communicationPlatform,
  } as PromptContext;
}

const BASE_TOOLS = new Set<string>(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
const WITH_SKILL = new Set<string>([...BASE_TOOLS, TOOL_NAMES.SKILL]);

describe('gateway modules parity vs legacy TS sections', () => {
  // Both sides trimmed — same discipline as code-modules.test.ts.
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  const rendered = (name: Parameters<HbsPromptSystem['renderModule']>[0], ctx: PromptContext, params?: Record<string, unknown>) =>
    system.renderModule(name, ctx, params).trim();

  it('intro renders the platform display name (known and fallback)', () => {
    const weixin = context({ communicationPlatform: 'weixin' });
    const unknown = context({ communicationPlatform: 'slack' });
    const absent = context();
    expect(rendered('intro', weixin)).toBe(getGatewayIntroSection(weixin).trim());
    expect(rendered('intro', unknown)).toBe(getGatewayIntroSection(unknown).trim());
    expect(rendered('intro', absent)).toBe(getGatewayIntroSection(absent).trim());
  });

  it('gateway-role renders statically', () => {
    expect(rendered('gatewayRole', context())).toBe(getGatewayRoleSection().trim());
  });

  it('tone-and-style with the gateway never-analysis param', () => {
    const ctx = context();
    expect(rendered('toneAndStyle', ctx, { tone_never_analysis: true }))
      .toBe(getToneAndStyleSection(ctx).trim());
  });

  it('reused general sections match the legacy functions', () => {
    const ctx = context({ enabledTools: WITH_SKILL });
    expect(rendered('system', ctx)).toBe(getSystemSection(ctx).trim());
    expect(rendered('communication', ctx)).toBe(getCommunicationSection(ctx).trim());
    expect(rendered('finalAnswer', ctx)).toBe(getFinalAnswerSection(ctx).trim());
    expect(rendered('tasks', ctx)).toBe(getTasksSection(ctx).trim());
    expect(rendered('destructiveActions', ctx)).toBe(getDestructiveActionsSection(ctx).trim());
    expect(rendered('configProtection', ctx)).toBe(getConfigProtectionSection(ctx).trim());
    // Gateway's tools text predates the general rework — the legacy layout
    // params keep it byte-identical (bash-warning bullet + 2-space indent).
    expect(rendered('tools', ctx, { tools_bash_warning: true, tools_legacy_indent: true }))
      .toBe(getToolsSection(ctx).trim());
  });

  it('skill-usage honours the SKILL-tool gate via the config normalization', async () => {
    const { PromptSystem } = await import('../../../../src/prompts/PromptSystem.js');
    const gatewaySystem = new PromptSystem({
      name: 'gateway-gate-test',
      staticSections: [],
      staticModules: [
        {
          module: 'skillUsage',
          name: 'skillUsage',
          enabledWhen: (c) => c.enabledTools.has(TOOL_NAMES.SKILL),
        },
      ],
      dynamicSections: [],
    });
    const on = gatewaySystem.getStaticSections(context({ enabledTools: WITH_SKILL }));
    expect(await Promise.resolve(on[0].compute())).not.toBeNull();
    const off = gatewaySystem.getStaticSections(context({ enabledTools: BASE_TOOLS }));
    expect(await Promise.resolve(off[0].compute())).toBeNull();
  });

  it('project composite matches the legacy section', () => {
    const ctx = context();
    expect(rendered('project', ctx)).toBe(getProjectSection(ctx).trim());
  });
});
