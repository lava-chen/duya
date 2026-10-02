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
 * - Reads in that same state are reported through
 *   {@link TokenVault.isUnavailable} rather than as an empty vault, so a
 *   live OAuth grant is never mistaken for a revoked one. The read is not
 *   cached, so it recovers on its own once safeStorage comes back.
 * - Corrupt vault file is treated as an empty map (warn + reset), so a
 *   single bad byte never blocks the authorization flow.
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { getLogger, LogComponent } from '../../logging/logger';
import type { ProviderId, TokenSet } from './types';

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
  /** Per-install OAuth application credentials. Never cross IPC. */
  oauthClients: Partial<Record<ProviderId, { clientId: string; clientSecret?: string }>>;
  /**
   * OAuth client-registration and PKCE state for Remote MCP connections.
   * The provider response can contain a public-client secret, so this state is
   * stored in the same encrypted vault as access tokens.
   */
  mcpOAuth: Record<string, {
    clientInformation?: Record<string, unknown>;
    codeVerifier?: string;
    discovery?: Record<string, unknown>;
    redirectUri?: string;
  }>;
}

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'app-connections', 'tokens.vault');
}

export class TokenVault {
  private cache: VaultShape = { tokens: {}, oauthClients: {}, mcpOAuth: {} };
  private loaded = false;
  /** A vault file exists but could not be decrypted. See {@link isUnavailable}. */
  private unavailable = false;
  private readonly logger = getLogger();

  /** Lazily load the vault from disk; idempotent. */
  private load(): VaultShape {
    if (this.loaded) return this.cache;
    const file = vaultPath();
    try {
      if (!fs.existsSync(file)) {
        this.cache = { tokens: {}, oauthClients: {}, mcpOAuth: {} };
        this.loaded = true;
        return this.cache;
      }
      const raw = fs.readFileSync(file, 'utf-8');
      if (!safeStorage.isEncryptionAvailable()) {
        // The file is there; we just cannot read it. Do NOT mark the vault
        // loaded. An empty-but-loaded vault is indistinguishable from "this
        // connection has no tokens", and callers acted on that difference
        // by flipping live OAuth grants to `revoked` and persisting it.
        // Leaving `loaded` false means a later call retries — safeStorage
        // can become available mid-session once a keyring is set up — and
        // isUnavailable() lets callers report `vault_unavailable` instead
        // of `connection_revoked`. Warn only on the transition, otherwise
        // every read would re-log.
        if (!this.unavailable) {
          this.unavailable = true;
          this.logger.warn(
            'Vault file exists but safeStorage unavailable; reads report vault_unavailable and will retry',
            undefined,
            COMPONENT,
          );
        }
        this.cache = { tokens: {}, oauthClients: {}, mcpOAuth: {} };
        return this.cache;
      }
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'));
      const parsed = JSON.parse(decrypted) as VaultShape;
      this.cache = {
        tokens:
          parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object'
            ? parsed.tokens
            : {},
        oauthClients:
          parsed && typeof parsed === 'object' && parsed.oauthClients && typeof parsed.oauthClients === 'object'
            ? parsed.oauthClients
            : {},
        mcpOAuth:
          parsed && typeof parsed === 'object' && parsed.mcpOAuth && typeof parsed.mcpOAuth === 'object'
            ? parsed.mcpOAuth
            : {},
      };
      this.loaded = true;
      this.unavailable = false;
      return this.cache;
    } catch (err) {
      // Corrupt file: reset to empty rather than block boot. Logged at WARN
      // so operators notice but users aren't stuck.
      this.logger.warn(
        'Token vault unreadable, resetting to empty',
        err instanceof Error ? err : new Error(String(err)),
        COMPONENT,
      );
      this.cache = { tokens: {}, oauthClients: {}, mcpOAuth: {} };
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

  /** Store a user-owned OAuth application configuration in the encrypted vault. */
  setOAuthClient(provider: ProviderId, credentials: { clientId: string; clientSecret?: string }): void {
    this.load();
    this.cache.oauthClients[provider] = {
      clientId: credentials.clientId,
      ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
    };
    this.flush();
  }

  /** Main-process-only OAuth application configuration. */
  getOAuthClient(provider: ProviderId): { clientId: string; clientSecret?: string } | undefined {
    this.load();
    const entry = this.cache.oauthClients[provider];
    return entry ? { ...entry } : undefined;
  }

  /** Remove provider-scoped credentials for custom-credential connectors. */
  removeOAuthClient(provider: ProviderId): void {
    this.load();
    if (provider in this.cache.oauthClients) {
      delete this.cache.oauthClients[provider];
      this.flush();
    }
  }

  getMcpOAuth(connectionId: string): {
    clientInformation?: Record<string, unknown>;
    codeVerifier?: string;
    discovery?: Record<string, unknown>;
    redirectUri?: string;
  } | undefined {
    this.load();
    const entry = this.cache.mcpOAuth[connectionId];
    return entry ? { ...entry } : undefined;
  }

  setMcpOAuth(
    connectionId: string,
    state: {
      clientInformation?: Record<string, unknown>;
      codeVerifier?: string;
      discovery?: Record<string, unknown>;
      redirectUri?: string;
    },
  ): void {
    this.load();
    this.cache.mcpOAuth[connectionId] = { ...state };
    this.flush();
  }

  removeMcpOAuth(connectionId: string): void {
    this.load();
    if (connectionId in this.cache.mcpOAuth) {
      delete this.cache.mcpOAuth[connectionId];
      this.flush();
    }
  }

  /** Empty the vault. Used by tests and full reset flows. */
  clear(): void {
    this.load();
    this.cache.tokens = {};
    this.cache.oauthClients = {};
    this.cache.mcpOAuth = {};
    this.flush();
  }

  /** Test hook: true if a vault file exists on disk. */
  exists(): boolean {
    return fs.existsSync(vaultPath());
  }

  /**
   * True when a vault file exists on disk but could not be decrypted
   * because safeStorage is unavailable.
   *
   * This is deliberately distinct from "the vault holds no tokens for
   * that connection". Callers must not report `connection_revoked` on
   * this state — the grant may well still be live; we just cannot read it
   * yet. Retryable: the flag clears as soon as a load succeeds.
   */
  isUnavailable(): boolean {
    return this.unavailable;
  }
}
