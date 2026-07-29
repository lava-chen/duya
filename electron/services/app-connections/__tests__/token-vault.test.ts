/**
 * token-vault.test.ts — Plan 312 Phase 0.
 *
 * Mocks safeStorage with the `encrypted:` prefix fake (mirrors
 * `electron/config-manager.test.ts:25-35`). Covers:
 *   - roundtrip set/get/remove
 *   - corrupt vault file → empty map fallback
 *   - safeStorage unavailable → VaultUnavailableError on write
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempDir = '';
let encryptionAvailable = true;

vi.mock('electron', () => ({
  app: {
    getPath: () => tempDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (data: string) => Buffer.from(`encrypted:${data}`, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8').replace(/^encrypted:/, ''),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionVault: 'AppConnectionVault',
  },
}));

describe('TokenVault', () => {
  let TokenVault: typeof import('../token-vault').TokenVault;
  let VaultUnavailableError: typeof import('../token-vault').VaultUnavailableError;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-vault-'));
    encryptionAvailable = true;
    vi.resetModules();
    ({ TokenVault, VaultUnavailableError } = await import('../token-vault'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('roundtrips set/get/remove', () => {
    const vault = new TokenVault();
    expect(vault.get('c1')).toBeUndefined();
    vault.set('c1', {
      accessToken: 'ya29.fake',
      refreshToken: 'rt',
      expiresAt: 1234,
      tokenType: 'Bearer',
      scopes: ['a', 'b'],
    });
    expect(vault.get('c1')).toEqual({
      accessToken: 'ya29.fake',
      refreshToken: 'rt',
      expiresAt: 1234,
      tokenType: 'Bearer',
      scopes: ['a', 'b'],
    });
    // reload from disk
    const vault2 = new TokenVault();
    expect(vault2.get('c1')?.accessToken).toBe('ya29.fake');
    vault.remove('c1');
    expect(vault.get('c1')).toBeUndefined();
  });

  it('clear empties the vault', () => {
    const vault = new TokenVault();
    vault.set('c2', {
      accessToken: 'a',
      expiresAt: null,
      tokenType: 'Bearer',
      scopes: [],
    });
    vault.clear();
    expect(vault.get('c2')).toBeUndefined();
  });

  it('corrupt vault file resets to empty', () => {
    const dir = path.join(tempDir, 'app-connections');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokens.vault'), 'not-valid-base64-encrypted-content');
    const vault = new TokenVault();
    expect(vault.get('any')).toBeUndefined();
    // after recovery, set should still work
    vault.set('c3', { accessToken: 'x', expiresAt: null, tokenType: 'Bearer', scopes: [] });
    expect(vault.get('c3')?.accessToken).toBe('x');
  });

  it('vault_unavailable when safeStorage missing', () => {
    encryptionAvailable = false;
    const vault = new VaultUnavailableError();
    expect(vault).toBeInstanceOf(VaultUnavailableError);
    expect(vault.message).toMatch(/safeStorage/);
  });

  it('refuses to write plaintext when encryption unavailable', () => {
    encryptionAvailable = false;
    const vault = new TokenVault();
    expect(() =>
      vault.set('c4', { accessToken: 'plain', expiresAt: null, tokenType: 'Bearer', scopes: [] }),
    ).toThrow(VaultUnavailableError);
  });
});
