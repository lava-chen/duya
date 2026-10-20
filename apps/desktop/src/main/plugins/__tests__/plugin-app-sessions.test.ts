import { describe, expect, it } from 'vitest';
import {
  PluginAppSessionStore,
  authorizePluginAppCall,
  parsePluginAppGuestMessage,
} from '../plugin-app-sessions';

describe('parsePluginAppGuestMessage', () => {
  it('accepts the three known shapes', () => {
    expect(parsePluginAppGuestMessage({ method: 'bind' })).toEqual({ method: 'bind' });
    expect(parsePluginAppGuestMessage({ method: 'revoke' })).toEqual({ method: 'revoke' });
    expect(
      parsePluginAppGuestMessage({ method: 'invoke', toolId: 'mcp:demo/read', arguments: { a: 1 } }),
    ).toEqual({ method: 'invoke', toolId: 'mcp:demo/read', arguments: { a: 1 } });
  });

  it('refuses extra fields on bind and revoke', () => {
    expect(parsePluginAppGuestMessage({ method: 'bind', toolId: 'x' })).toBeNull();
    expect(parsePluginAppGuestMessage({ method: 'revoke', sessionId: 'x' })).toBeNull();
  });

  it('refuses an unknown method', () => {
    expect(parsePluginAppGuestMessage({ method: 'delete_everything' })).toBeNull();
  });

  it('refuses malformed input', () => {
    expect(parsePluginAppGuestMessage(null)).toBeNull();
    expect(parsePluginAppGuestMessage('bind')).toBeNull();
    expect(parsePluginAppGuestMessage([{ method: 'bind' }])).toBeNull();
    expect(parsePluginAppGuestMessage({ method: 'invoke', toolId: '', arguments: {} })).toBeNull();
    expect(parsePluginAppGuestMessage({ method: 'invoke', toolId: 't' })).toBeNull();
    expect(parsePluginAppGuestMessage({ method: 'invoke', toolId: 't', arguments: [] })).toBeNull();
  });

  it('refuses an invoke with too many argument keys', () => {
    const args: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) args[`k${index}`] = index;
    expect(parsePluginAppGuestMessage({ method: 'invoke', toolId: 't', arguments: args })).toBeNull();
  });
});

describe('authorizePluginAppCall', () => {
  const store = new PluginAppSessionStore();
  const session = store.open({
    pluginId: 'com.duya.demo',
    appId: 'hello',
    instanceId: 'instance-1',
    chatSessionId: 'session-1',
  });

  it('rejects a call for a session that does not exist', () => {
    expect(authorizePluginAppCall(null, session.launchNonce, { method: 'bind' })).toEqual({
      ok: false,
      reason: 'unknown_session',
    });
  });

  it('rejects a call whose freshness token does not match', () => {
    expect(authorizePluginAppCall(session, 'not-the-nonce', { method: 'bind' })).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    });
    expect(authorizePluginAppCall(session, undefined, { method: 'bind' })).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    });
  });

  it('rejects a message it cannot parse', () => {
    expect(authorizePluginAppCall(session, session.launchNonce, { method: 'nope' })).toEqual({
      ok: false,
      reason: 'invalid_message',
    });
  });

  it('accepts a well-formed call', () => {
    expect(authorizePluginAppCall(session, session.launchNonce, { method: 'bind' })).toEqual({
      ok: true,
      message: { method: 'bind' },
    });
  });
});

describe('PluginAppSessionStore', () => {
  it('mints a session that carries the launch authority, not the guest', () => {
    const store = new PluginAppSessionStore();
    const session = store.open({
      pluginId: 'com.duya.demo',
      appId: 'hello',
      instanceId: 'instance-1',
      chatSessionId: 'session-1',
    });

    expect(session.pluginId).toBe('com.duya.demo');
    expect(session.appId).toBe('hello');
    expect(session.instanceId).toBe('instance-1');
    expect(session.chatSessionId).toBe('session-1');
    expect(session.launchNonce.length).toBeGreaterThanOrEqual(32);
    expect(store.get(session.sessionId)).toEqual(session);
  });

  it('mints a different nonce and session id per launch', () => {
    const store = new PluginAppSessionStore();
    const first = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', chatSessionId: 's' });
    const second = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', chatSessionId: 's' });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.launchNonce).not.toBe(second.launchNonce);
  });

  it('keeps the binding per session', () => {
    const store = new PluginAppSessionStore();
    const first = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', chatSessionId: 's' });
    const second = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', chatSessionId: 's' });

    expect(store.setBinding(first.sessionId, { bindingId: 'b1', nonce: 'n1' })).toBe(true);
    expect(store.bindingOf(first.sessionId)).toEqual({ bindingId: 'b1', nonce: 'n1' });
    expect(store.bindingOf(second.sessionId)).toBeNull();
  });

  it('drops the binding when the session closes', () => {
    const store = new PluginAppSessionStore();
    const session = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', chatSessionId: 's' });
    store.setBinding(session.sessionId, { bindingId: 'b1', nonce: 'n1' });

    expect(store.close(session.sessionId)).toBe(true);
    expect(store.get(session.sessionId)).toBeNull();
    expect(store.bindingOf(session.sessionId)).toBeNull();
    expect(store.close(session.sessionId)).toBe(false);
  });

  it('refuses to bind a session that does not exist', () => {
    const store = new PluginAppSessionStore();
    expect(store.setBinding('ghost', { bindingId: 'b1', nonce: 'n1' })).toBe(false);
  });
});
