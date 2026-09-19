/**
 * Dynamic-sections hbs parity tests — Plan 550 1c.
 *
 * For each section migrated to .hbs in this commit, render the legacy
 * TS compute and the new hbs path on the same input and assert the
 * output strings are equal. This is the byte-level lock the plan
 * requires; regressions fail this test before reaching production.
 *
 * Sections covered: language, outputStyle, platform, mcp, visionGuidelines.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { getLanguageSection } from '../../../../src/prompts/sections/dynamic/language.js';
import { getOutputStyleSection } from '../../../../src/prompts/sections/dynamic/outputStyle.js';
import { getPlatformSection } from '../../../../src/prompts/sections/dynamic/platform.js';
import { getMcpInstructionsSection } from '../../../../src/prompts/sections/dynamic/mcpInstructions.js';
import { getVisionGuidelinesSection } from '../../../../src/prompts/sections/dynamic/visionGuidelines.js';
import { getVisualVerificationSection } from '../../../../src/prompts/sections/dynamic/visualVerification.js';
import { getScratchpadSection } from '../../../../src/prompts/sections/dynamic/scratchpad.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function baseContext(overrides: Partial<{
  language: string;
  communicationPlatform: string;
  outputStyleConfig: unknown;
  enabledTools: Set<string>;
  mcpServers: unknown[];
}> = {}) {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: overrides.enabledTools ?? new Set<string>([
      'Read', 'Edit', 'Write', 'Bash', 'TodoWrite',
    ]),
    sessionStartTime: 0,
    language: overrides.language,
    communicationPlatform: overrides.communicationPlatform,
    outputStyleConfig: overrides.outputStyleConfig,
    mcpServers: overrides.mcpServers,
  };
}

let system: HbsPromptSystem;

beforeEach(() => {
  system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
});

async function parity(
  hbsPath: string,
  tsFn: (ctx: any) => string | null | Promise<string | null>,
  ctx: any,
) {
  const ts = await tsFn(ctx);
  const hbs = system.renderStaticTemplate(hbsPath, ctx).trim();
  // Empty hbs maps to null to match the legacy `return null` short-circuits.
  const hbsNormalised = hbs === '' ? null : hbs;
  expect(hbsNormalised).toBe(ts);
}

describe('dynamic sections hbs byte-level parity', () => {
  it('language section matches when language is set', async () => {
    await parity(
      'dynamic/language.hbs',
      getLanguageSection,
      baseContext({ language: 'zh-CN' }),
    );
  });

  it('language section matches when language is absent', async () => {
    await parity(
      'dynamic/language.hbs',
      getLanguageSection,
      baseContext({ language: undefined }),
    );
  });

  it('outputStyle section matches when configured', async () => {
    await parity(
      'dynamic/output-style.hbs',
      getOutputStyleSection,
      baseContext({
        outputStyleConfig: {
          name: 'concise',
          prompt: 'Answer in one sentence whenever possible.',
        },
      }),
    );
  });

  it('outputStyle section matches when prompt is empty', async () => {
    await parity(
      'dynamic/output-style.hbs',
      getOutputStyleSection,
      baseContext({
        outputStyleConfig: { name: 'concise', prompt: '   ' },
      }),
    );
  });

  it('outputStyle section matches when config is null', async () => {
    await parity(
      'dynamic/output-style.hbs',
      getOutputStyleSection,
      baseContext({ outputStyleConfig: null }),
    );
  });

  it('platform section matches when hint is present', async () => {
    await parity(
      'dynamic/platform.hbs',
      getPlatformSection,
      baseContext({ communicationPlatform: 'cli' }),
    );
  });

  it('platform section matches when hint is absent', async () => {
    await parity(
      'dynamic/platform.hbs',
      getPlatformSection,
      baseContext({ communicationPlatform: 'unknown-platform' }),
    );
  });

  it('mcp-instructions section matches with one connected server', async () => {
    await parity(
      'dynamic/mcp-instructions.hbs',
      getMcpInstructionsSection,
      baseContext({
        mcpServers: [
          { name: 'github', instructions: 'Use this to read issues.' },
        ],
      }),
    );
  });

  it('mcp-instructions section matches with multiple servers', async () => {
    await parity(
      'dynamic/mcp-instructions.hbs',
      getMcpInstructionsSection,
      baseContext({
        mcpServers: [
          { name: 'github', instructions: 'Use this to read issues.' },
          { name: 'slack', instructions: 'Channel ops.' },
          { name: 'no-instructions' }, // filter must drop this
        ],
      }),
    );
  });

  it('mcp-instructions section matches when no servers are connected', async () => {
    await parity(
      'dynamic/mcp-instructions.hbs',
      getMcpInstructionsSection,
      baseContext({ mcpServers: [] }),
    );
  });

  it('vision-guidelines section matches when vision tool is enabled', async () => {
    await parity(
      'dynamic/vision-guidelines.hbs',
      getVisionGuidelinesSection,
      baseContext({
        enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'vision']),
      }),
    );
  });

  it('vision-guidelines section matches when vision tool is absent', async () => {
    await parity(
      'dynamic/vision-guidelines.hbs',
      getVisionGuidelinesSection,
      baseContext({
        enabledTools: new Set<string>(['Read', 'Edit', 'Write']),
      }),
    );
  });

  it('visual-verification section matches when vision tool is enabled', async () => {
    await parity(
      'dynamic/visual-verification.hbs',
      getVisualVerificationSection,
      baseContext({
        enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'vision']),
      }),
    );
  });

  it('visual-verification section matches when vision tool is absent', async () => {
    await parity(
      'dynamic/visual-verification.hbs',
      getVisualVerificationSection,
      baseContext({
        enabledTools: new Set<string>(['Read', 'Edit', 'Write']),
      }),
    );
  });

  it('scratchpad section matches when scratchpadDir is set', async () => {
    await parity(
      'dynamic/scratchpad.hbs',
      getScratchpadSection,
      baseContext({ scratchpadDir: 'C:\\Users\\tester\\.duya\\scratch\\session-1' }),
    );
  });

  it('scratchpad section matches when scratchpadDir is absent', async () => {
    await parity(
      'dynamic/scratchpad.hbs',
      getScratchpadSection,
      baseContext({ scratchpadDir: undefined }),
    );
  });
});