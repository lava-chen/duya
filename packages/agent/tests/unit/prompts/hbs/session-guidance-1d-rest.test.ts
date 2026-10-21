/**
 * Session guidance .hbs behavior tests — Plan 550 1d-rest → Plan 551.
 *
 * sessionGuidance has 5 conditional paragraphs behind an `{{#if}}` chain
 * in the template, so the conditional matrix is locked per fixture: each
 * scenario asserts the paragraphs that must (not) appear. Byte-level
 * parity against the legacy TS function was locked before the sweep.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function ctxWith(overrides: any = {}) {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>([
      'Read', 'Edit', 'Write',
      'AskUserQuestion', 'task', 'Skill', 'DiscoverSkills',
      'Glob', 'Grep', 'Bash',
    ]),
    sessionStartTime: 0,
    isSkillSearchEnabled: true,
    isForkSubagentEnabled: false,
    isVerificationAgentEnabled: true,
    isNonInteractiveSession: false,
    hasEmbeddedSearchTools: false,
    ...overrides,
  };
}

describe('session-guidance hbs conditional matrix (Plan 551)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  function render(ctx: any): string | null {
    const out = system.renderStaticTemplate('dynamic/session-guidance.hbs', ctx).trim();
    return out === '' ? null : out;
  }

  it('renders most paragraphs when the matching tools exist', () => {
    const out = render(ctxWith());
    expect(out).toContain('# Session-specific guidance');
    expect(out).toContain('Use AskUserQuestion to ask the user questions');
    expect(out).toContain('with specialized agents');
    expect(out).toContain('/<skill-name>');
    expect(out).toContain('DiscoverSkills');
    expect(out).toContain('independent adversarial verification');
    expect(out).toContain('the Glob or Grep directly');
  });

  it('renders only the shell-suggestion paragraph when no relevant tools exist', () => {
    const out = render(ctxWith({ enabledTools: new Set<string>(['Read', 'Edit', 'Write']) }));
    expect(out).toContain('`! <command>`');
    expect(out).not.toContain('AskUserQuestion');
    expect(out).not.toContain('task');
    expect(out).not.toContain('/<skill-name>');
  });

  it('switches to the fork paragraph when fork subagent is enabled', () => {
    const forked = render(ctxWith({ isForkSubagentEnabled: true }));
    expect(forked).toContain('without a subagent_type creates a fork');
    expect(forked).not.toContain('with specialized agents');
    // The directed-search bullet is non-fork-only.
    expect(forked).not.toContain('For simple, directed codebase searches');
  });

  it('switches the search label when embedded search tools are enabled', () => {
    const embedded = render(ctxWith({ hasEmbeddedSearchTools: true }));
    expect(embedded).toContain('`find` or `grep` via the Bash tool directly');
    expect(render(ctxWith())).toContain('the Glob or Grep directly');
  });

  it('omits the shell-suggestion paragraph for non-interactive sessions', () => {
    const out = render(ctxWith({ isNonInteractiveSession: true }));
    expect(out).toContain('Use AskUserQuestion to ask the user questions');
    expect(out).not.toContain('`! <command>`');
  });

  it('omits the discover paragraph when DiscoverSkills is unavailable', () => {
    const out = render(ctxWith({
      enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'AskUserQuestion', 'task', 'Skill']),
    }));
    expect(out).toContain('/<skill-name>');
    expect(out).not.toContain('DiscoverSkills');
  });

  it('omits the verification paragraph when verification agent is disabled', () => {
    const out = render(ctxWith({ isVerificationAgentEnabled: false }));
    expect(out).toContain('/<skill-name>');
    expect(out).not.toContain('independent adversarial verification');
  });
});
