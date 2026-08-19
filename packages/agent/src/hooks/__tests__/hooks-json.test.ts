/**
 * hook.json loader tests (plan 87 config rework).
 *
 * Verifies parseHooksJsonContent (ecosystem shape — Claude Code settings.json
 * hooks field / ZCode plugin hooks.json) and mergeHooksSettings.
 */

import { describe, it, expect } from 'vitest';
import { parseHooksJsonContent, mergeHooksSettings } from '../hooks-json.js';
import type { HooksSettings } from '../types.js';

describe('parseHooksJsonContent', () => {
  it('parses the ecosystem shape with an optional description', () => {
    const raw = JSON.stringify({
      description: 'Mimosa-style hooks',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [
              {
                type: 'process',
                command: 'node',
                args: ['${ZCODE_PLUGIN_ROOT}/scan.mjs'],
                timeoutMs: 120000,
                statusMessage: 'scanning…',
              },
            ],
          },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
      },
    });
    const settings = parseHooksJsonContent(raw, 'test.json');
    expect(settings).toBeDefined();
    expect(settings?.PreToolUse).toHaveLength(2);
    expect(settings?.PreToolUse?.[0].matcher).toBe('Edit|Write|MultiEdit');
    expect(settings?.PreToolUse?.[0].hooks[0]).toMatchObject({
      type: 'process',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/scan.mjs'],
      timeoutMs: 120000,
    });
    expect(settings?.PreToolUse?.[1].matcher).toBe('Bash');
    expect(settings?.UserPromptSubmit?.[0].hooks[0].command).toBe('codegraph prompt-hook');
  });

  it('accepts a bare hooks object without description', () => {
    const settings = parseHooksJsonContent(
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}',
      't.json',
    );
    expect(settings?.Stop).toHaveLength(1);
  });

  it('returns undefined for non-JSON content', () => {
    expect(parseHooksJsonContent('not json {', 't.json')).toBeUndefined();
  });

  it('returns undefined when the hooks key is missing or not an object', () => {
    expect(parseHooksJsonContent('{}', 't.json')).toBeUndefined();
    expect(parseHooksJsonContent('{"description":"x"}', 't.json')).toBeUndefined();
    expect(parseHooksJsonContent('{"hooks":[]}', 't.json')).toBeUndefined();
    expect(parseHooksJsonContent('[1,2]', 't.json')).toBeUndefined();
  });

  it('rejects unknown event keys inside hooks (strict)', () => {
    const settings = parseHooksJsonContent('{"hooks":{"NotAnEvent":[]}}', 't.json');
    expect(settings).toBeUndefined();
  });

  it('rejects malformed matcher groups', () => {
    expect(parseHooksJsonContent('{"hooks":{"PreTurn":"nope"}}', 't.json')).toBeUndefined();
    expect(
      parseHooksJsonContent('{"hooks":{"PreTurn":[{"hooks":["not-an-object"]}]}}', 't.json'),
    ).toBeUndefined();
  });
});

describe('mergeHooksSettings', () => {
  const mk = (event: keyof HooksSettings, command: string): HooksSettings => ({
    [event]: [{ hooks: [{ type: 'command' as const, command }] }],
  });

  it('concatenates same-event matcher groups in file order', () => {
    const merged = mergeHooksSettings([mk('PostToolUse', 'a'), mk('PostToolUse', 'b')]);
    expect(merged?.PostToolUse?.map((m) => m.hooks[0].command)).toEqual(['a', 'b']);
  });

  it('keeps distinct events apart', () => {
    const merged = mergeHooksSettings([mk('PreTurn', 'a'), mk('Stop', 'b')]);
    expect(merged?.PreTurn).toHaveLength(1);
    expect(merged?.Stop).toHaveLength(1);
  });

  it('returns undefined when every part is undefined or empty', () => {
    expect(mergeHooksSettings([undefined, undefined])).toBeUndefined();
    expect(mergeHooksSettings([{}, {}])).toBeUndefined();
    expect(mergeHooksSettings([])).toBeUndefined();
  });
});
