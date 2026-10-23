/**
 * Plan 619 Phase 4 — the prompt ledger.
 *
 * The ledger records what the model was shown: the system prompt and the
 * volatile blocks that travelled on the message channel. The rules that
 * matter are the volume ones — an unchanged text is recorded by hash,
 * and a quota can cap how often a full text is written — because the
 * rollout file has a 4 MB rotation gate and a hundred-turn session
 * that wrote the system prompt every turn would add megabytes.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPromptSnapshot,
  newPromptLedgerState,
  promptLedgerQuota,
  toRecordedBlocks,
} from '@duya/host/worker-context/prompt-ledger';

const ORIGINAL_QUOTA = process.env.DUYA_PROMPT_LEDGER_MAX_FULL;

afterEach(() => {
  if (ORIGINAL_QUOTA === undefined) delete process.env.DUYA_PROMPT_LEDGER_MAX_FULL;
  else process.env.DUYA_PROMPT_LEDGER_MAX_FULL = ORIGINAL_QUOTA;
});

describe('plan 619 phase 4 — the prompt ledger', () => {
  it('records the system prompt and the context blocks', () => {
    const state = newPromptLedgerState();
    const snapshot = buildPromptSnapshot(state, {
      turnId: 'turn-1',
      systemPrompt: 'YOU ARE AN AGENT',
      contextBlocks: [
        { id: 'environment', source: 'volatile_context', role: 'user', content: 'cwd=/repo' },
      ],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.type).toBe('prompt_snapshot');
    expect(snapshot?.turnId).toBe('turn-1');
    expect(snapshot?.systemPrompt.content).toBe('YOU ARE AN AGENT');
    expect(snapshot?.systemPrompt.length).toBe('YOU ARE AN AGENT'.length);
    expect(snapshot?.systemPrompt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot?.contextBlocks).toHaveLength(1);
    expect(snapshot?.contextBlocks[0]?.id).toBe('environment');
    expect(snapshot?.contextBlocks[0]?.content).toBe('cwd=/repo');
  });

  it('records an unchanged text by hash only', () => {
    const state = newPromptLedgerState();
    buildPromptSnapshot(state, {
      turnId: 'turn-1',
      systemPrompt: 'SAME',
      contextBlocks: [],
    });
    const second = buildPromptSnapshot(state, {
      turnId: 'turn-2',
      systemPrompt: 'SAME',
      contextBlocks: [],
    });

    expect(second?.systemPrompt.content).toBeUndefined();
    expect(second?.systemPrompt.omitted).toBe('unchanged');
    expect(second?.systemPrompt.hash).toBe(
      buildPromptSnapshot(newPromptLedgerState(), {
        turnId: 'x',
        systemPrompt: 'SAME',
        contextBlocks: [],
      })?.systemPrompt.hash,
    );
  });

  it('writes the text again once it changes', () => {
    const state = newPromptLedgerState();
    buildPromptSnapshot(state, { turnId: 't1', systemPrompt: 'ONE', contextBlocks: [] });
    const second = buildPromptSnapshot(state, {
      turnId: 't2',
      systemPrompt: 'TWO',
      contextBlocks: [],
    });
    expect(second?.systemPrompt.content).toBe('TWO');
    expect(second?.systemPrompt.omitted).toBeUndefined();
  });

  it('caps the full writes when a quota is set', () => {
    process.env.DUYA_PROMPT_LEDGER_MAX_FULL = '1';
    expect(promptLedgerQuota()).toBe(1);

    const state = newPromptLedgerState();
    const first = buildPromptSnapshot(state, {
      turnId: 't1',
      systemPrompt: 'ONE',
      contextBlocks: [],
    });
    expect(first?.systemPrompt.content).toBe('ONE');

    const second = buildPromptSnapshot(state, {
      turnId: 't2',
      systemPrompt: 'TWO',
      contextBlocks: [],
    });
    expect(second?.systemPrompt.content).toBeUndefined();
    expect(second?.systemPrompt.omitted).toBe('quota');
  });

  it('records nothing when there is no prompt at all', () => {
    const state = newPromptLedgerState();
    expect(
      buildPromptSnapshot(state, { turnId: 't1', systemPrompt: '', contextBlocks: [] }),
    ).toBeNull();
  });

  it('marks a caller-supplied system prompt as overridden', () => {
    const state = newPromptLedgerState();
    const snapshot = buildPromptSnapshot(state, {
      turnId: 't1',
      systemPrompt: 'CALLER',
      contextBlocks: [],
      overridden: true,
    });
    expect(snapshot?.overridden).toBe(true);
  });

  it('turns rail blocks into the recorded shape', () => {
    const recorded = toRecordedBlocks([
      { id: 'environment', source: 'volatile_context', content: 'cwd=/repo' },
    ]);
    expect(recorded).toEqual([
      { id: 'environment', source: 'volatile_context', role: 'user', content: 'cwd=/repo' },
    ]);
  });
});
