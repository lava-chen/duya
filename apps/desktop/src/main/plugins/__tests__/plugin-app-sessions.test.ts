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

  it('records the hosting renderer when the launch names one', () => {
    const store = new PluginAppSessionStore();
    const hosted = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', webContentsId: 7 });
    const headless = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i' });

    expect(hosted.webContentsId).toBe(7);
    expect(headless.webContentsId).toBeUndefined();
  });
});

describe('PluginAppSessionStore.reapDead', () => {
  it('drops only the sessions whose renderer is gone', () => {
    const store = new PluginAppSessionStore();
    const alive = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', webContentsId: 1 });
    const crashed = store.open({ pluginId: 'p', appId: 'b', instanceId: 'i', webContentsId: 2 });

    const dropped = store.reapDead((id) => id === 1);

    expect(dropped.map((lease) => lease.session.sessionId)).toEqual([crashed.sessionId]);
    expect(store.get(alive.sessionId)).not.toBeNull();
    expect(store.get(crashed.sessionId)).toBeNull();
  });

  it('hands the dropped session its binding back, so it can be released', () => {
    const store = new PluginAppSessionStore();
    const session = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', webContentsId: 2 });
    store.setBinding(session.sessionId, { bindingId: 'b1', nonce: 'n1' });

    const [lease] = store.reapDead(() => false);

    // The record is gone from the store, so the caller could not look the
    // binding up afterwards: it has to come back out with the removal.
    expect(lease.binding).toEqual({ bindingId: 'b1', nonce: 'n1' });
    expect(store.bindingOf(session.sessionId)).toBeNull();
  });

  it('never reaps a session that records no host', () => {
    const store = new PluginAppSessionStore();
    const headless = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i' });

    // A test seam did not opt into a liveness check it cannot satisfy.
    expect(store.reapDead(() => false)).toEqual([]);
    expect(store.get(headless.sessionId)).not.toBeNull();
  });

  it('reports nothing when every renderer is alive', () => {
    const store = new PluginAppSessionStore();
    store.open({ pluginId: 'p', appId: 'a', instanceId: 'i', webContentsId: 1 });
    expect(store.reapDead(() => true)).toEqual([]);
    expect(store.size).toBe(1);
  });
});

describe('PluginAppSessionStore.evictOldest', () => {
  it('does nothing while the count is within the limit', () => {
    const store = new PluginAppSessionStore();
    const first = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i' });
    expect(store.evictOldest(1)).toEqual([]);
    expect(store.get(first.sessionId)).not.toBeNull();
  });

  it('drops the oldest sessions first', () => {
    const store = new PluginAppSessionStore();
    const first = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i' });
    const second = store.open({ pluginId: 'p', appId: 'b', instanceId: 'i' });
    const third = store.open({ pluginId: 'p', appId: 'c', instanceId: 'i' });

    const evicted = store.evictOldest(2);

    expect(evicted.map((lease) => lease.session.sessionId)).toEqual([first.sessionId]);
    expect(store.get(first.sessionId)).toBeNull();
    expect(store.get(second.sessionId)).not.toBeNull();
    expect(store.get(third.sessionId)).not.toBeNull();
    expect(store.size).toBe(2);
  });
});

describe('PluginAppSessionStore.take', () => {
  it('returns the session and its binding, and leaves nothing behind', () => {
    const store = new PluginAppSessionStore();
    const session = store.open({ pluginId: 'p', appId: 'a', instanceId: 'i' });
    store.setBinding(session.sessionId, { bindingId: 'b1', nonce: 'n1' });

    const lease = store.take(session.sessionId);

    expect(lease?.session).toEqual(session);
    expect(lease?.binding).toEqual({ bindingId: 'b1', nonce: 'n1' });
    expect(store.get(session.sessionId)).toBeNull();
    expect(store.bindingOf(session.sessionId)).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(new PluginAppSessionStore().take('ghost')).toBeNull();
  });
});
