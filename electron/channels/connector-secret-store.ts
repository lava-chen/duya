/**
 * ConnectorSecretStore — per-agent channel credential store.
 *
 * Storage layout (plan 488 §3.3):
 *   ~/.duya/agents/<agentId>/connector-secrets/<platform>.json
 *
 * Security principles:
 * - Credentials are NEVER passed to the agent subprocess.
 * - Only the main process reads these files.
 * - All file writes are atomic (tmp + rename).
 * - Bot receives only an acknowledgement that a secret was stored, not the value.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import type { ConnectorSecretRecord } from '../../packages/agent/src/channels/types';

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Resolve the connector-secrets root for a specific agent.
 * `<userData>/agents/<agentId>/connector-secrets/`
 */
function resolveAgentSecretsDir(agentId: string): string {
  if (!agentId || agentId.includes(path.sep) || agentId.includes('/')) {
    throw new Error(`Invalid agentId: "${agentId}"`);
  }
  return path.join(app.getPath('userData'), 'agents', agentId, 'connector-secrets');
}

/**
 * Resolve the secret file path for a specific platform.
 * `<userData>/agents/<agentId>/connector-secrets/<platform>.json`
 */
function resolveSecretPath(agentId: string, platform: string): string {
  return path.join(resolveAgentSecretsDir(agentId), `${platform}.json`);
}

// =============================================================================
// ConnectorSecretStore interface
// =============================================================================

export interface ConnectorSecretStore {
  /**
   * Store a credential value for a specific platform.
   * Merges with existing fields — does not overwrite unrelated fields.
   */
  setSecret(agentId: string, platform: string, field: string, value: string): void;

  /**
   * Retrieve a credential value. Returns null if missing.
   * Returns null if the agentId or platform is not configured.
   */
  getSecret(agentId: string, platform: string, field: string): string | null;

  /**
   * Remove all credentials for a specific agent + platform.
   * Idempotent: succeeds even if not configured.
   */
  removeAgentPlatform(agentId: string, platform: string): void;

  /**
   * Check whether a credential exists for a specific platform.
   */
  hasPlatform(agentId: string, platform: string): boolean;

  /**
   * List all platforms that have credentials stored for an agent.
   */
  listPlatforms(agentId: string): string[];
}

// =============================================================================
// ConnectorSecretStore implementation
// =============================================================================

/**
 * File-backed credential store.
 *
 * File format: `agents/<agentId>/connector-secrets/<platform>.json`
 * Schema: `ConnectorSecretRecord` (field → value map)
 *
 * Each platform has one file containing all its credential fields (e.g. token,
 * botToken, appSecret). This makes credential rotation and revocation simple.
 */
export class FileConnectorSecretStore implements ConnectorSecretStore {
  // ---------------------------------------------------------------------------
  // ConnectorSecretStore implementation
  // ---------------------------------------------------------------------------

  setSecret(agentId: string, platform: string, field: string, value: string): void {
    if (!field || typeof field !== 'string') {
      throw new Error('setSecret: field must be a non-empty string');
    }
    if (!value || typeof value !== 'string') {
      throw new Error('setSecret: value must be a non-empty string');
    }
    const secretPath = resolveSecretPath(agentId, platform);
    const dir = path.dirname(secretPath);

    // Read existing record (if any)
    let record: ConnectorSecretRecord = {};
    if (fs.existsSync(secretPath)) {
      try {
        const raw = fs.readFileSync(secretPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          record = parsed as ConnectorSecretRecord;
        }
      } catch {
        // Corrupted — start fresh
        record = {};
      }
    }

    // Merge new value
    record[field] = value;

    // Atomic write
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${secretPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, secretPath);
  }

  getSecret(agentId: string, platform: string, field: string): string | null {
    const secretPath = resolveSecretPath(agentId, platform);
    if (!fs.existsSync(secretPath)) return null;
    try {
      const raw = fs.readFileSync(secretPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        field in (parsed as ConnectorSecretRecord)
      ) {
        const val = (parsed as ConnectorSecretRecord)[field];
        return typeof val === 'string' ? val : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  removeAgentPlatform(agentId: string, platform: string): void {
    const secretPath = resolveSecretPath(agentId, platform);
    if (fs.existsSync(secretPath)) {
      fs.rmSync(secretPath, { force: true });
    }
  }

  hasPlatform(agentId: string, platform: string): boolean {
    return fs.existsSync(resolveSecretPath(agentId, platform));
  }

  listPlatforms(agentId: string): string[] {
    const dir = resolveAgentSecretsDir(agentId);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter((entry) => {
        const fullPath = path.join(dir, entry);
        return fs.statSync(fullPath).isFile() && entry.endsWith('.json');
      }).map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}

// =============================================================================
// Module-level singleton (for use throughout electron main process)
// =============================================================================

let _instance: FileConnectorSecretStore | null = null;

export function getConnectorSecretStore(): ConnectorSecretStore {
  if (!_instance) {
    _instance = new FileConnectorSecretStore();
  }
  return _instance;
}
