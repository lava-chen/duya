/**
 * `discoverHooks` — plugin hook declaration discovery.
 *
 * The first case reads a hook file that actually ships in this repo
 * (`packages/agent/skills/.system/memory-search/hooks.json`) rather than a
 * synthetic fixture written to match the implementation. That is deliberate:
 * the bug this covers was a disagreement about the file format, so a
 * hand-written fixture would have reproduced the same assumption and passed.
 *
 * The second half pins the flat shape the existing consumers depend on.
 * `manifest.ts` and `dto-mappers.ts` read a single `event` and a single
 * `handler` string off each entry, so one hook *command* has to become one
 * entry.
 *
 * Note the boundary: discovery is not execution. Nothing yet feeds plugin
 * hook files into the agent's hook config, so these entries describe
 * declarations, not hooks that run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { discoverHooks } from '../src/plugins/loader/capability-discovery.js';

/** The conformant hook file that ships in this repo. */
const REAL_HOOKS_FILE = resolve(
  __dirname,
  '../../agent/skills/.system/memory-search/hooks.json',
);

function makePlugin(hooksJson: string): string {
  const root = mkdtempSync(join(tmpdir(), 'duya-hooks-'));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hooks.json'), hooksJson, 'utf-8');
  return root;
}

describe('discoverHooks — the format the repo itself uses', () => {
  let pluginDir: string;
  beforeAll(() => {
    // Stage the real file inside a plugin-shaped directory.
    pluginDir = mkdtempSync(join(tmpdir(), 'duya-hooks-real-'));
    mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
    cpSync(REAL_HOOKS_FILE, join(pluginDir, 'hooks', 'hooks.json'));
  });
  afterAll(() => rmSync(pluginDir, { recursive: true, force: true }));

  it('reads the object shape that memory-search actually ships', () => {
    // Before the fix this returned []: discoverHooks only accepted a
    // top-level array, so every spec-conformant plugin file counted as zero
    // hooks and capabilityCounts.hooks undercounted it.
    const hooks = discoverHooks(pluginDir);
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('UserPromptSubmit');
    expect(hooks[0].handler).toContain('node');
    expect(hooks[0].command).toBe('node');
  });

  it('keeps the parsed command detail on the entry', () => {
    const [hook] = discoverHooks(pluginDir);
    expect(hook.type).toBe('process');
    expect(Array.isArray(hook.args)).toBe(true);
    expect(hook.timeoutMs).toBe(5000);
  });
});

describe('discoverHooks — shape handling', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
  const plugin = (json: string) => {
    const r = makePlugin(json);
    roots.push(r);
    return r;
  };

  it('flattens one entry per hook command across events and matchers', () => {
    const dir = plugin(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'process', command: 'a', args: ['1'] }, { type: 'process', command: 'b' }] },
          ],
          PostToolUse: [{ hooks: [{ type: 'http', url: 'https://example.test/h' }] }],
        },
      }),
    );
    const hooks = discoverHooks(dir);
    expect(hooks.map((h) => h.event)).toEqual(['PreToolUse', 'PreToolUse', 'PostToolUse']);
    expect(hooks[0].handler).toBe('process a 1');
    expect(hooks[1].handler).toBe('process b');
    expect(hooks[2].handler).toBe('http https://example.test/h');
    expect(hooks[0].matcher).toBe('Edit|Write');
  });

  it('tolerates the legacy bare-array form', () => {
    // Kept for tolerance; it is not the convention, but removing support
    // would silently zero out anything already written against it.
    const dir = plugin(JSON.stringify([{ event: 'UserPromptSubmit', handler: 'legacy' }]));
    expect(discoverHooks(dir)).toEqual([{ event: 'UserPromptSubmit', handler: 'legacy' }]);
  });

  it('returns [] for a directory with no hooks file', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-hooks-empty-'));
    roots.push(root);
    expect(discoverHooks(root)).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{ not json'],
    ['a JSON array of non-objects', '[1, 2, 3]'],
    ['an object with no hooks key', JSON.stringify({ description: 'x' })],
    ['an object whose hooks is an array', JSON.stringify({ hooks: [] })],
    ['an event whose matcher groups are not arrays', JSON.stringify({ hooks: { PreToolUse: 'nope' } })],
    ['a matcher group with no hooks array', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x' }] } })],
    ['a null document', 'null'],
  ])('returns [] rather than throwing on %s', (_label, body) => {
    const dir = plugin(body);
    expect(discoverHooks(dir)).toEqual([]);
  });
});
