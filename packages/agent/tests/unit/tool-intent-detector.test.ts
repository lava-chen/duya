/**
 * packages/agent/tests/unit/tool-intent-detector.test.ts
 *
 * Plan 418 L2 — tool-intent / action-consistency detector.
 * Covers EN + ZH intent phrases, paragraph scoping, and false-positive
 * control (routine narration must not match).
 */

import { describe, it, expect } from 'vitest';
import {
  matchedToolIntent,
  toolIntentNudge,
} from '../../src/agent/tool-intent-detector.js';

describe('matchedToolIntent', () => {
  it('detects English "let me read" intents', () => {
    expect(matchedToolIntent('Let me read the config file to confirm the setup.')).toBe('read');
    expect(matchedToolIntent('I will run the tests now.')).toBe('run');
    expect(matchedToolIntent("I'll modify the config to add the mcp server.")).toBe('modify');
    expect(matchedToolIntent('Let me search for the relevant files first.')).toBe('search');
  });

  it('detects Chinese intent phrases', () => {
    expect(matchedToolIntent('让我读取这两个配置文件确认一下。')).toBe('read');
    expect(matchedToolIntent('我来修改 config.toml 里的配置。')).toBe('modify');
    expect(matchedToolIntent('现在运行测试验证一下。')).toBe('run');
    expect(matchedToolIntent('接下来搜索一下相关的 mcp 工具。')).toBe('search');
    expect(matchedToolIntent('我先检查当前目录的结构。')).toBe('read');
  });

  it('only judges the last non-empty paragraph', () => {
    const text =
      'Let me explore the repo structure.\n\n' +
      '整体看下来，方案已经清晰，结论如下：\n' +
      '1. 配置已就绪\n2. 无需进一步操作';
    // The last paragraph contains no tool intent → no match despite the
    // first paragraph announcing an action.
    expect(matchedToolIntent(text)).toBeUndefined();
  });

  it('rejects routine narration without a first-person intent phrase', () => {
    expect(matchedToolIntent('Once the tests settle I will iterate on the output.')).toBeUndefined();
    expect(matchedToolIntent('The script runs fine now; the build is green.')).toBeUndefined();
    expect(matchedToolIntent('我运行了测试，结果都通过了。')).toBeUndefined();
    expect(matchedToolIntent('刚才读取了配置，内容如下。')).toBeUndefined();
  });

  it('rejects intents that already completed or are ambiguous', () => {
    // Past tense / completion narration.
    expect(matchedToolIntent('I ran the tests and they passed.')).toBeUndefined();
    // Intent verb too far from the action (long qualification between them).
    expect(
      matchedToolIntent(
        'Let me first carefully review all the previous discussion and the full history ' +
          'of everything we did, and then I will come back to you.',
      ),
    ).toBeUndefined();
  });

  it('matches intents embedded mid-paragraph, not only at line start', () => {
    expect(
      matchedToolIntent('好的，我来处理。让我读取 mcp.toml 的内容看看当前配置。'),
    ).toBe('read');
  });

  it('handles null / empty input', () => {
    expect(matchedToolIntent(undefined)).toBeUndefined();
    expect(matchedToolIntent(null)).toBeUndefined();
    expect(matchedToolIntent('')).toBeUndefined();
  });
});

describe('toolIntentNudge', () => {
  it('produces a follow-through nudge naming the intent class', () => {
    expect(toolIntentNudge('read')).toContain('read/inspect files');
    expect(toolIntentNudge('modify')).toContain('modify or write files');
    expect(toolIntentNudge('other')).toContain('tool_use');
  });
});
