/**
 * SendMessageTool validation tests (grok refineSendMessage port).
 *
 * The validator is exercised through the exported class's `execute` (which
 * returns the aggregated validation error), with the messageDb boundary
 * mocked so no database is touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  append: vi.fn(async () => undefined),
  state: {
    createWidgetPending: vi.fn(async () => undefined),
    updateWidgetResponse: vi.fn(async () => undefined),
    upsertCursorAgentRun: vi.fn(async () => undefined),
    updateCursorAgentRun: vi.fn(async () => undefined),
    createSecretPending: vi.fn(async () => undefined),
    markSecretProvided: vi.fn(async () => undefined),
  },
}));

// Mock the whole db-client module: importing the real one wires
// process.send IPC at call time, which crashes under the vitest pool.
vi.mock('../../../ipc/db-client.js', () => ({
  messageDb: { append: mocks.append },
  sendMessageStateDb: mocks.state,
  channelDb: { deliver: vi.fn(async () => ({ success: true })) },
}));

import { sendMessageTool } from '../SendMessageTool.js';

type ExecResult = { id: string; name: string; result: string; error?: boolean };

function exec(input: Record<string, unknown>): Promise<ExecResult> {
  return sendMessageTool.execute(input, undefined, {
    options: { sessionId: 'bot:test:abc' },
  } as never) as Promise<ExecResult>;
}

describe('SendMessageTool validation (grok self-teaching errors)', () => {
  beforeEach(() => {
    mocks.append.mockClear();
    Object.values(mocks.state).forEach((fn) => fn.mockClear());
  });

  it('rejects a field riding the wrong type with recovery instructions', async () => {
    const res = await exec({ type: 'text', content: 'hi', widget: { prompt: 'x' } });
    expect(res.error).toBe(true);
    expect(res.result).toContain('widget is only valid with type:widget');
    expect(res.result).toContain('it would be silently dropped');
    expect(res.result).toContain('Nothing was sent');
    expect(res.result).toContain('Re-send as separate SendMessage calls, one per type');
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('rejects images on non-text types with the attach-to-text guidance', async () => {
    const res = await exec({
      type: 'attachment',
      url: 'file:///C:/tmp/a.png',
      images: [{ url: 'file:///C:/tmp/b.png' }],
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('images can only be set for type:text');
  });

  it('rejects channel on widget types', async () => {
    const res = await exec({
      type: 'widget',
      widget: { prompt: 'go?', options: [{ label: 'Yes' }] },
      channel: 'slack:C1',
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('channel can only be set for type:text or type:attachment');
  });

  it('rejects a text message without content', async () => {
    const res = await exec({ type: 'text' });
    expect(res.error).toBe(true);
    expect(res.result).toContain('content is required when type is text');
  });

  it('rejects attachment urls without file:// or https:// scheme', async () => {
    const res = await exec({ type: 'attachment', url: 'http://example.com/a.png' });
    expect(res.error).toBe(true);
    expect(res.result).toContain('url must include a file:// or https:// scheme');
  });

  it('rejects image urls without file:// or https:// scheme', async () => {
    const res = await exec({
      type: 'text',
      content: 'look',
      images: [{ url: 'ftp://example.com/a.png' }],
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('each images url must include a file:// or https:// scheme');
  });

  it('rejects a widget without options', async () => {
    const res = await exec({ type: 'widget', widget: { prompt: 'go?' } });
    expect(res.error).toBe(true);
    expect(res.result).toContain('widget.options requires 1-6 real, verified choices');
  });

  it('rejects secret-request without field', async () => {
    const res = await exec({
      type: 'secret-request',
      secret: { label: 'Token', connector: 'slack' },
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('secret.field is required');
  });

  it('delivers a valid text message (source=send_message)', async () => {
    const res = await exec({ type: 'text', content: 'hello' });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Message sent to user');
    expect(mocks.append).toHaveBeenCalledTimes(1);
    const [, rows] = mocks.append.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(rows[0].source).toBe('send_message');
  });

  it('persists widget interaction state after append (Plan 489 P0.2)', async () => {
    const res = await exec({
      type: 'widget',
      widget: { prompt: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    expect(res.error).toBeUndefined();
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(mocks.state.createWidgetPending).toHaveBeenCalledTimes(1);
    const call = mocks.state.createWidgetPending.mock.calls[0][0] as {
      messageId: string;
      sessionId: string;
      prompt: string;
      widgetJson: string;
    };
    expect(call.messageId).toBe(res.id);
    expect(call.sessionId).toBe('bot:test:abc');
    expect(call.prompt).toBe('Deploy?');
    expect(JSON.parse(call.widgetJson).options.length).toBe(2);
  });

  it('persists cursor-agent run state after append (Plan 489 P0.2)', async () => {
    const res = await exec({ type: 'cursor-agent', bcId: 'bc-123' });
    expect(res.error).toBeUndefined();
    expect(mocks.state.upsertCursorAgentRun).toHaveBeenCalledTimes(1);
    const call = mocks.state.upsertCursorAgentRun.mock.calls[0][0] as {
      messageId: string;
      bcId: string;
      status: string;
    };
    expect(call.messageId).toBe(res.id);
    expect(call.bcId).toBe('bc-123');
    expect(call.status).toBe('pending');
  });

  it('persists secret-request state after append (Plan 489 P0.2)', async () => {
    const res = await exec({
      type: 'secret-request',
      secret: { label: 'Token', connector: 'slack', field: 'bot_token' },
    });
    expect(res.error).toBeUndefined();
    expect(mocks.state.createSecretPending).toHaveBeenCalledTimes(1);
    const call = mocks.state.createSecretPending.mock.calls[0][0] as {
      messageId: string;
      label: string;
      connector: string;
      field: string;
    };
    expect(call.messageId).toBe(res.id);
    expect(call.label).toBe('Token');
    expect(call.connector).toBe('slack');
    expect(call.field).toBe('bot_token');
  });

  it('does not persist side state for plain text sends', async () => {
    await exec({ type: 'text', content: 'hi' });
    expect(mocks.state.createWidgetPending).not.toHaveBeenCalled();
    expect(mocks.state.upsertCursorAgentRun).not.toHaveBeenCalled();
    expect(mocks.state.createSecretPending).not.toHaveBeenCalled();
  });
});
