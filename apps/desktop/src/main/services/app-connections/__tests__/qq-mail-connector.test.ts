import { describe, expect, it, vi } from 'vitest';
import {
  createQqMailConnector,
  listQqMailDescriptors,
  type QqImapSession,
  type QqMailEnvelope,
  type SendMailFn,
} from '../connectors/qq-mail';
import type { TokenVault } from '../token-vault';

/** Minimal TokenVault stub exposing the OAuth-client slot the connector reads. */
function vaultWith(creds?: { email: string; authCode: string }): TokenVault {
  return {
    getOAuthClient: () =>
      creds
        ? { clientId: creds.email, clientSecret: creds.authCode }
        : undefined,
  } as unknown as TokenVault;
}

function sessionWith(envelopes: QqMailEnvelope[]): QqImapSession {
  return {
    search: async (maxResults, query) => {
      const needle = query?.trim().toLowerCase();
      const filtered = needle
        ? envelopes.filter((e) =>
            e.subject.toLowerCase().includes(needle) || e.from.toLowerCase().includes(needle))
        : envelopes;
      return filtered.slice(0, maxResults);
    },
    read: async (uid) =>
      envelopes.find((e) => e.uid === uid)
        ? { ...envelopes.find((e) => e.uid === uid)!, body: 'Hello from QQ mail' }
        : null,
    close: async () => {},
  };
}

describe('QQ Mail connector', () => {
  it('exposes the search, read, and send workflow with correct risk tiers', () => {
    const descriptors = listQqMailDescriptors('qq-mail-1');
    expect(descriptors.map((d) => d.name)).toEqual([
      'qq_mail_search',
      'qq_mail_read',
      'qq_mail_send',
    ]);
    expect(descriptors[0]!.riskTier).toBe('read');
    expect(descriptors[1]!.riskTier).toBe('read');
    expect(descriptors[2]!.riskTier).toBe('write');
    expect(descriptors[0]!.connectionId).toBe('qq-mail-1');
  });

  it('refuses to operate before credentials are configured', async () => {
    const connector = createQqMailConnector(vaultWith());
    const result = await connector.invoke('qq-mail.search', {}, '');
    expect(result).toMatchObject({ success: false, error: { code: 'provider_error' } });
  });

  it('searches the INBOX through the injected IMAP session', async () => {
    const connector = createQqMailConnector(
      vaultWith({ email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' }),
      { connectImap: async () => sessionWith([
        { uid: 3, subject: 'Q3 plan', from: 'alice@example.com', to: 'a@qq.com', date: '2026-09-06T08:00:00', snippet: 'Q3 plan' },
        { uid: 2, subject: 'Hello', from: 'bob@example.com', to: 'a@qq.com', date: '2026-09-05T08:00:00', snippet: 'Hello' },
      ]) },
    );

    const result = await connector.invoke('qq-mail.search', { maxResults: 10, query: 'plan' }, '');
    expect(result).toMatchObject({
      success: true,
      data: { messages: [{ uid: 3, subject: 'Q3 plan' }] },
    });
  });

  it('reads one message body by uid', async () => {
    const connector = createQqMailConnector(
      vaultWith({ email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' }),
      { connectImap: async () => sessionWith([
        { uid: 1, subject: 'Brief', from: 'a@qq.com', to: 'a@qq.com', date: '2026-09-01T00:00:00', snippet: 'Brief' },
      ]) },
    );

    const result = await connector.invoke('qq-mail.read', { uid: 1 }, '');
    expect(result).toMatchObject({
      success: true,
      data: { uid: 1, subject: 'Brief', body: 'Hello from QQ mail' },
    });
  });

  it('rejects a non-integer uid without contacting the server', async () => {
    const connector = createQqMailConnector(
      vaultWith({ email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' }),
      { connectImap: async () => {
        throw new Error('should not connect');
      } },
    );
    const result = await connector.invoke('qq-mail.read', { uid: -1 }, '');
    expect(result).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });

  it('sends via SMTP using the vault credentials and returns accepted recipients', async () => {
    const sendMail = vi.fn<SendMailFn>(async () => {});
    const connector = createQqMailConnector(
      vaultWith({ email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' }),
      { connectImap: async () => sessionWith([]), sendMail },
    );

    const result = await connector.invoke('qq-mail.send', {
      to: ['bob@example.com'],
      cc: ['carol@example.com'],
      subject: 'Hello',
      body: 'Body text',
    }, '');

    expect(result).toMatchObject({ success: true, data: { to: ['bob@example.com'], subject: 'Hello' } });
    expect(sendMail).toHaveBeenCalledWith(
      { email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' },
      { to: ['bob@example.com'], cc: ['carol@example.com'], bcc: [], subject: 'Hello', text: 'Body text' },
    );
  });

  it('validates send input', async () => {
    const connector = createQqMailConnector(
      vaultWith({ email: 'a@qq.com', authCode: 'ABCD1234EFGH5678' }),
      { connectImap: async () => sessionWith([]) },
    );
    const missingTo = await connector.invoke('qq-mail.send', { subject: 'x', body: 'y' }, '');
    expect(missingTo).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });
});