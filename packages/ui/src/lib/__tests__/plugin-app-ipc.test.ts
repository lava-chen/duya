import { describe, expect, it } from 'vitest';
import {
  PLUGIN_APP_CHANNEL,
  parsePluginAppGuestRequest,
  toPluginAppHostMessage,
} from '../plugin-app-ipc';

describe('parsePluginAppGuestRequest', () => {
  it('accepts the three known shapes', () => {
    expect(
      parsePluginAppGuestRequest({ channel: PLUGIN_APP_CHANNEL, id: 'r1', method: 'bind' }),
    ).toEqual({ channel: PLUGIN_APP_CHANNEL, id: 'r1', method: 'bind' });
    expect(
      parsePluginAppGuestRequest({ channel: PLUGIN_APP_CHANNEL, id: 'r2', method: 'revoke' }),
    ).toEqual({ channel: PLUGIN_APP_CHANNEL, id: 'r2', method: 'revoke' });
  });

  it('accepts an invoke with a tool and arguments', () => {
    expect(
      parsePluginAppGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        id: 'r3',
        method: 'invoke',
        toolId: 'mcp:demo/read',
        arguments: { cursor: 1 },
      }),
    ).toEqual({
      channel: PLUGIN_APP_CHANNEL,
      id: 'r3',
      method: 'invoke',
      toolId: 'mcp:demo/read',
      arguments: { cursor: 1 },
    });
  });

  it('refuses a message on another channel', () => {
    expect(parsePluginAppGuestRequest({ channel: 'other', id: 'r1', method: 'bind' })).toBeNull();
  });

  it('refuses a message without an id', () => {
    expect(parsePluginAppGuestRequest({ channel: PLUGIN_APP_CHANNEL, method: 'bind' })).toBeNull();
  });

  it('refuses malformed input', () => {
    expect(parsePluginAppGuestRequest(null)).toBeNull();
    expect(parsePluginAppGuestRequest('bind')).toBeNull();
    expect(parsePluginAppGuestRequest([{ channel: PLUGIN_APP_CHANNEL, id: 'r', method: 'bind' }])).toBeNull();
  });

  it('refuses an invoke without a usable tool or arguments', () => {
    expect(
      parsePluginAppGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        id: 'r4',
        method: 'invoke',
        toolId: '',
        arguments: {},
      }),
    ).toBeNull();
    expect(
      parsePluginAppGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
        id: 'r5',
        method: 'invoke',
        toolId: 'mcp:demo/read',
      }),
    ).toBeNull();
    expect(
      parsePluginAppGuestRequest({
        channel: PLUGIN_APP_CHANNEL,
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
      toPluginAppHostMessage({ channel: PLUGIN_APP_CHANNEL, id: 'r1', method: 'bind' }),
    ).toEqual({ method: 'bind' });
    expect(
      toPluginAppHostMessage({ channel: PLUGIN_APP_CHANNEL, id: 'r2', method: 'revoke' }),
    ).toEqual({ method: 'revoke' });
  });

  it('keeps the tool and arguments for an invoke', () => {
    expect(
      toPluginAppHostMessage({
        channel: PLUGIN_APP_CHANNEL,
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
      id: 'r4',
      method: 'bind',
    });
    expect(message).not.toHaveProperty('id');
    expect(message).not.toHaveProperty('channel');
  });
});
