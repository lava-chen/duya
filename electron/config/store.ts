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
import type { MessagePortMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { DEFAULT_CONFIG, mergeConfig, type DuyaConfig } from './schema';

const logger = getLogger();

export interface ConfigStoreOptions {
  configPath: string;
  secretsPath: string;
}

const SECRET_KEY_PATTERNS = ['.apiKey', '.token', '.env.', '.credentials.'];

/**
 * Maps the renderer-facing flat `AppConfig` keys to the nested
 * `DuyaConfig` dotted paths stored in ConfigStore. Renderer keeps
 * sending flat keys (e.g. `apiProviders`); this table keeps the
 * renderer protocol unchanged while the backend persists nested TOML.
 * Keys absent from this table are stored as same-named top-level flat
 * fields on the snapshot (ConfigStore allows arbitrary top-level keys).
 */
const FLAT_TO_PATH: Record<string, string> = {
  apiProviders: 'providers',
  defaultProviderId: 'model.provider',
  memoryProviderId: 'memory.provider',
  memoryModelId: 'memory.model',
  agentSettings: 'agent',
  uiPreferences: 'display',
  visionSettings: 'auxiliary.vision',
  outputStyles: 'auxiliary.output_styles',
  securityBypassSkills: 'agent.security_bypass_skills',
  skill_path: 'agent.skill_path',
  conductorFeatureFlags: 'auxiliary.conductor_feature_flags',
};

type PortRole = 'renderer' | 'agent' | 'main';

interface PortSubscriber {
  port: MessagePortMain;
  role: PortRole;
}

type PortMessage =
  | { type: 'config:get'; key: string }
  | { type: 'config:set'; key: string; value: unknown }
  | { type: 'config:subscribe' }
  | { type: 'config:unsubscribe' };

type PortResponse =
  | { type: 'config:update'; config: Record<string, unknown> }
  | { type: 'config:response'; key: string; value: unknown }
  | { type: 'error'; message: string };

export class ConfigStore {
  private config: DuyaConfig;
  private secrets: Record<string, string>;
  private configPath: string;
  private secretsPath: string;
  private subscribers = new Set<() => void>();
  private portSubscribers = new Map<MessagePortMain, PortSubscriber>();
  /** Flat keys written through the port that are not in FLAT_TO_PATH. */
  private extraFlatKeys = new Set<string>();

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

  // ==== MessagePort subscription (config-port backend) ====

  addSubscriber(port: MessagePortMain, role: PortRole = 'renderer'): void {
    if (this.portSubscribers.has(port)) return;
    this.portSubscribers.set(port, { port, role });

    port.on('message', (event) => {
      this.handleMessage(event.data as PortMessage, port);
    });

    port.start();

    this.sendToPort(port, { type: 'config:update', config: this.buildFlatView() });
    logger.info(`ConfigStore port subscriber added (role: ${role}), total: ${this.portSubscribers.size}`, undefined, LogComponent.ConfigManager);
  }

  removeSubscriber(port: MessagePortMain): void {
    this.portSubscribers.delete(port);
    logger.info(`ConfigStore port subscriber removed, total: ${this.portSubscribers.size}`, undefined, LogComponent.ConfigManager);
  }

  private handleMessage(message: PortMessage, port: MessagePortMain): void {
    if (!this.portSubscribers.has(port)) return;

    switch (message.type) {
      case 'config:get':
        this.handleGet(message.key, port);
        break;
      case 'config:set':
        this.handleSet(message.key, message.value, port);
        break;
      case 'config:subscribe':
        // Subscription is implicit once the port is registered; no-op.
        break;
      case 'config:unsubscribe':
        this.removeSubscriber(port);
        break;
    }
  }

  private handleGet(key: string, port: MessagePortMain): void {
    const pathKey = FLAT_TO_PATH[key] ?? key;
    const value = this.getByPath(pathKey);
    this.sendToPort(port, { type: 'config:response', key, value });
  }

  private handleSet(key: string, value: unknown, port: MessagePortMain): void {
    const subscriber = this.portSubscribers.get(port);
    if (!subscriber) return;

    if (!this.validatePermission(subscriber.role, key)) {
      this.sendToPort(port, { type: 'error', message: `Permission denied: ${subscriber.role} cannot modify ${key}` });
      return;
    }

    if (!FLAT_TO_PATH[key]) {
      // Unmapped flat key: store at the snapshot top level, and remember it
      // so future config:update broadcasts include it in the flat view.
      this.extraFlatKeys.add(key);
    }

    const pathKey = FLAT_TO_PATH[key] ?? key;
    this.set(pathKey, value);

    this.sendToPort(port, { type: 'config:response', key, value });
  }

  private validatePermission(role: PortRole, key: string): boolean {
    switch (role) {
      case 'renderer':
        return true;
      case 'agent':
        return key === 'agentSettings' || key === 'visionSettings' || key === 'outputStyles';
      case 'main':
        return true;
      default:
        return false;
    }
  }

  private sendToPort(port: MessagePortMain, message: PortResponse): void {
    try {
      port.postMessage(message);
    } catch (err) {
      logger.error('ConfigStore failed to send to port', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.ConfigManager);
    }
  }

  /** Builds the flat renderer-facing AppConfig view from the nested snapshot. */
  private buildFlatView(): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const [flat, pathKey] of Object.entries(FLAT_TO_PATH)) {
      const value = getByPath(this.config, pathKey);
      if (value !== undefined) view[flat] = value;
    }
    for (const flat of this.extraFlatKeys) {
      const value = getByPath(this.config, flat);
      if (value !== undefined) view[flat] = value;
    }
    return view;
  }

  private broadcast(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        logger.error('ConfigStore subscriber failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.ConfigManager);
      }
    }
    const flatView = this.buildFlatView();
    for (const [port] of this.portSubscribers) {
      this.sendToPort(port, { type: 'config:update', config: flatView });
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