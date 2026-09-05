/**
 * FileChannelStore — per-agent channel metadata store.
 *
 * Storage layout (plan 488 §3.2):
 *   ~/.duya/agents/<agentId>/channels/<platform>/connection.json
 *
 * Principles (mirrors grok-bot `FileChannelStore`):
 * - Credentials are NEVER stored here (see `connector-secret-store.ts`).
 * - All file writes are atomic (tmp + rename).
 * - The agent subprocess never sees this file directly — only the main process
 *   reads it and passes channel snapshots to the agent prompt context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import type {
  ChannelAddress,
  ChannelConnectionConfig,
  ConnectorManifest,
} from '../../packages/agent/src/channels/types';
import {
  formatChannelAddress,
  isKnownPlatform,
  KNOWN_PLATFORMS,
} from '../../packages/agent/src/channels/types';

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Resolve the root agents directory.
 * In production: `<userData>/agents/`
 * In dev: `<userData>/agents/` (same layout, isolated via `app.setPath('userData')`)
 */
function resolveAgentsDir(): string {
  return path.join(app.getPath('userData'), 'agents');
}

/**
 * Resolve the channels root for a specific agent.
 * `<agentsDir>/<agentId>/channels/`
 */
function resolveAgentChannelsDir(agentId: string): string {
  if (!agentId || agentId.includes(path.sep) || agentId.includes('/')) {
    throw new Error(`Invalid agentId: "${agentId}"`);
  }
  return path.join(resolveAgentsDir(), agentId, 'channels');
}

/**
 * Resolve the connection config path for a specific platform channel.
 * `<agentsDir>/<agentId>/channels/<platform>/connection.json`
 */
function resolveChannelConfigPath(agentId: string, platform: string): string {
  if (!isKnownPlatform(platform)) {
    throw new Error(`Unknown platform: "${platform}". Known: ${[...KNOWN_PLATFORMS].join(', ')}`);
  }
  return path.join(resolveAgentChannelsDir(agentId), platform, 'connection.json');
}

/**
 * Resolve the directory containing the connection config (used for mkdir).
 */
function resolveChannelDir(agentId: string, platform: string): string {
  return path.join(resolveAgentChannelsDir(agentId), platform);
}

// =============================================================================
// ChannelStore interface
// =============================================================================

export interface ChannelStore {
  /** All platforms that have a connection entry on disk. */
  listPlatforms(): string[];

  /**
   * Human-readable label for a configured platform, or null if not configured.
   * Returns null for platforms that are known but not yet connected.
   */
  readLabel(platform: string): string | null;

  /**
   * Full list of configured channels (platform + label + 'configured' status).
   * Only returns platforms that have a connection.json on disk.
   */
  listConnections(): Array<{ platform: string; label: string; status: 'configured' }>;

  /**
   * Persist channel metadata (label only — no credentials).
   * Creates intermediate directories as needed.
   */
  writeMetadata(platform: string, label: string): void;

  /**
   * Remove a channel entry and its credentials atomically.
   * Idempotent: succeeds even if the channel is not configured.
   */
  remove(platform: string): void;
}

// =============================================================================
// FileChannelStore implementation
// =============================================================================

/**
 * File-backed ChannelStore.
 *
 * File format: `agents/<agentId>/channels/<platform>/connection.json`
 * Schema: `ChannelConnectionConfig` (label + connectedAt)
 */
export class FileChannelStore implements ChannelStore {
  private readonly agentId: string;

  constructor(agentId: string) {
    if (!agentId || agentId.includes(path.sep) || agentId.includes('/')) {
      throw new Error(`FileChannelStore: invalid agentId "${agentId}"`);
    }
    this.agentId = agentId;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _configPath(platform: string): string {
    return resolveChannelConfigPath(this.agentId, platform);
  }

  private _channelDir(platform: string): string {
    return resolveChannelDir(this.agentId, platform);
  }

  /**
   * Read and parse a connection config, or return null if missing.
   */
  private _readConfig(platform: string): ChannelConnectionConfig | null {
    const filePath = this._configPath(platform);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'label' in parsed &&
        typeof (parsed as ChannelConnectionConfig).label === 'string'
      ) {
        return parsed as ChannelConnectionConfig;
      }
      // Malformed — treat as missing
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Atomically write a connection config (tmp + rename).
   */
  private _writeConfig(platform: string, config: ChannelConnectionConfig): void {
    const filePath = this._configPath(platform);
    const dir = this._channelDir(platform);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  // ---------------------------------------------------------------------------
  // ChannelStore implementation
  // ---------------------------------------------------------------------------

  listPlatforms(): string[] {
    const channelsDir = resolveAgentChannelsDir(this.agentId);
    if (!fs.existsSync(channelsDir)) return [];
    try {
      return fs.readdirSync(channelsDir).filter((entry) => {
        // Must be a directory and a known platform
        const fullPath = path.join(channelsDir, entry);
        return (
          fs.statSync(fullPath).isDirectory() &&
          isKnownPlatform(entry) &&
          fs.existsSync(path.join(fullPath, 'connection.json'))
        );
      });
    } catch {
      return [];
    }
  }

  readLabel(platform: string): string | null {
    const config = this._readConfig(platform);
    return config?.label ?? null;
  }

  listConnections(): Array<{ platform: string; label: string; status: 'configured' }> {
    return this.listPlatforms().map((platform) => {
      const config = this._readConfig(platform)!; // listPlatforms guarantees existence
      return { platform, label: config.label, status: 'configured' as const };
    });
  }

  writeMetadata(platform: string, label: string): void {
    const config: ChannelConnectionConfig = {
      label,
      connectedAt: new Date().toISOString(),
    };
    this._writeConfig(platform, config);
  }

  remove(platform: string): void {
    // Remove credentials first (separate store handles this)
    // Then remove the channel config directory
    const dir = this._channelDir(platform);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// =============================================================================
// Convenience helpers (not part of ChannelStore interface)
// =============================================================================

/**
 * Open a FileChannelStore for the given agent.
 */
export function openChannelStore(agentId: string): ChannelStore {
  return new FileChannelStore(agentId);
}

/**
 * List all configured channels for an agent.
 * Convenience wrapper over FileChannelStore.
 */
export function listAgentChannels(
  agentId: string,
): Array<{ platform: string; label: string; status: 'configured' }> {
  return openChannelStore(agentId).listConnections();
}

/**
 * Get the ChannelAddress for every configured channel of an agent.
 */
export function listAgentChannelAddresses(agentId: string): ChannelAddress[] {
  const store = openChannelStore(agentId);
  return store.listPlatforms().map((platform) => {
    const label = store.readLabel(platform);
    return {
      platform,
      chat: label ?? platform, // chat field is currently the label in our model; platform-level ID is resolved by the connector transport
    } as ChannelAddress;
  });
}
