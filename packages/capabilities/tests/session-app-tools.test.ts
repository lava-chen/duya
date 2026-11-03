import { describe, expect, it, vi } from 'vitest';
import type { ToolUseContext } from '../src/contracts/tool.js';
import { SessionListTool, SessionReadTool } from '../src/session-app-tools.js';

const context = { options: { sessionId: 'caller-session' } } as unknown as ToolUseContext;

describe('Session app tools', () => {
  it('lists only the requested Host-derived scope and projects safe session metadata', async () => {
    const page = {
      sessions: [{
        session: {
          id: 'child-1',
          title: 'untrusted title',
          projectName: 'untrusted project',
          status: 'archived',
          parentSessionId: 'caller-session',
          createdAt: 10,
          updatedAt: 20,
        },
        timelineCount: 3,
      }],
      nextCursor: 'next-page',
    };
    const listSessions = vi.fn().mockResolvedValue(page);
    const tool = new SessionListTool({ listSessions });

    const result = await tool.execute({ scope: 'workspace', includeArchived: true, limit: 5 }, undefined, context);

    expect(listSessions).toHaveBeenCalledWith({ scope: 'workspace', includeArchived: true, limit: 5 });
    expect(result.error).toBeUndefined();
    expect(result.structured).toMatchObject({
      trustNotice: expect.stringContaining('untrusted'),
      sessions: [{ sessionId: 'child-1', status: 'archived', timelineCount: 3 }],
      nextCursor: 'next-page',
    });
    expect(JSON.stringify(result.structured)).not.toContain('workingDirectory');
  });

  it('rejects unknown fields and out-of-range list limits at execution time', async () => {
    const listSessions = vi.fn();
    const tool = new SessionListTool({ listSessions });

    const unknown = await tool.execute({ scope: 'children', sessionId: 'forged' }, undefined, context);
    const invalidLimit = await tool.execute({ limit: 51 }, undefined, context);

    expect(unknown.error).toBe(true);
    expect(invalidLimit.error).toBe(true);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('bounds transcript previews, omits large binary fields, and marks transcript data untrusted', async () => {
    const page = {
      sessionId: 'target-session',
      messages: [{
        id: 'message-1',
        sequence: 1,
        createdAt: 10,
        turnId: 'turn-1',
        entry: {
          type: 'message',
          id: 'message-1',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'A'.repeat(1000) },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(1000) } },
            ],
          },
        },
      }],
      nextCursor: 'next-message',
    };
    const readMessages = vi.fn().mockResolvedValue(page);
    const tool = new SessionReadTool({ readMessages });

    const result = await tool.execute({ sessionId: 'target-session', maxOutputCharsPerItem: 200 }, undefined, context);
    const structured = result.structured as {
      trustNotice: string;
      messages: Array<{ preview: string; truncated: boolean }>;
      nextCursor: string;
    };

    expect(readMessages).toHaveBeenCalledWith({ sessionId: 'target-session', limit: 10 });
    expect(structured.trustNotice).toContain('untrusted');
    expect(structured.messages[0]?.preview.length).toBeLessThanOrEqual(200);
    expect(structured.messages[0]?.truncated).toBe(true);
    expect(structured.messages[0]?.preview).not.toContain('B'.repeat(100));
    expect(structured.nextCursor).toBe('next-message');
  });
});
