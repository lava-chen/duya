/**
 * state-store.test.ts — verifies the WeixinStateStore per-agent path isolation
 * (plan 488): a state store rooted at a custom directory keeps one account's
 * context_token/sync_buf separate from another account, so per-bot connectors
 * cannot collide through the default `~/.duya/gateway/weixin` layout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WeixinStateStore } from './state-store';

describe('WeixinStateStore (per-agent isolation)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-wxstore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reloads context_token within the provided root', () => {
    const store = new WeixinStateStore('acctA', dir);
    store.setContextToken('peer1', 'tok1');
    store.flush();

    const reloaded = new WeixinStateStore('acctA', dir);
    expect(reloaded.getContextToken('peer1')).toBe('tok1');
  });

  it('isolates state between different accounts in the same root', () => {
    const a = new WeixinStateStore('acctA', dir);
    a.setContextToken('peer1', 'tok1');
    a.flush();

    // A different account under the same root must not see acctA's tokens.
    const b = new WeixinStateStore('acctB', dir);
    expect(b.getContextToken('peer1')).toBeUndefined();
  });
});