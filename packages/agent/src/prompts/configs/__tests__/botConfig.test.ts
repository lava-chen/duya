import { describe, it, expect } from 'vitest';
import { botConfig } from '../bot.js';
import { PromptsRegistry } from '../../PromptsRegistry.js';
import '../../registry.js'; // side-effect: register general/code/research/gateway/bot configs
import { BOT_BASIC_SYSTEM_PROMPT } from '../../bot/basicPrompt.js';

/**
 * Bot PromptSystem config guards (Plan 474 Path A).
 *
 * A config-driven bot session assembles a self-contained system prompt:
 *   BOT_BASIC_SYSTEM_PROMPT (injected separately as the stable static base)
 *   + this config's dynamic sections (the runtime backbone a bot still needs)
 *   + the bot section catalog (via BotPromptAssembly.renderSections).
 *
 * These assertions lock the dynamic-section selection so regressions like
 * "a cut section re-added" or "the static set silently populated" are caught
 * at the config layer.
 */
describe('botConfig', () => {
  it('keeps the static section set empty (base comes from basicPrompt.ts)', () => {
    expect(botConfig.staticSections).toEqual([]);
  });

  it('keeps only the bot-facing dynamic backbone sections', () => {
    expect(botConfig.dynamicSections.map((s) => s.name)).toEqual([
      'language', 'outputStyle',
      'platform', 'environment', 'mcp', 'skills', 'scratchpad',
      'sessionGuidance',
    ]);
  });

  it('excludes general memory (superseded by bot memory tiers)', () => {
    expect(botConfig.dynamicSections.some((s) => s.name === 'memory')).toBe(false);
  });

  it('excludes host-side / vision dynamic sections not applicable to bots', () => {
    const names = botConfig.dynamicSections.map((s) => s.name);
    for (const cut of ['sessionSearch', 'recentSessions', 'visionGuidelines', 'visualVerification']) {
      expect(names).not.toContain(cut);
    }
  });

  it('re-registers in the PromptsRegistry so _buildSystemPrompt can resolve "bot"', () => {
    const config = PromptsRegistry.getConfig('bot');
    expect(config).toBe(botConfig);
  });

  it('basicPrompt.ts still exports the byte-stable base used as the bot static layer', () => {
    expect(typeof BOT_BASIC_SYSTEM_PROMPT).toBe('string');
    expect(BOT_BASIC_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});