import { describe, expect, it } from 'vitest';
import { SessionTool, type SessionToolPort } from '../../src/session-tool.js';

function port(): SessionToolPort {
  return {
    getCallerSessionId: () => 'parent',
    spawn: async () => ({ ok: true, sessionId: 'child', parentId: 'parent', completionNotification: 'query' }),
    reply: async () => ({ ok: true, sessionId: 'child', completionNotification: 'query' }),
    list: async () => ({ ok: true, sessions: [] }),
    cancel: async () => ({ ok: true, sessionId: 'child' }),
    rename: async () => ({ ok: true, sessionId: 'child' }),
    get: async () => ({ ok: true, session: {
      id: 'child', title: 'Task', status: 'completed', workingDirectory: '/project',
      filesChanged: 0, linesAdded: 0, linesRemoved: 0, updatedAt: 1, createdAt: 1,
      runId: 'child-run-2', output: 'FOLLOWUP_RESULT_FROM_CHILD',
    } }),
  };
}

describe('session delegation receipts', () => {
  it('does not promise a wake when the Host only supports result queries', async () => {
    const tool = new SessionTool(port());
    const spawn = await tool.execute({ action: 'spawn', workingDirectory: '/project', prompt: 'work' });
    const reply = await tool.execute({ action: 'reply', sessionId: 'child', prompt: 'follow up' });
    expect(String(spawn.result)).toContain('get');
    expect(String(reply.result)).toContain('get');
    expect(String(spawn.result)).not.toContain('auto-woken');
    expect(String(reply.result)).not.toContain('auto-woken');
  });

  it('shows the tracked run and its result to the parent tool caller', async () => {
    const result = await new SessionTool(port()).execute({ action: 'get', sessionId: 'child' });
    expect(String(result.result)).toContain('child-run-2');
    expect(String(result.result)).toContain('FOLLOWUP_RESULT_FROM_CHILD');
  });
});
