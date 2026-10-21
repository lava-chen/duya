import { describe, expect, it } from 'vitest';
import { createGmailConnector, listGmailDescriptors } from '../connectors/gmail';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Gmail connector', () => {
  it('exposes the search, read, send, draft, and mark-read workflow with correct risk tiers', () => {
    const descriptors = listGmailDescriptors('gmail-1');
    expect(descriptors.map((d) => d.name)).toEqual([
      'gmail_search_messages',
      'gmail_read_message',
      'gmail_send_email',
      'gmail_draft_email',
      'gmail_mark_read',
    ]);
    expect(descriptors[0]!.riskTier).toBe('read');
    expect(descriptors[1]!.riskTier).toBe('read');
    expect(descriptors[2]!.riskTier).toBe('write');
    expect(descriptors[3]!.riskTier).toBe('draft');
    expect(descriptors[4]!.riskTier).toBe('modify');
  });

  it('searches messages and returns sender/subject/snippet summaries', async () => {
    const urls: string[] = [];
    const connector = createGmailConnector((async (input) => {
      urls.push(input.toString());
      return jsonResponse({
        messages: [{
          id: 'msg-1',
          threadId: 'thread-1',
          snippet: 'See attached',
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Q3 plan' },
            { name: 'Date', value: 'Tue, 5 Sep 2026 09:00:00 +0000' },
          ],
        }],
      });
    }) as typeof fetch);

    const result = await connector.invoke('gmail.search', { query: 'from:alice newer_than:7d', maxResults: 99 }, 'token');

    expect(result.success).toBe(true);
    const url = new URL(urls[0]!);
    expect(url.pathname).toContain('/users/me/messages');
    expect(url.searchParams.get('maxResults')).toBe('50');
    expect(url.searchParams.get('q')).toBe('from:alice newer_than:7d');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(result).toMatchObject({
      success: true,
      data: {
        messages: [{ id: 'msg-1', from: 'alice@example.com', subject: 'Q3 plan', snippet: 'See attached' }],
      },
    });
  });

  it('reads a full message and decodes a base64url text body', async () => {
    const connector = createGmailConnector((async (_input) => jsonResponse({
      id: 'msg-2',
      threadId: 'thread-2',
      snippet: 'LGTM',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'bob@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Subject', value: 'Re: Q3 plan' },
        ],
        body: { data: base64url('Looks good to me.') },
      },
    })) as typeof fetch);

    const result = await connector.invoke('gmail.read', { id: 'msg-2' }, 'token');
    expect(result).toMatchObject({
      success: true,
      data: {
        id: 'msg-2',
        from: 'bob@example.com',
        subject: 'Re: Q3 plan',
        body: 'Looks good to me.',
        labelIds: ['INBOX'],
      },
    });
  });

  it('sends an email and encodes a valid base64url RFC 5322 message', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createGmailConnector((async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ id: 'sent-1', threadId: 'thread-9' });
    }) as typeof fetch);

    const result = await connector.invoke('gmail.send', {
      to: ['alice@example.com'],
      cc: ['carol@example.com'],
      subject: 'Hello',
      body: 'First line\nSecond line',
    }, 'token');

    expect(result.success).toBe(true);
    const sent = calls[0]!;
    expect(sent.url).toContain('/users/me/messages/send');
    expect(sent.init?.method).toBe('POST');
    const body = JSON.parse(String(sent.init?.body)) as { raw: string };
    const raw = Buffer.from(body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(raw).toContain('To: alice@example.com');
    expect(raw).toContain('Cc: carol@example.com');
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('First line\r\nSecond line');
    expect(result).toMatchObject({ success: true, data: { id: 'sent-1', sentTo: ['alice@example.com'] } });
  });

  it('creates a draft without sending and stores it in /drafts', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createGmailConnector((async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ id: 'draft-1', message: { id: 'msg-9', threadId: 'thread-9' } });
    }) as typeof fetch);

    const result = await connector.invoke('gmail.draft', { to: ['bob@example.com'], subject: 'Draft title', body: 'Not sent yet' }, 'token');

    expect(result.success).toBe(true);
    const sent = calls[0]!;
    expect(sent.url).toContain('/users/me/drafts');
    expect(sent.init?.method).toBe('POST');
    const payload = JSON.parse(String(sent.init?.body)) as { message: { raw: string } };
    const raw = Buffer.from(payload.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(raw).toContain('Subject: Draft title');
    expect(raw).toContain('Not sent yet');
    expect(result).toMatchObject({ success: true, data: { id: 'draft-1', messageId: 'msg-9' } });
  });

  it('marks a message read by removing the UNREAD label', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createGmailConnector((async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ id: 'msg-5', labelIds: ['INBOX', 'IMPORTANT'] });
    }) as typeof fetch);

    const result = await connector.invoke('gmail.markRead', { id: 'msg-5' }, 'token');

    expect(result.success).toBe(true);
    const sent = calls[0]!;
    expect(sent.url).toContain('/users/me/messages/msg-5/modify');
    expect(JSON.parse(String(sent.init?.body))).toEqual({ removeLabelIds: ['UNREAD'] });
    expect(result).toMatchObject({ success: true, data: { scope: 'messages', id: 'msg-5', labelIds: ['INBOX', 'IMPORTANT'] } });
  });

  it('marks a whole thread read via /threads when threadId is given', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createGmailConnector((async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ id: 'thread-7', labelIds: ['INBOX'] });
    }) as typeof fetch);

    const result = await connector.invoke('gmail.markRead', { threadId: 'thread-7' }, 'token');

    expect(result).toMatchObject({ success: true, data: { scope: 'threads', id: 'thread-7' } });
    expect(calls[0]!.url).toContain('/users/me/threads/thread-7/modify');
  });

  it('rejects a mark-read call with no id or threadId', async () => {
    const connector = createGmailConnector((async () => {
      throw new Error('fetch should not be called');
    }) as typeof fetch);
    const result = await connector.invoke('gmail.markRead', {}, 'token');
    expect(result).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });

  it('rejects a malformed message id without calling the API', async () => {
    const connector = createGmailConnector((async () => {
      throw new Error('fetch should not be called');
    }) as typeof fetch);
    const result = await connector.invoke('gmail.read', { id: '' }, 'token');
    expect(result).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });
});