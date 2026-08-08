/**
 * ConfigStore — the unified config facade for the Main process.
 *
 * Holds an in-memory snapshot of `DuyaConfig`, persists it to
 * `~/.duya/config.toml` (plaintext, atomic, 0o600) and splits every
 * secret (apiKey/token/env) into `~/.duya/secrets.json`. Writes update
 * the snapshot first, then persist, then notify subscribers (used by
 * IPC/MessagePort broadcast).
 */

import fs from 'fs';
import path from 'path';
import { parse, stringify } from '@iarna/toml';
import writeFileAtomic from 'write-file-atomic';
import { getLogger, LogComponent } from '../logging/logger';
import { DEFAULT_CONFIG, mergeConfig, type DuyaConfig } from './schema';

const logger = getLogger();

export interface ConfigStoreOptions {
  configPath: string;
  secretsPath: string;
}

const SECRET_KEY_PATTERNS = ['.apiKey', '.token', '.env.', '.credentials.'];

export class ConfigStore {
  private config: DuyaConfig;
  private secrets: Record<string, string>;
  private configPath: string;
  private secretsPath: string;
  private subscribers = new Set<() => void>();

  constructor(opts: ConfigStoreOptions) {
    this.configPath = opts.configPath;
    this.secretsPath = opts.secretsPath;
    this.secrets = {};
    this.config = this.load();
  }

  // ==== persistence ====

  private load(): DuyaConfig {
    let disk: Partial<DuyaConfig> | undefined;
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        disk = parse(raw) as Partial<DuyaConfig>;
      } catch (err) {
        logger.error('ConfigStore: failed to parse config.toml', err instanceof Error ? err : new Error(String(err)), { path: this.configPath }, LogComponent.ConfigManager);
      }
    }
    this.secrets = this.readSecrets();
    const merged = mergeConfig(disk ?? {});
    return this.mergeSecrets(merged);
  }

  private readSecrets(): Record<string, string> {
    if (!fs.existsSync(this.secretsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.secretsPath, 'utf-8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private mergeSecrets(cfg: DuyaConfig): DuyaConfig {
    for (const [key, value] of Object.entries(this.secrets)) {
      setByPath(cfg, key, value);
    }
    return cfg;
  }

  private persist(): void {
    const { publicCfg, secrets } = this.splitSecrets(this.config);
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(this.configPath, stringify(publicCfg as unknown as Parameters<typeof stringify>[0]), { mode: 0o600 });
    if (Object.keys(secrets).length > 0 || fs.existsSync(this.secretsPath)) {
      const secretsDir = path.dirname(this.secretsPath);
      if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir, { recursive: true });
      writeFileAtomic.sync(this.secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    }
  }

  private splitSecrets(cfg: DuyaConfig): { publicCfg: DuyaConfig; secrets: Record<string, string> } {
    const publicCfg = JSON.parse(JSON.stringify(cfg)) as DuyaConfig;
    const secrets: Record<string, string> = {};
    collectSecrets(publicCfg, '', secrets);
    return { publicCfg, secrets };
  }

  // ==== public API ====

  get(): DuyaConfig {
    return this.config;
  }

  getByPath(key: string): unknown {
    return getByPath(this.config, key);
  }

  set(key: string, value: unknown): void {
    setByPath(this.config, key, value);
    this.persist();
    this.broadcast();
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private broadcast(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        logger.error('ConfigStore subscriber failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.ConfigManager);
      }
    }
  }
}

// ==== dotted-path helpers ====

function getByPath(obj: unknown, key: string): unknown {
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setByPath(obj: unknown, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof cur[part] !== 'object' || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function collectSecrets(obj: unknown, prefix: string, out: Record<string, string>): void {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_PATTERNS.some((p) => key.endsWith(p) || key.includes('.env.'))) {
      if (typeof v === 'string' && v) {
        out[key] = v;
        delete (obj as Record<string, unknown>)[k];
      }
    } else if (typeof v === 'object') {
      collectSecrets(v, key, out);
    }
  }
}