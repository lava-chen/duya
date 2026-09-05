/**
 * SendToAgentTool addressing tests (Plan 477 P3.1 regression).
 *
 * The mailbox row must be written against the target's PERSISTENT bot
 * session id (`bot:<agentId>`) — the wake dispatcher addresses the target's
 * session with it verbatim. Writing the bare roster id silently loses the
 * wake (observed: `session_id='bot-b6cd5c'` rows that never woke anyone).
 * Database boundary is mocked so no database is touched.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  mailboxSend: vi.fn(async () => ({})),
  appendMessages: vi.fn(async () => undefined),
  readConfigAgents: vi.fn(async () => ({})),
}));

vi.mock('../../../session/db.js', () => ({
  mailboxSend: mocks.mailboxSend,
  appendMessages: mocks.appendMessages,
}));

vi.mock('../../../agent-profile/config-agents.js', () => ({
  readConfigAgents: mocks.readConfigAgents,
}));

import { sendToAgentTool } from '../SendToAgentTool.js';
import { decodeEnvelope } from '../../../agent/dm/index.js';

type ExecResult = { id: string; name: string; result: string; error?: boolean };

const runSend = sendToAgentTool.execute.bind(sendToAgentTool);

function runTool(toolArgs: Record<string, unknown>): Promise<ExecResult> {
  return runSend(toolArgs, undefined, {
    options: { sessionId: 'bot:bot-sender' },
  } as never) as Promise<ExecResult>;
}

/** Payload handed to the mocked mailbox boundary (latest call). */
function lastMailboxRow(): Record<string, unknown> {
  const mailboxSend = mocks.mailboxSend as unknown as Mock;
  const [row] = mailboxSend.mock.calls.at(-1) ?? [];
  return (row ?? {}) as Record<string, unknown>;
}

describe('SendToAgentTool addressing', () => {
  beforeEach(() => {
    mocks.mailboxSend.mockClear();
    mocks.appendMessages.mockClear();
    mocks.readConfigAgents.mockReset();
    mocks.readConfigAgents.mockResolvedValue({
      'bot-peer': { name: '原型师' },
    });
  });

  it('writes the mailbox row to the target persistent bot session id', async () => {
    const res = await runTool({ toAgentId: 'bot-peer', text: 'hello' });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Sent to 原型师');

    const row = lastMailboxRow();
    // The core fix: NOT the bare 'bot-peer' roster id.
    expect(row.sessionId).toBe('bot:bot-peer');
    expect(row.kind).toBe('agent_dm');
    expect(row.source).toBe('bot:bot-sender');

    const envelope = decodeEnvelope(row.content as string);
    expect(envelope?.from.id).toBe('bot:bot-sender');
    expect(envelope?.to.id).toBe('bot-peer');
    expect(envelope?.to.name).toBe('原型师');
  });

  it('rejects a self-DM addressed by bare roster id', async () => {
    const res = await runTool({ toAgentId: 'bot-sender', text: 'hello me' });
    expect(res.result).toContain('cannot message itself');
    expect(mocks.mailboxSend).not.toHaveBeenCalled();
  });

  it('rejects an unknown target and lists available agents', async () => {
    const res = await runTool({ toAgentId: 'bot-ghost', text: 'hello' });
    expect(res.error).toBe(true);
    expect(res.result).toContain('bot-ghost" not found');
    expect(res.result).toContain('bot-peer (原型师)');
    expect(mocks.mailboxSend).not.toHaveBeenCalled();
  });
});
