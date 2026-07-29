/**
 * TokenVault — safeStorage-encrypted persistence for App Connection tokens.
 *
 * Plan 312 Phase 0. Mirrors ConfigManager's vault pattern
 * (`electron/config/manager.ts:515-522`):
 *   safeStorage.encryptString(JSON.stringify(map)) → base64 →
 *   write-file-atomic (mode 0o600).
 *
 * Hard boundaries:
 * - Tokens NEVER leave the main process. No getter returns a token to
 *   a renderer or agent context.
 * - If `safeStorage.isEncryptionAvailable()` is false (e.g. headless
 *   Linux without libsecret), every mutation throws
 *   `{ code: 'vault_unavailable' }`. We refuse to persist plaintext.
 * - Corrupt vault file is treated as an empty map (warn + reset), so a
 *   single bad byte never blocks the authorization flow.
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { getLogger, LogComponent } from '../../logging/logger';
import type { TokenSet } from './types';

const COMPONENT = 'AppConnectionVault' as LogComponent;

/** thrown when safeStorage is unavailable; callers translate to `vault_unavailable`. */
export class VaultUnavailableError extends Error {
  constructor() {
    super('safeStorage encryption is not available; refusing to persist plaintext tokens');
    this.name = 'VaultUnavailableError';
  }
}

interface VaultShape {
  /** connectionId → encrypted-blob-per-entry is unnecessary: the whole map is
   * safeStorage-encrypted as one blob (mirrors ConfigManager). */
  tokens: Record<string, TokenSet>;
}

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'app-connections', 'tokens.vault');
}

export class TokenVault {
  private cache: VaultShape = { tokens: {} };
  private loaded = false;
  private readonly logger = getLogger();

  /** Lazily load the vault from disk; idempotent. */
  private load(): VaultShape {
    if (this.loaded) return this.cache;
    const file = vaultPath();
    try {
      if (!fs.existsSync(file)) {
        this.cache = { tokens: {} };
        this.loaded = true;
        return this.cache;
      }
      const raw = fs.readFileSync(file, 'utf-8');
      if (!safeStorage.isEncryptionAvailable()) {
        // We cannot decrypt without safeStorage; treat as empty so a
        // headless env doesn't crash the boot path. Mutations will still
        // throw VaultUnavailableError when attempting to write.
        this.logger.warn(
          'Vault file exists but safeStorage unavailable; treating as empty',
          undefined,
          COMPONENT,
        );
        this.cache = { tokens: {} };
        this.loaded = true;
        return this.cache;
      }
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'));
      const parsed = JSON.parse(decrypted) as VaultShape;
      this.cache = {
        tokens:
          parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object'
            ? parsed.tokens
            : {},
      };
      this.loaded = true;
      return this.cache;
    } catch (err) {
      // Corrupt file: reset to empty rather than block boot. Logged at WARN
      // so operators notice but users aren't stuck.
      this.logger.warn(
        'Token vault unreadable, resetting to empty',
        err instanceof Error ? err : new Error(String(err)),
        COMPONENT,
      );
      this.cache = { tokens: {} };
      this.loaded = true;
      return this.cache;
    }
  }

  /** Persist the in-memory map back to disk atomically. */
  private flush(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new VaultUnavailableError();
    }
    const file = vaultPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(this.cache);
    const encrypted = safeStorage.encryptString(json).toString('base64');
    writeFileAtomic.sync(file, encrypted, { mode: 0o600 });
    // Best-effort chmod; Windows no-ops, POSIX tightens to owner-only.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // not fatal
    }
  }

  /** Store or replace the token set for a connection. */
  set(connectionId: string, tokens: TokenSet): void {
    this.load();
    this.cache.tokens[connectionId] = { ...tokens };
    this.flush();
  }

  /** Read a connection's token set (main-process callers only). */
  get(connectionId: string): TokenSet | undefined {
    this.load();
    const entry = this.cache.tokens[connectionId];
    return entry ? { ...entry } : undefined;
  }

  /** Remove a single connection's tokens. */
  remove(connectionId: string): void {
    this.load();
    if (connectionId in this.cache.tokens) {
      delete this.cache.tokens[connectionId];
      this.flush();
    }
  }

  /** Empty the vault. Used by tests and full reset flows. */
  clear(): void {
    this.load();
    this.cache.tokens = {};
    this.flush();
  }

  /** Test hook: true if a vault file exists on disk. */
  exists(): boolean {
    return fs.existsSync(vaultPath());
  }
}
