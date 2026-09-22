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
 *   + this config's volatile sections (the runtime backbone a bot still needs)
 *   + the bot section catalog (via BotPromptAssembly.renderSections).
 *
 * These assertions lock the volatile-section selection so regressions like
 * "a cut section re-added" or "the static set silently populated" are caught
 * at the config layer. The static half lives in BOT_BASIC_SYSTEM_PROMPT, so
 * the unified `sections` list contains only every-call (volatile) entries.
 */
describe('botConfig', () => {
  it('keeps the unified sections list scoped to volatile runtime backbone only', () => {
    const everyCall = botConfig.sections.filter((s) => s.cachePolicy === 'every-call');
    expect(everyCall.map((s) => s.name ?? s.module)).toEqual([
      'platform', 'environment', 'mcp', 'skills', 'scratchpad',
      'sessionGuidance',
    ]);
  });

  it('contains no static / once-cached entries (base comes from basicPrompt.ts)', () => {
    const cached = botConfig.sections.filter((s) => s.cachePolicy === 'once');
    expect(cached).toEqual([]);
  });

  it('excludes general memory (superseded by bot memory tiers)', () => {
    const names = botConfig.sections.map((s) => s.name ?? s.module);
    expect(names).not.toContain('memory');
  });

  it('excludes host-side / vision dynamic sections not applicable to bots', () => {
    const names = botConfig.sections.map((s) => s.name ?? s.module);
    for (const cut of ['sessionSearch', 'visionGuidelines', 'visualVerification']) {
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