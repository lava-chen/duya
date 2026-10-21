/**
 * Plan 587 E4.3 — the single adapter from a case to the E4.1 harness.
 *
 * The harness owns the real closed loop; this adapter must not grow behaviour.
 * Two properties are load-bearing:
 *
 *  - the mapping covers every field the harness's input type exposes that a case
 *    can express, so a new harness knob cannot be silently left unset;
 *  - a live case is REFUSED here, because handing a live case's prompt to the
 *    loopback provider would produce a report labelled `live` whose bytes came
 *    from a fixture.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCase } from '../cases/format';
import { declaredUsage, toHarnessInput, toProviderScript } from './to-harness-input';

const CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url));

describe('E4.3 — case to harness input', () => {
  it('maps every field a case owns onto the harness input', () => {
    const c = parseCase({
      formatVersion: 1, id: 'a-case', title: 't', pinnedContract: 'pc', mode: 'offline',
      input: { prompt: 'do the thing', workspaceFiles: { 'a.txt': 'x' } },
      scenario: {
        kind: 'offline-anthropic-sse', seed: 'seed-1', tamperManifestHash: true,
        turns: [{ blocks: [{ kind: 'tool_use', id: 't1', name: 'read', input: { file_path: 'a.txt' } }], stopReason: 'tool_use', inputTokens: 7, outputTokens: 9 }],
      },
      policy: { permissionMode: 'default' },
      budget: { maxTurns: 7, timeoutMs: 1234 },
      expect: { invariants: [{ family: 'structure', kind: 'terminalStatus', value: 'completed' }], artefacts: [] },
    });

    const input = toHarnessInput(c);
    expect(input.prompt).toBe('do the thing');
    expect(input.workspaceFiles).toEqual({ 'a.txt': 'x' });
    expect(input.permissionMode).toBe('default');
    expect(input.maxTurns).toBe(7);
    expect(input.timeoutMs).toBe(1234);
    expect(input.seed).toBe('seed-1');
    expect(input.tamperManifestHash).toBe(true);
    expect(input.script.turns[0]?.blocks[0]).toEqual({ kind: 'tool_use', id: 't1', name: 'read', input: { file_path: 'a.txt' } });
  });

  it('refuses to run a live case through the offline harness', () => {
    const c = parseCase({
      formatVersion: 1, id: 'live-case', title: 't', pinnedContract: 'pc', mode: 'live',
      input: { prompt: 'p' },
      scenario: { kind: 'offline-anthropic-sse', seed: 's', turns: [{ blocks: [{ kind: 'text', text: 'x' }] }] },
      policy: { permissionMode: 'default' },
      budget: { maxTurns: 2, timeoutMs: 1000 },
      live: { model: 'm', temperature: 0, maxTokens: 1, measurements: 3 },
      expect: { invariants: [{ family: 'structure', kind: 'terminalStatus', value: 'completed' }], artefacts: [] },
    });
    expect(() => toHarnessInput(c)).toThrow(/not run through the offline harness/);
  });

  it('reads declared usage from the LAST turn, matching the harness last usage frame', () => {
    const script = toProviderScript(parseCase({
      formatVersion: 1, id: 'a-case', title: 't', pinnedContract: 'pc', mode: 'offline',
      input: { prompt: 'p' },
      scenario: {
        kind: 'offline-anthropic-sse', seed: 's',
        turns: [
          { blocks: [{ kind: 'text', text: 'a' }], inputTokens: 10, outputTokens: 1 },
          { blocks: [{ kind: 'text', text: 'b' }], inputTokens: 20, outputTokens: 2 },
        ],
      },
      policy: { permissionMode: 'bypassPermissions' },
      budget: { maxTurns: 2, timeoutMs: 1000 },
      expect: { invariants: [{ family: 'structure', kind: 'terminalStatus', value: 'completed' }], artefacts: [] },
    }));
    expect(declaredUsage(script)).toEqual({ inputTokens: 20, outputTokens: 2 });
  });
});

describe('E4.3 — every offline case on disk adapts without error', () => {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();

  it.each(files)('%s', (file) => {
    const c = parseCase(JSON.parse(readFileSync(path.join(CASES_DIR, file), 'utf8')) as unknown);
    if (c.mode === 'live') {
      expect(() => toHarnessInput(c)).toThrow();
      return;
    }
    const input = toHarnessInput(c);
    // Every offline case must reach the harness with a prompt and at least one
    // provider turn, or the run cannot happen and the report would be a skip
    // that nobody expected.
    expect(input.prompt.length).toBeGreaterThan(0);
    expect(input.script.turns.length).toBeGreaterThan(0);
  });
});
