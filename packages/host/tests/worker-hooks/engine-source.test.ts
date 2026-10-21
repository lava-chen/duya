import { describe, expect, it } from 'vitest';
import { createWorkerHookSource, MAPPED_PHASES } from '../../src/worker-hooks/engine-source.js';

describe('worker hook extension source', () => {
  it('binds the legacy config-hook events to the measured Runtime phases', async () => {
    const source = createWorkerHookSource({
      cwd: process.cwd(),
      sessionId: 'session-hook-source',
      settings: {},
    });

    expect(MAPPED_PHASES).toEqual(['on_start', 'before_tool', 'after_tool', 'after_finalize']);
    expect(source.list('on_start').map(({ id }) => id)).toEqual([
      'hook:UserPromptSubmit@on_start',
      'hook:SessionStart@on_start',
    ]);
    expect(source.list('before_tool').map(({ id }) => id)).toEqual(['hook:PreToolUse@before_tool']);
    expect(source.list('after_tool').map(({ id }) => id)).toEqual(['hook:PostToolUse@after_tool']);
    expect(source.list('after_finalize').map(({ id }) => id)).toEqual([
      'hook:Stop@after_finalize',
      'hook:SessionEnd@after_finalize',
    ]);
    expect(source.list('before_model')).toEqual([]);
    await expect(source.unload()).resolves.toBeUndefined();
  });
});
