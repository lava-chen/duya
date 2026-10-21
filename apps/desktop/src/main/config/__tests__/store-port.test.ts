/**
 * Tests for the MessagePort subscription backend of ConfigStore
 * (plan 334 Phase 5 — config-port wired to ConfigStore).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore, type ConfigStoreOptions } from '../store';

type MessageListener = (event: { data: unknown }) => void;

/** Minimal fake MessagePortMain for driving the config-port protocol. */
class FakePort {
  private listeners = new Set<MessageListener>();
  public started = false;
  public closed = false;
  public sent: unknown[] = [];

  on(event: string, cb: MessageListener): this {
    if (event === 'message') this.listeners.add(cb);
    return this;
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  /** Simulate a renderer-side message arriving on the port. */
  emit(message: unknown): void {
    for (const cb of this.listeners) cb({ data: message });
  }

  /** All `type` values received from the main process, in order. */
  receivedTypes(): string[] {
    return this.sent.filter(
      (m): m is { type: string } => typeof m === 'object' && m !== null && 'type' in m,
    ).map((m) => m.type);
  }

  last<T>(type: string): T | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i] as { type?: string } | null;
      if (m && m.type === type) return this.sent[i] as T;
    }
    return undefined;
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-store-port-'));
}

let dir: string;
let opts: ConfigStoreOptions;

beforeEach(() => {
  dir = tmpDir();
  opts = {
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type UpdateMsg = { type: 'config:update'; config: Record<string, unknown> };
type ResponseMsg = { type: 'config:response'; key: string; value: unknown };
type ErrorMsg = { type: 'error'; message: string };

describe('ConfigStore MessagePort subscription', () => {
  it('sends an immediate config:update with a flat view on addSubscriber', () => {
    const store = new ConfigStore(opts);
    store.set('providers.minimax.baseUrl', 'https://api.minimax.chat');
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');

    expect(port.started).toBe(true);
    expect(port.receivedTypes()).toContain('config:update');
    const update = port.last<UpdateMsg>('config:update');
    expect(update?.config).toBeDefined();
    // Flat view maps apiProviders -> providers snapshot.
    const providers = update?.config.apiProviders as Record<string, unknown> | undefined;
    expect(providers?.minimax).toEqual({ baseUrl: 'https://api.minimax.chat' });
  });

  it('handleGet serves a flat key via its nested path', () => {
    const store = new ConfigStore(opts);
    store.set('model.provider', 'minimax');
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');

    port.emit({ type: 'config:get', key: 'defaultProviderId' });
    const resp = port.last<ResponseMsg>('config:response');
    expect(resp?.key).toBe('defaultProviderId');
    expect(resp?.value).toBe('minimax');
  });

  it('handleSet writes through ConfigStore and persists to TOML', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');

    port.emit({ type: 'config:set', key: 'defaultProviderId', value: 'anthropic' });
    const resp = port.last<ResponseMsg>('config:response');
    expect(resp?.key).toBe('defaultProviderId');
    expect(store.get().model.provider).toBe('anthropic');

    const onDisk = fs.readFileSync(opts.configPath, 'utf-8');
    expect(onDisk).toContain('anthropic');
  });

  it('broadcasts config:update to ports after a set', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');
    const before = port.receivedTypes().filter((t) => t === 'config:update').length;

    port.emit({ type: 'config:set', key: 'timezone', value: 'UTC' });
    const after = port.receivedTypes().filter((t) => t === 'config:update').length;
    expect(after).toBeGreaterThan(before);
    const update = port.last<UpdateMsg>('config:update');
    expect(update?.config.timezone).toBe('UTC');
  });

  it('stores an unmapped flat key at the snapshot top level and includes it in broadcasts', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');

    port.emit({ type: 'config:set', key: 'someCustomFlat', value: { hello: 1 } });
    const update = port.last<UpdateMsg>('config:update');
    expect(update?.config.someCustomFlat).toEqual({ hello: 1 });
    expect(store.getByPath('someCustomFlat')).toEqual({ hello: 1 });
  });

  it('enforces agent role permission: only agentSettings/visionSettings/outputStyles', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'agent');

    // Allowed.
    port.emit({ type: 'config:set', key: 'agentSettings', value: { max_turns: 5 } });
    expect(store.get().agent.max_turns).toBe(5);

    // Denied.
    port.emit({ type: 'config:set', key: 'defaultProviderId', value: 'oops' });
    const err = port.last<ErrorMsg>('error');
    expect(err?.message).toMatch(/Permission denied/);
    expect(store.get().model.provider).toBe('');

    // Denied unmapped key too.
    port.emit({ type: 'config:set', key: 'someFlat', value: 1 });
    expect(port.last<ErrorMsg>('error')?.message).toMatch(/Permission denied/);
  });

  it('renderer role can write any key', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');

    port.emit({ type: 'config:set', key: 'defaultProviderId', value: 'openai' });
    expect(store.get().model.provider).toBe('openai');
    expect(port.last<ErrorMsg>('error')).toBeUndefined();
  });

  it('removeSubscriber stops further broadcasts to that port', () => {
    const store = new ConfigStore(opts);
    const port = new FakePort();
    store.addSubscriber(port as never, 'renderer');
    const before = port.receivedTypes().filter((t) => t === 'config:update').length;

    store.removeSubscriber(port as never);
    store.set('timezone', 'UTC');
    const after = port.receivedTypes().filter((t) => t === 'config:update').length;
    expect(after).toBe(before);
  });
});