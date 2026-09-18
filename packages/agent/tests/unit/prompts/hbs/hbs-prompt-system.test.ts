/**
 * HbsPromptSystem tests — Plan 550 step 1b.
 *
 * Smoke + functional-consistency tests for the HbsPromptSystem. The legacy
 * `general/sections/*.ts` chain is the source of truth; the .hbs template
 * under `src/prompts/assets/general/system-prompt.md.hbs` is the new path.
 * We assert that the rendered template contains every section heading and
 * every key sentence that the legacy code emits, so a regression in the
 * template body fails this test before reaching production.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../../../src/prompts/types.js';

const TEMPLATE_PATH = 'general/system-prompt.md.hbs';

function context(overrides: Partial<{
  platform: string;
  shell: string;
  outputStyleConfig: unknown;
  enabledTools: Set<string>;
  hasEmbeddedSearchTools: boolean;
  isReplModeEnabled: boolean;
  projectContinuity: string;
  projectInstructions: string;
}> = {}) {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: overrides.platform ?? 'win32',
    shell: overrides.shell ?? 'powershell',
    modelId: 'test-model',
    enabledTools: overrides.enabledTools ?? new Set<string>([
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash', 'TodoWrite', 'Task', 'AskUserQuestion',
    ]),
    sessionStartTime: 0,
    outputStyleConfig: overrides.outputStyleConfig ?? null,
    hasEmbeddedSearchTools: overrides.hasEmbeddedSearchTools ?? false,
    isReplModeEnabled: overrides.isReplModeEnabled ?? false,
    projectContinuity: overrides.projectContinuity ?? '',
    projectInstructions: overrides.projectInstructions ?? '',
  };
}

describe('HbsPromptSystem', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({
      assetsRoot: resolve(__dirname, '../../../../src/prompts/assets'),
    });
  });

  it('renders the general system-prompt template without throwing', () => {
    const out = system.renderStaticTemplate(TEMPLATE_PATH, context());
    expect(out.length).toBeGreaterThan(1000);
  });

  it('contains every section heading from the legacy sections chain', () => {
    const out = system.renderStaticTemplate(TEMPLATE_PATH, context());
    const expected = [
      '# Identity',
      '## Self-Management',
      '## Multi-Agent Network',
      '# System',
      '# Destructive actions',
      '# Config file protection',
      '# Communication style',
      '## Output efficiency',
      '## Writing',
      '## Technical communication',
      '# Using your tools',
      '# Doing tasks',
      '# Using skills',
      '# Final answer',
      '### Formatting rules',
      '### Reporting version-control actions',
      '### Visualizations',
    ];
    for (const heading of expected) {
      expect(out).toContain(heading);
    }
  });

  it('emits the cyber-risk instruction block from CYBER_RISK_INSTRUCTION', () => {
    const out = system.renderStaticTemplate(TEMPLATE_PATH, context());
    expect(out).toContain('Cybersecurity is a critical concern');
  });

  it('uses the Output Style clause when outputStyleConfig is present', () => {
    const out = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ outputStyleConfig: { name: 'concise' } }),
    );
    expect(out).toContain('according to your "Output Style" below');
    expect(out).not.toContain(
      'with a wide range of tasks including answering questions',
    );
  });

  it('uses the default clause when outputStyleConfig is null', () => {
    const out = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ outputStyleConfig: null }),
    );
    expect(out).toContain(
      'with a wide range of tasks including answering questions',
    );
  });

  it('switches file-link examples for Windows vs POSIX paths', () => {
    const winOut = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ platform: 'win32' }),
    );
    const posixOut = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ platform: 'linux' }),
    );
    expect(winOut).toContain('C:/project/src/app.py');
    expect(winOut).toContain('NEVER add an `/abs/`');
    expect(posixOut).toContain('/abs/path/app.py');
  });

  it('honours the embedded-search-tools flag by suppressing Glob/Grep items', () => {
    const withEmbedded = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ hasEmbeddedSearchTools: true }),
    );
    const withoutEmbedded = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ hasEmbeddedSearchTools: false }),
    );
    expect(withEmbedded).not.toContain('To search for files use');
    expect(withoutEmbedded).toContain('To search for files use');
  });

  it('renders the Repl-mode tools section when isReplModeEnabled is set', () => {
    const replOut = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ isReplModeEnabled: true }),
    );
    expect(replOut).toContain('These tools are helpful for planning your work');
    expect(replOut).not.toContain('You can call multiple tools in parallel');
  });

  it('renders the parallel-call guidance outside Repl mode', () => {
    const out = system.renderStaticTemplate(
      TEMPLATE_PATH,
      context({ isReplModeEnabled: false }),
    );
    expect(out).toContain('You can call multiple tools in parallel');
  });

  it('omits the project sections (they are dynamic, not static)', () => {
    // Project continuity + AGENTS.md index are dynamic sections, appended
    // after the SYSTEM_PROMPT_DYNAMIC_BOUNDARY token. The static template
    // therefore does NOT include them.
    const out = system.renderStaticTemplate(TEMPLATE_PATH, context());
    expect(out).not.toContain('# Project continuity');
    expect(out).not.toContain('# Project instructions');
  });

  it('buildSystemPrompt inserts the dynamic-boundary token between halves', () => {
    const prompt = system.buildSystemPrompt(TEMPLATE_PATH, context(), [
      'dynamic-A',
      'dynamic-B',
    ]);
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(prompt).toContain('dynamic-A');
    expect(prompt).toContain('dynamic-B');
  });

  it('caches the compiled template across calls', () => {
    system.renderStaticTemplate(TEMPLATE_PATH, context());
    system.renderStaticTemplate(TEMPLATE_PATH, context());
    expect(system.cacheHits()).toBe(1);
    expect(system.cacheMisses()).toBe(1);
  });
});