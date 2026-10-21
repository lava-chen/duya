/**
 * wecom-connector.test.ts — WeCom connector (Plan 312 Phase 3, custom
 * credential provider). Verifies:
 *   - listDescriptors returns 9 category tools with wecom_ prefix
 *   - invoke spawns `wecom-cli <category> <operation> '<params>'`
 *   - credentials are injected into the child env from the vault
 *   - missing operation → missing_operation
 *   - unknown action → unknown_action
 *   - non-zero exit → provider_error
 *   - JSON stdout parsed; raw text wrapped
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWeComConnector,
  listWeComDescriptors,
  type SpawnWecomCliFn,
  type WeComCliResult,
} from '../connectors/wecom.js';
import type { TokenVault } from '../token-vault.js';

/** Minimal in-memory vault double exposing only the OAuth-client slot. */
function makeVault(oauth?: { clientId: string; clientSecret?: string }): TokenVault {
  return {
    getOAuthClient: () => oauth,
    get: () => undefined,
  } as unknown as TokenVault;
}

function makeSpawner(
  impl: (scheme: { category: string; operation: string; params: string }, env: Record<string, string | undefined>) => Promise<WeComCliResult>,
): SpawnWecomCliFn {
  return vi.fn(impl);
}

describe('listWeComDescriptors', () => {
  it('returns 9 category tools with wecom_ prefix and provider wecom', () => {
    const descs = listWeComDescriptors('conn-1');
    expect(descs).toHaveLength(9);
    const names = descs.map((d) => d.name);
    expect(names).toContain('wecom_msg');
    expect(names).toContain('wecom_todo');
    expect(names).toContain('wecom_contact');
    for (const d of descs) {
      expect(d.provider).toBe('wecom');
      expect(d.connectionId).toBe('conn-1');
      expect(d.action.startsWith('wecom:')).toBe(true);
    }
  });
});

describe('createWeComConnector().invoke', () => {
  it('injects vault credentials into the child env and parses JSON stdout', async () => {
    const vault = makeVault({ clientId: 'corp123', clientSecret: 'secret456' });
    const spawner = makeSpawner(async (scheme, env) => ({
      stdout: JSON.stringify({ errcode: 0, errmsg: 'ok', userlist: [] }),
      exitCode: 0,
    }));
    const connector = createWeComConnector(vault, spawner);

    const result = await connector.invoke(
      'wecom:contact',
      { operation: 'get_userlist', params: {} },
      '',
    );

    expect(result.success).toBe(true);
    expect(spawner).toHaveBeenCalledWith(
      { category: 'contact', operation: 'get_userlist', params: '{}' },
      expect.objectContaining({
        WECOM_BOT_ID: 'corp123',
        WECOM_SECRET: 'secret456',
      }),
    );
    expect(result).toEqual({ success: true, data: { errcode: 0, errmsg: 'ok', userlist: [] } });
  });

  it('requires an operation', async () => {
    const connector = createWeComConnector(makeVault(), makeSpawner(async () => ({ stdout: '', exitCode: 0 })));
    const result = await connector.invoke('wecom:msg', { params: {} }, '');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('missing_operation');
  });

  it('rejects unknown actions', async () => {
    const connector = createWeComConnector(makeVault(), makeSpawner(async () => ({ stdout: '', exitCode: 0 })));
    const result = await connector.invoke('slack:search', { operation: 'x' }, '');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('unknown_action');
  });

  it('surfaces non-zero exit as provider_error', async () => {
    const connector = createWeComConnector(
      makeVault(),
      makeSpawner(async () => ({ stdout: '', exitCode: 1, error: 'boom' })),
    );
    const result = await connector.invoke('wecom:doc', { operation: 'create_doc' }, '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('boom');
    }
  });

  it('wraps raw (non-JSON) stdout as data', async () => {
    const connector = createWeComConnector(
      makeVault(),
      makeSpawner(async () => ({ stdout: 'plain text output', exitCode: 0 })),
    );
    const result = await connector.invoke('wecom:contact', { operation: 'get_userlist' }, '');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ errcode: 0, errmsg: 'ok', data: 'plain text output' });
  });
});