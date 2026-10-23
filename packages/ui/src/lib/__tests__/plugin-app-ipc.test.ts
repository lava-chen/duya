import { describe, expect, it } from 'vitest';
import {
  PLUGIN_APP_CHANNEL,
  isPluginAppEntryUrl,
  getPluginAppDocumentToken,
  parsePluginAppCallResult,
  parsePluginAppGuestRequest,
  toPluginAppHostMessage,
} from '../plugin-app-ipc';

const DOCUMENT_TOKEN = 'a'.repeat(43);
const parseGuestRequest = (raw: unknown) => parsePluginAppGuestRequest(raw, DOCUMENT_TOKEN);

describe('isPluginAppEntryUrl', () => {
  it('accepts an app path on the loopback asset host', () => {
    const entryUrl = `http://127.0.0.1:49152/${DOCUMENT_TOKEN}/apps/demo/index.html`;
    expect(isPluginAppEntryUrl(entryUrl)).toBe(true);
    expect(getPluginAppDocumentToken(entryUrl)).toBe(DOCUMENT_TOKEN);
  });

  it('rejects URLs that are not served by the loopback asset host', () => {
    for (const value of [
      `https://127.0.0.1:49152/${DOCUMENT_TOKEN}/apps/demo/index.html`,
      `http://localhost:49152/${DOCUMENT_TOKEN}/apps/demo/index.html`,
      `http://127.0.0.2:49152/${DOCUMENT_TOKEN}/apps/demo/index.html`,
      `http://user@127.0.0.1:49152/${DOCUMENT_TOKEN}/apps/demo/index.html`,
      `http://127.0.0.1/${DOCUMENT_TOKEN}/apps/demo/index.html`,
      'http://127.0.0.1:49152/',
      `http://127.0.0.1:49152/${DOCUMENT_TOKEN}/apps/index.html?redirect=https://example.com`,
      'http://127.0.0.1:49152/not-a-random-token/apps/index.html',
      'not a URL',
      null,
    ]) {
      expect(isPluginAppEntryUrl(value)).toBe(false);
    }
  });
});

describe('parsePluginAppCallResult', () => {
  it('accepts only a well-formed host result', () => {
    expect(parsePluginAppCallResult({ ok: true, result: { bindingId: 'b1' } })).toEqual({
      ok: true,
      result: { bindingId: 'b1' },
    });
    expect(parsePluginAppCallResult({ ok: false, error: 'not_bound' })).toEqual({
      ok: false,
      error: 'not_bound',
    });
  });

  it('rejects malformed host results', () => {
    expect(parsePluginAppCallResult(null)).toBeNull();
    expect(parsePluginAppCallResult({ ok: 'yes' })).toBeNull();
    expect(parsePluginAppCallResult({ ok: true, error: 2 })).toBeNull();
  });
});

describe('parsePluginAppGuestRequest', () => {
  it('accepts the three known shapes', () => {
    expect(
      parseGuestRequest({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r1', method: 'bind' }),
    ).toEqual({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r1', method: 'bind' });
    expect(
      parseGuestRequest({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r2', method: 'revoke' }),
    ).toEqual({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r2', method: 'revoke' });
  });

  it('accepts an invoke with a tool and arguments', () => {
    expect(
      parseGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        documentToken: DOCUMENT_TOKEN,
        id: 'r3',
        method: 'invoke',
        toolId: 'mcp:demo/read',
        arguments: { cursor: 1 },
      }),
    ).toEqual({
      channel: PLUGIN_APP_CHANNEL,
      documentToken: DOCUMENT_TOKEN,
      id: 'r3',
      method: 'invoke',
      toolId: 'mcp:demo/read',
      arguments: { cursor: 1 },
    });
  });

  it('refuses a message on another channel', () => {
    expect(parseGuestRequest({ channel: 'other', documentToken: DOCUMENT_TOKEN, id: 'r1', method: 'bind' })).toBeNull();
  });

  it('refuses a request from a different document navigation', () => {
    expect(parsePluginAppGuestRequest({
      channel: PLUGIN_APP_CHANNEL,
      documentToken: 'b'.repeat(43),
      id: 'r1',
      method: 'bind',
    }, DOCUMENT_TOKEN)).toBeNull();
  });

  it('refuses a message without an id', () => {
    expect(parseGuestRequest({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, method: 'bind' })).toBeNull();
  });

  it('refuses malformed input', () => {
    expect(parseGuestRequest(null)).toBeNull();
    expect(parseGuestRequest('bind')).toBeNull();
    expect(parseGuestRequest([{ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r', method: 'bind' }])).toBeNull();
  });

  it('refuses an invoke without a usable tool or arguments', () => {
    expect(
      parseGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        documentToken: DOCUMENT_TOKEN,
        id: 'r4',
        method: 'invoke',
        toolId: '',
        arguments: {},
      }),
    ).toBeNull();
    expect(
      parseGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        documentToken: DOCUMENT_TOKEN,
        id: 'r5',
        method: 'invoke',
        toolId: 'mcp:demo/read',
      }),
    ).toBeNull();
    expect(
      parseGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        documentToken: DOCUMENT_TOKEN,
        id: 'r6',
        method: 'invoke',
        toolId: 'mcp:demo/read',
        arguments: [],
      }),
    ).toBeNull();
  });
});

describe('toPluginAppHostMessage', () => {
  it('sends only the method for bind and revoke', () => {
    expect(
      toPluginAppHostMessage({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r1', method: 'bind' }),
    ).toEqual({ method: 'bind' });
    expect(
      toPluginAppHostMessage({ channel: PLUGIN_APP_CHANNEL, documentToken: DOCUMENT_TOKEN, id: 'r2', method: 'revoke' }),
    ).toEqual({ method: 'revoke' });
  });

  it('keeps the tool and arguments for an invoke', () => {
    expect(
      toPluginAppHostMessage({
        channel: PLUGIN_APP_CHANNEL,
        documentToken: DOCUMENT_TOKEN,
        id: 'r3',
        method: 'invoke',
        toolId: 'mcp:demo/read',
        arguments: { cursor: 1 },
      }),
    ).toEqual({ method: 'invoke', toolId: 'mcp:demo/read', arguments: { cursor: 1 } });
  });

  it('never forwards the guest-chosen id or channel', () => {
    const message = toPluginAppHostMessage({
      channel: PLUGIN_APP_CHANNEL,
      documentToken: DOCUMENT_TOKEN,
      id: 'r4',
      method: 'bind',
    });
    expect(message).not.toHaveProperty('id');
    expect(message).not.toHaveProperty('channel');
  });
});
