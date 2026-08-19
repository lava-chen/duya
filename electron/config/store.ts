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

/**
 * Write a file atomically with a small retry loop for transient Windows
 * lock errors (EPERM/EBUSY from antivirus scanners or a second app
 * instance briefly holding the file). write-file-atomic already writes to
 * a temp file + rename; the rename is the step that hits EPERM.
 */
function writeFileRetry(target: string, content: string, opts: { mode: number }): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileAtomic.sync(target, content, opts);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if ((code === 'EPERM' || code === 'EBUSY') && attempt < 2) {
        // Synchronous wait so the retry happens before the caller moves on.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

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
  memoryRag: 'memory.rag',
  agentSettings: 'agent',
  uiPreferences: 'display',
  visionSettings: 'auxiliary.vision',
  outputStyles: 'auxiliary.output_styles',
  securityBypassSkills: 'agent.security_bypass_skills',
  skill_path: 'agent.skill_path',
  conductorFeatureFlags: 'auxiliary.conductor_feature_flags',
  openLinksInExternalBrowser: 'browser.open_links_in_external_browser',
  defaultPermissionMode: 'agent.default_permission_mode',
  defaultIde: 'ide.default',
  customAgents: 'agents',
  performanceSettings: 'performance',
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
  /** Watches config.toml (and secrets.json, same dir) for external edits. */
  private watcher?: fs.FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  /** Invoked after an external (manual) config.toml edit is applied. */
  private externalChangeHandler?: (changedPaths: string[]) => void;

  constructor(opts: ConfigStoreOptions) {
    this.configPath = opts.configPath;
    this.secretsPath = opts.secretsPath;
    this.secrets = {};
    this.config = this.load();
    this.startWatching();
  }

  // ==== external file watch ====

  /**
   * Watch config.toml so manual edits take effect without restarting DUYA.
   *
   * We watch the parent directory and filter on the config/secrets basenames.
   * This keeps the watcher alive even when config.toml does not exist yet on
   * first launch (it is created shortly after by migration), and it naturally
   * covers secrets.json edits too. `persistent: false` lets the process exit
   * even while a watcher is registered (important for tests).
   */
  private startWatching(): void {
    const dir = path.dirname(this.configPath);
    const configBase = path.basename(this.configPath);
    const secretsBase = path.basename(this.secretsPath);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        const name = filename ? filename.toString() : '';
        if (name !== configBase && name !== secretsBase) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        // Debounce: writeFileAtomic performs tmp-write + rename, which fires
        // several events. The delay lets the rename settle before we read.
        this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 400);
      });
      this.watcher.on('error', () => {
        // Non-fatal: hot reload simply does not apply for this session.
      });
    } catch {
      // Directory may be unwatchable (e.g. test sandbox). Non-fatal.
    }
  }

  /**
   * Re-read config.toml from disk and apply it if it differs from the
   * in-memory snapshot. Self-writes (set() → persist()) produce identical
   * content on disk, so they are skipped by the deep-equality check — this
   * avoids both redundant broadcasts and MCP reload loops.
   */
  private reloadFromDisk(): void {
    const prev = this.config;
    let next: DuyaConfig;
    try {
      next = this.load();
    } catch {
      return; // malformed file; keep the last good snapshot
    }
    if (isDeepEqual(prev, next)) return;
    this.config = next;
    const changed = diffConfigPaths(prev, next);
    this.broadcast();
    this.externalChangeHandler?.(changed);
  }

  /** Register a handler notified with changed dotted paths after an external edit. */
  setExternalChangeHandler(handler: (changedPaths: string[]) => void): void {
    this.externalChangeHandler = handler;
  }

  /** Release the config watcher (mainly for tests / shutdown). */
  close(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
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
        // Preserve the unparseable file before any later persist() could
        // overwrite it with the defaults. Without this backup, a single
        // set() after a parse failure silently destroys the user's on-disk
        // configuration (providers, model, mcp_servers, hooks) with no way
        // to recover it. The backup keeps the raw bytes so the user can
        // restore or manually repair.
        try {
          const backupPath = `${this.configPath}.corrupt-${Date.now()}`;
          fs.copyFileSync(this.configPath, backupPath);
          logger.error('ConfigStore: preserved unparseable config.toml copy', undefined, { path: this.configPath, backupPath }, LogComponent.ConfigManager);
        } catch (backupErr) {
          logger.error('ConfigStore: failed to back up unparseable config.toml', backupErr instanceof Error ? backupErr : new Error(String(backupErr)), { path: this.configPath }, LogComponent.ConfigManager);
        }
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

  private persist(): boolean {
    const { publicCfg, secrets } = this.splitSecrets(this.config);
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let ok = true;
    try {
      writeFileRetry(this.configPath, stringify(publicCfg as unknown as Parameters<typeof stringify>[0]), { mode: 0o600 });
    } catch (err) {
      ok = false;
      // Never let a persistence failure (e.g. EPERM from antivirus or a
      // concurrent second app instance holding the file) crash the Main
      // process as an Uncaught Exception. The in-memory snapshot stays
      // authoritative for this run; a later set() retries the write.
      logger.error('ConfigStore: failed to persist config.toml', err instanceof Error ? err : new Error(String(err)), { path: this.configPath }, LogComponent.ConfigManager);
    }
    if (Object.keys(secrets).length > 0 || fs.existsSync(this.secretsPath)) {
      const secretsDir = path.dirname(this.secretsPath);
      if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir, { recursive: true });
      try {
        writeFileRetry(this.secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
      } catch (err) {
        ok = false;
        logger.error('ConfigStore: failed to persist secrets.json', err instanceof Error ? err : new Error(String(err)), { path: this.secretsPath }, LogComponent.ConfigManager);
      }
    }
    return ok;
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

  set(key: string, value: unknown): boolean {
    setByPath(this.config, key, value);
    const ok = this.persist();
    this.broadcast();
    return ok;
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

/** Order-insensitive structural equality (used to detect real external edits). */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    return aa.every((v, i) => isDeepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && isDeepEqual(ao[k], bo[k]),
  );
}

/**
 * Return the leaf dotted paths that differ between two config snapshots.
 * e.g. editing `[mcp_servers.foo].command` yields `['mcp_servers.foo.command']`.
 * Used by the external-change handler to decide which subsystems to reload.
 */
export function diffConfigPaths(prev: unknown, next: unknown, prefix = ''): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (isDeepEqual(a, b)) return;
    if (
      a !== null && b !== null &&
      typeof a === 'object' && typeof b === 'object' &&
      !Array.isArray(a)
    ) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const keys = new Set<string>([...Object.keys(ao), ...Object.keys(bo)]);
      if (keys.size === 0) {
        out.push(path);
        return;
      }
      for (const k of keys) {
        walk(ao[k], bo[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push(path);
  };
  walk(prev, next, prefix);
  return out;
}

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