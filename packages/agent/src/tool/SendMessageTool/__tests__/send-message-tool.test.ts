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
}));

// Mock the whole db-client module: importing the real one wires
// process.send IPC at call time, which crashes under the vitest pool.
vi.mock('../../../ipc/db-client.js', () => ({
  messageDb: { append: mocks.append },
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
});
