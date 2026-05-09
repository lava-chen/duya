/**
 * ConfigManager - Configuration management with encryption and permission control (The Vault)
 *
 * Manages /config/settings.json - encrypted configuration store.
 * Uses Electron's safeStorage API for OS-level encryption of API keys.
 * Uses write-file-atomic for bulletproof writes (no corruption on power loss).
 *
 * Design principles:
 * - OS-level encryption via safeStorage (API keys never stored in plaintext)
 * - Atomic writes (prevent corruption on power loss)
 * - Separated from business data (never in SQLite)
 * - Real-time broadcast to subscribers via MessagePort
 */

import { safeStorage, app, MessagePortMain } from 'electron';
import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { getLogger, LogComponent } from './logger';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface ApiProvider {
  id: string;
  name: string;
  providerType: 'anthropic' | 'openai' | 'ollama' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  isActive: boolean;
  extraEnv?: Record<string, string>;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  notes?: string;
  sortOrder?: number;
}

export interface VisionSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface AgentSettings {
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  sandboxEnabled: boolean;
  skillNudgeInterval: number;
  maxConcurrentTools: number;
  enableDetailedProgress: boolean;
  enableRetry: boolean;
  defaultTimeout: number;
}

export interface UiPreferences {
  theme: 'light' | 'dark' | 'system';
  sidebarWidth: number;
  fontSize: number;
  showLineNumbers: boolean;
}

export interface OutputStyle {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  keepCodingInstructions?: boolean;
  isBuiltin?: boolean;
}

export interface ConductorFeatureFlags {
  /** Enable template widget installation and management */
  templates: {
    enabled: boolean;
  };
  /** Dynamic widget controls */
  dynamic: {
    /** Allow preview of dynamic widgets (local dev only) */
    previewEnabled: boolean;
    /** Allow execution/creation of dynamic widgets (production default: off) */
    executeEnabled: boolean;
  };
}

export interface AppConfig {
  version: number;
  apiProviders: Record<string, ApiProvider>;
  agentSettings: AgentSettings;
  uiPreferences: UiPreferences;
  visionSettings: VisionSettings;
  /** Output style configurations */
  outputStyles: Record<string, OutputStyle>;
  /** List of skill names that user has chosen to bypass security checks for */
  securityBypassSkills?: string[];
  /** Conductor widget extensibility feature flags */
  conductorFeatureFlags?: ConductorFeatureFlags;
}

export type ConfigKey = keyof AppConfig;

export type ConfigMessage =
  | { type: 'config:get'; key: string }
  | { type: 'config:set'; key: ConfigKey; value: unknown }
  | { type: 'config:subscribe' }
  | { type: 'config:unsubscribe' };

export type ConfigResponse =
  | { type: 'config:update'; config: AppConfig }
  | { type: 'config:response'; key: string; value: unknown }
  | { type: 'error'; message: string };

export type PortRole = 'renderer' | 'agent';

// LLM Provider type for agent process
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

/**
 * Convert provider type to LLM provider for agent process
 * Now Ollama has its own native API client
 */
export function toLLMProvider(providerType: ApiProvider['providerType'], baseUrl?: string): LLMProvider {
  switch (providerType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'openai-compatible':
      // If baseURL points to Ollama, use Ollama client for better compatibility
      if (baseUrl?.includes('localhost:11434') || baseUrl?.includes('127.0.0.1:11434')) {
        return 'ollama';
      }
      return 'openai';
    case 'ollama':
      return 'ollama';
    default:
      return 'anthropic';
  }
}

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

function validateApiProvider(key: string, value: unknown): { valid: boolean; error?: string } {
  if (key !== 'apiProviders') return { valid: true };

  if (typeof value !== 'object' || value === null) {
    return { valid: false, error: 'apiProviders must be an object' };
  }

  const providers = value as Record<string, ApiProvider>;
  for (const [id, provider] of Object.entries(providers)) {
    if (typeof provider !== 'object' || provider === null) {
      return { valid: false, error: `Provider ${id} must be an object` };
    }
    if (!provider.name || typeof provider.name !== 'string') {
      return { valid: false, error: `Provider ${id} must have a name` };
    }
    if (!['anthropic', 'openai', 'ollama', 'openai-compatible'].includes(provider.providerType)) {
      return { valid: false, error: `Provider ${id} must have valid providerType` };
    }
  }

  return { valid: true };
}

function validateAgentSettings(key: string, value: unknown): { valid: boolean; error?: string } {
  if (key !== 'agentSettings') return { valid: true };

  if (typeof value !== 'object' || value === null) {
    return { valid: false, error: 'agentSettings must be an object' };
  }

  const settings = value as Partial<AgentSettings>;

  if (settings.defaultModel !== undefined && typeof settings.defaultModel !== 'string') {
    return { valid: false, error: 'defaultModel must be a string' };
  }
  if (settings.temperature !== undefined && (typeof settings.temperature !== 'number' || settings.temperature < 0 || settings.temperature > 1)) {
    return { valid: false, error: 'temperature must be between 0 and 1' };
  }
  if (settings.maxTokens !== undefined && (typeof settings.maxTokens !== 'number' || settings.maxTokens < 1)) {
    return { valid: false, error: 'maxTokens must be a positive number' };
  }
  if (settings.sandboxEnabled !== undefined && typeof settings.sandboxEnabled !== 'boolean') {
    return { valid: false, error: 'sandboxEnabled must be a boolean' };
  }
  if (settings.skillNudgeInterval !== undefined && (typeof settings.skillNudgeInterval !== 'number' || settings.skillNudgeInterval < 0)) {
    return { valid: false, error: 'skillNudgeInterval must be a non-negative number' };
  }

  return { valid: true };
}

function validateUiPreferences(key: string, value: unknown): { valid: boolean; error?: string } {
  if (key !== 'uiPreferences') return { valid: true };

  if (typeof value !== 'object' || value === null) {
    return { valid: false, error: 'uiPreferences must be an object' };
  }

  const prefs = value as Partial<UiPreferences>;

  if (prefs.theme !== undefined && !['light', 'dark', 'system'].includes(prefs.theme)) {
    return { valid: false, error: 'theme must be light, dark, or system' };
  }
  if (prefs.sidebarWidth !== undefined && (typeof prefs.sidebarWidth !== 'number' || prefs.sidebarWidth < 200 || prefs.sidebarWidth > 600)) {
    return { valid: false, error: 'sidebarWidth must be between 200 and 600' };
  }
  if (prefs.fontSize !== undefined && (typeof prefs.fontSize !== 'number' || prefs.fontSize < 10 || prefs.fontSize > 24)) {
    return { valid: false, error: 'fontSize must be between 10 and 24' };
  }

  return { valid: true };
}

function validateVisionSettings(key: string, value: unknown): { valid: boolean; error?: string } {
  if (key !== 'visionSettings') return { valid: true };

  if (typeof value !== 'object' || value === null) {
    return { valid: false, error: 'visionSettings must be an object' };
  }

  const settings = value as Partial<VisionSettings>;

  if (settings.provider !== undefined && typeof settings.provider !== 'string') {
    return { valid: false, error: 'vision provider must be a string' };
  }
  if (settings.model !== undefined && typeof settings.model !== 'string') {
    return { valid: false, error: 'vision model must be a string' };
  }
  if (settings.baseUrl !== undefined && typeof settings.baseUrl !== 'string') {
    return { valid: false, error: 'vision baseUrl must be a string' };
  }
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    return { valid: false, error: 'vision enabled must be a boolean' };
  }

  return { valid: true };
}

function validateConfig(key: ConfigKey, value: unknown): { valid: boolean; error?: string } {
  switch (key) {
    case 'apiProviders':
      return validateApiProvider(key, value);
    case 'agentSettings':
      return validateAgentSettings(key, value);
    case 'uiPreferences':
      return validateUiPreferences(key, value);
    case 'visionSettings':
      return validateVisionSettings(key, value);
    default:
      return { valid: true };
  }
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  apiProviders: {},
  agentSettings: {
    defaultModel: '',
    temperature: 0.7,
    maxTokens: 8192,
    sandboxEnabled: true,
    skillNudgeInterval: 10,
    maxConcurrentTools: 3,
    enableDetailedProgress: true,
    enableRetry: true,
    defaultTimeout: 60000,
  },
  uiPreferences: {
    theme: 'system',
    sidebarWidth: 280,
    fontSize: 14,
    showLineNumbers: true,
  },
  visionSettings: {
    provider: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    enabled: false,
  },
  outputStyles: {
    normal: {
      id: 'normal',
      name: 'Normal',
      description: 'Default response style',
      prompt: 'Respond in a balanced, natural tone. Provide clear and helpful information without being overly verbose or too terse.',
      keepCodingInstructions: true,
      isBuiltin: true,
    },
    learning: {
      id: 'learning',
      name: 'Learning',
      description: 'Educational and explanatory',
      prompt: 'Adopt an educational tone. Explain concepts thoroughly, break down complex ideas into understandable pieces, and provide examples where helpful. Encourage deep understanding.',
      keepCodingInstructions: true,
      isBuiltin: true,
    },
    concise: {
      id: 'concise',
      name: 'Concise',
      description: 'Brief and to the point',
      prompt: 'Be extremely concise. Give direct answers with minimal exposition. Skip pleasantries and get straight to the point. Only elaborate when explicitly asked.',
      keepCodingInstructions: true,
      isBuiltin: true,
    },
    explanatory: {
      id: 'explanatory',
      name: 'Explanatory',
      description: 'Detailed explanations',
      prompt: 'Provide thorough, detailed explanations for everything. Walk through your reasoning step by step. Include context, alternatives, and trade-offs. Leave no question unanswered.',
      keepCodingInstructions: true,
      isBuiltin: true,
    },
    formal: {
      id: 'formal',
      name: 'Formal',
      description: 'Professional tone',
      prompt: 'Maintain a formal, professional tone. Use precise language, avoid colloquialisms, and structure responses with proper organization. Address the user with respect and professionalism.',
      keepCodingInstructions: true,
      isBuiltin: true,
    },
  },
  conductorFeatureFlags: {
    templates: {
      enabled: true,
    },
    dynamic: {
      previewEnabled: !app.isPackaged,
      executeEnabled: false,
    },
  },
};

// =============================================================================
// CONFIG MANAGER CLASS
// =============================================================================

interface Subscriber {
  port: Electron.MessagePortMain;
  role: PortRole;
}

export class ConfigManager {
  private config: AppConfig;
  private configPath: string;
  private subscribers = new Map<Electron.MessagePortMain, Subscriber>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private onChangeCallbacks = new Set<() => void>();
  private logger = getLogger();

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'config', 'settings.json');
    this.config = this.load();
    this.startAutoSave();
  }

  // =============================================================================
  // PERSISTENCE (with atomic writes + safeStorage encryption)
  // =============================================================================

  private load(): AppConfig {
    try {
      // Try new path first: config/settings.json
      if (fs.existsSync(this.configPath)) {
        return this.loadFromPath(this.configPath);
      }

      // Fallback: old path config.json (backward compatibility)
      const legacyPath = path.join(app.getPath('userData'), 'config.json');
      if (fs.existsSync(legacyPath)) {
        this.logger.info('Migrating from legacy config.json to config/settings.json', undefined, LogComponent.ConfigManager);
        const config = this.loadFromPath(legacyPath);
        // Save to new location
        this.config = config;
        this.dirty = true;
        this.save();
        // Remove old file after successful migration
        try {
          fs.unlinkSync(legacyPath);
          this.logger.info('Legacy config.json removed after migration', undefined, LogComponent.ConfigManager);
        } catch {
          // Non-critical: old file can remain
        }
        return config;
      }
    } catch (error) {
      this.logger.error('Failed to load config', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.ConfigManager);
    }

    return this.createDefaultConfig();
  }

  private loadFromPath(filePath: string): AppConfig {
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'));
        const parsed = JSON.parse(decrypted);
        return this.mergeWithDefault(parsed);
      } catch {
        // Fall back to plain JSON if decryption fails
        const parsed = JSON.parse(raw);
        return this.mergeWithDefault(parsed);
      }
    } else {
      const parsed = JSON.parse(raw);
      return this.mergeWithDefault(parsed);
    }
  }

  private save(): void {
    if (!this.dirty) return;

    try {
      const data = JSON.stringify(this.config, null, 2);
      let toWrite: string;

      if (safeStorage.isEncryptionAvailable()) {
        toWrite = safeStorage.encryptString(data).toString('base64');
      } else {
        toWrite = data;
      }

      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      writeFileAtomic.sync(this.configPath, toWrite, { mode: 0o600 });
      this.dirty = false;
      this.logger.info('Config saved (atomic write)', undefined, LogComponent.ConfigManager);
    } catch (error) {
      this.logger.error('Save failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.ConfigManager);
    }
  }

  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, 30000);
  }

  private stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private mergeWithDefault(config: Partial<AppConfig>): AppConfig {
    return {
      version: config.version ?? DEFAULT_CONFIG.version,
      apiProviders: { ...DEFAULT_CONFIG.apiProviders, ...config.apiProviders },
      agentSettings: { ...DEFAULT_CONFIG.agentSettings, ...config.agentSettings },
      uiPreferences: { ...DEFAULT_CONFIG.uiPreferences, ...config.uiPreferences },
      visionSettings: { ...DEFAULT_CONFIG.visionSettings, ...config.visionSettings },
      outputStyles: { ...DEFAULT_CONFIG.outputStyles, ...config.outputStyles },
      securityBypassSkills: config.securityBypassSkills ?? DEFAULT_CONFIG.securityBypassSkills,
      conductorFeatureFlags: config.conductorFeatureFlags
        ? {
            templates: { ...DEFAULT_CONFIG.conductorFeatureFlags.templates, ...config.conductorFeatureFlags.templates },
            dynamic: { ...DEFAULT_CONFIG.conductorFeatureFlags.dynamic, ...config.conductorFeatureFlags.dynamic },
          }
        : DEFAULT_CONFIG.conductorFeatureFlags,
    };
  }

  private createDefaultConfig(): AppConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // =============================================================================
  // SUBSCRIBER MANAGEMENT
  // =============================================================================

  addSubscriber(port: Electron.MessagePortMain, role: PortRole = 'renderer'): void {
    const subscriber: Subscriber = { port, role };
    this.subscribers.set(port, subscriber);

    port.on('message', (event) => {
      this.handleMessage(event.data, port);
    });

    port.start();

    this.sendToPort(port, { type: 'config:update', config: this.config });

    this.logger.info(`Subscriber added (role: ${role}), total: ${this.subscribers.size}`, undefined, LogComponent.ConfigManager);
  }

  removeSubscriber(port: Electron.MessagePortMain): void {
    this.subscribers.delete(port);
    this.logger.info(`Subscriber removed, total: ${this.subscribers.size}`, undefined, LogComponent.ConfigManager);
  }

  private handleMessage(message: ConfigMessage, port: Electron.MessagePortMain): void {
    const subscriber = this.subscribers.get(port);
    if (!subscriber) return;

    switch (message.type) {
      case 'config:get':
        this.handleGet(message.key, port);
        break;

      case 'config:set':
        this.handleSet(message.key, message.value, port, subscriber.role);
        break;

      case 'config:subscribe':
        break;

      case 'config:unsubscribe':
        this.removeSubscriber(port);
        break;
    }
  }

  // =============================================================================
  // MESSAGE HANDLERS
  // =============================================================================

  private handleGet(key: string, port: Electron.MessagePortMain): void {
    const value = (this.config as unknown as Record<string, unknown>)[key];
    this.sendToPort(port, { type: 'config:response', key, value });
  }

  private handleSet(key: ConfigKey, value: unknown, port: Electron.MessagePortMain, role: PortRole): void {
    if (!this.validatePermission(role, key)) {
      this.sendToPort(port, { type: 'error', message: `Permission denied: ${role} cannot modify ${key}` });
      return;
    }

    const validation = validateConfig(key, value);
    if (!validation.valid) {
      this.sendToPort(port, { type: 'error', message: `Validation failed: ${validation.error}` });
      return;
    }

    (this.config as unknown as Record<string, unknown>)[key] = value;
    this.dirty = true;

    this.sendToPort(port, { type: 'config:response', key, value });

    this.broadcast();
  }

  private validatePermission(role: PortRole, key: ConfigKey): boolean {
    switch (role) {
      case 'renderer':
        return true;
      case 'agent':
        return key === 'agentSettings' || key === 'visionSettings' || key === 'outputStyles';
      default:
        return false;
    }
  }

  private sendToPort(port: Electron.MessagePortMain, message: ConfigResponse): void {
    try {
      port.postMessage(message);
    } catch (error) {
      this.logger.error('Failed to send to port', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.ConfigManager);
    }
  }

  private broadcast(): void {
    const message: ConfigResponse = { type: 'config:update', config: this.config };
    for (const [port] of this.subscribers) {
      this.sendToPort(port, message);
    }
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  getConfig(): AppConfig {
    return this.config;
  }

  getApiProviders(): Record<string, ApiProvider> {
    return this.config.apiProviders;
  }

  getAgentSettings(): AgentSettings {
    return this.config.agentSettings;
  }

  getUiPreferences(): UiPreferences {
    return this.config.uiPreferences;
  }

  getVisionSettings(): VisionSettings {
    return this.config.visionSettings;
  }

  getApiKey(providerId: string): string | undefined {
    return this.config.apiProviders[providerId]?.apiKey;
  }

  getActiveProvider(): ApiProvider | undefined {
    return Object.values(this.config.apiProviders).find(p => p.isActive);
  }

  upsertProvider(provider: ApiProvider): boolean {
    const providers = { ...this.config.apiProviders };
    providers[provider.id] = provider;
    return this.setConfig('apiProviders', providers);
  }

  activateProvider(providerId: string): boolean {
    const providers = { ...this.config.apiProviders };
    let found = false;
    for (const [id, p] of Object.entries(providers)) {
      providers[id] = { ...p, isActive: id === providerId };
      if (id === providerId) found = true;
    }
    if (!found) {
      this.logger.error(`activateProvider: provider not found: ${providerId}`, undefined, undefined, LogComponent.ConfigManager);
      return false;
    }
    return this.setConfig('apiProviders', providers);
  }

  deleteProvider(providerId: string): boolean {
    const providers = { ...this.config.apiProviders };
    if (!providers[providerId]) {
      this.logger.error(`deleteProvider: provider not found: ${providerId}`, undefined, undefined, LogComponent.ConfigManager);
      return false;
    }
    delete providers[providerId];
    return this.setConfig('apiProviders', providers);
  }

  getAllProviders(): Record<string, ApiProvider> {
    return { ...this.config.apiProviders };
  }

  getOutputStyles(): Record<string, OutputStyle> {
    return { ...this.config.outputStyles };
  }

  upsertOutputStyle(style: OutputStyle): boolean {
    const styles = { ...this.config.outputStyles };
    styles[style.id] = style;
    return this.setConfig('outputStyles', styles);
  }

  deleteOutputStyle(styleId: string): boolean {
    const styles = { ...this.config.outputStyles };
    const style = styles[styleId];
    if (!style) return false;
    if (style.isBuiltin) return false;
    delete styles[styleId];
    return this.setConfig('outputStyles', styles);
  }

  onConfigChange(callback: () => void): () => void {
    this.onChangeCallbacks.add(callback);
    return () => {
      this.onChangeCallbacks.delete(callback);
    };
  }

  private notifyChange(key: ConfigKey): void {
    if (key === 'apiProviders') {
      for (const cb of this.onChangeCallbacks) {
        try {
          cb();
        } catch (err) {
          this.logger.error('Config change callback failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.ConfigManager);
        }
      }
    }
  }

  setConfig(key: ConfigKey, value: unknown, role: PortRole = 'renderer'): boolean {
    if (!this.validatePermission(role, key)) {
      this.logger.error(`Permission denied: ${role} cannot modify ${key}`, undefined, undefined, LogComponent.ConfigManager);
      return false;
    }

    const validation = validateConfig(key, value);
    if (!validation.valid) {
      this.logger.error(`Validation failed: ${validation.error}`, undefined, undefined, LogComponent.ConfigManager);
      return false;
    }

    (this.config as unknown as Record<string, unknown>)[key] = value;
    this.dirty = true;
    this.broadcast();
    this.notifyChange(key);
    return true;
  }

  shutdown(): void {
    this.stopAutoSave();
    if (this.dirty) {
      this.save();
    }
    for (const [port] of this.subscribers) {
      try {
        port.close();
      } catch {}
    }
    this.subscribers.clear();
  }
}

// Singleton instance
let configManager: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!configManager) {
    configManager = new ConfigManager();
  }
  return configManager;
}

export function initConfigManager(): ConfigManager {
  if (configManager) {
    getLogger().warn('Already initialized', undefined, LogComponent.ConfigManager);
    return configManager;
  }
  configManager = new ConfigManager();
  return configManager;
}
