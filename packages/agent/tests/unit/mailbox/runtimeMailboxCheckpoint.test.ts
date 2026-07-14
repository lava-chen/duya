import { afterEach, describe, expect, it, vi } from 'vitest';
import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import { mailboxDb } from '../../../src/ipc/db-client.js';
import type { Message } from '../../../src/types.js';

describe('runtime mailbox checkpoints', () => {
  afterEach(() => vi.restoreAllMocks());

  it('absorbs guidance that arrives before the final answer into a new model turn', async () => {
    const row = {
      id: 'mail-1',
      session_id: 'session-1',
      content: 'Use the updated requirement',
      kind: 'correction',
      status: 'observed',
    };
    const claimBatch = vi.spyOn(mailboxDb, 'claimBatch').mockResolvedValue({
      rows: [row],
      claimTokens: ['claim-1'],
    });
    const apply = vi.spyOn(mailboxDb, 'apply').mockResolvedValue(row);
    const agent = new duyaAgent({
      apiKey: 'test-key',
      provider: 'anthropic',
      model: 'test-model',
      sessionId: 'session-1',
      enableRetry: false,
    });
    const messages: Message[] = [];
    const checkpoint = agent as unknown as {
      _claimMailboxAtCheckpoint: (
        runId: string,
        target: Message[],
        seqIndex: number,
        point: 'before_model_turn' | 'before_final_answer',
      ) => Promise<{ action: string; absorbed?: boolean }>;
    };

    const decision = await checkpoint._claimMailboxAtCheckpoint(
      'run-1',
      messages,
      7,
      'before_final_answer',
    );

    expect(decision).toEqual({ action: 'continue', absorbed: true });
    expect(claimBatch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-1',
      checkpoint: 'before_final_answer',
    }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      id: 'mail-1',
      claimToken: 'claim-1',
      mode: 'runtime_instruction',
      checkpoint: 'before_final_answer',
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      seq_index: 7,
      metadata: {
        mailboxRuntimeInstruction: true,
        mailboxRowIds: ['mail-1'],
      },
    });
    expect(messages[0]?.content).toContain('Use the updated requirement');
  });
});
