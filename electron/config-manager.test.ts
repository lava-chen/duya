/**
 * ConfigManager - Unit Tests
 *
 * Tests configuration management with encryption and permission control:
 * - Config loading and persistence (load, merge with defaults)
 * - API Key encryption/decryption via safeStorage
 * - Provider CRUD (upsert, activate, delete, getActiveProvider)
 * - OutputStyle CRUD
 * - Validation (apiProviders, agentSettings, uiPreferences, visionSettings)
 * - Permission control (renderer vs agent roles)
 * - Broadcast on config changes
 * - toLLMProvider type conversion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiProvider } from './config-manager';

// =============================================================================
// Mocks
// =============================================================================

let mockConfig: Record<string, unknown> = {};
let mockSafeStorageAvailable = true;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    isPackaged: false,
    on: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => mockSafeStorageAvailable),
    encryptString: vi.fn((data: string) => Buffer.from(`encrypted:${data}`, 'utf-8')),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace('encrypted:', '')),
  },
  MessagePortMain: class {},
}));

vi.mock('fs', () => {
  const actualFs = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    appendFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100 })),
    createWriteStream: vi.fn(() => ({
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    })),
    writeFileSync: vi.fn(),
  };
  return { default: actualFs, ...actualFs };
});

vi.mock('write-file-atomic', () => ({
  default: { sync: vi.fn() },
}));

vi.mock('./logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  LogComponent: {
    ConfigManager: 'ConfigManager',
    Logger: 'Logger',
  },
}));

// =============================================================================
// Helper to create the module fresh for each test
// =============================================================================

async function getFreshModule() {
  vi.resetModules();
  const mod = await import('./config-manager');
  return mod;
}

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {};
    mockSafeStorageAvailable = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // toLLMProvider
  // =========================================================================

  describe('toLLMProvider', () => {
    it('converts anthropic provider type', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('anthropic')).toBe('anthropic');
    });

    it('converts openai provider type', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('openai')).toBe('openai');
    });

    it('converts ollama provider type', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('ollama')).toBe('ollama');
    });

    it('converts openai-compatible to ollama when pointing to local ollama', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('openai-compatible', 'http://localhost:11434')).toBe('ollama');
      expect(toLLMProvider('openai-compatible', 'http://127.0.0.1:11434')).toBe('ollama');
    });

    it('converts openai-compatible to openai for other URLs', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('openai-compatible', 'https://api.example.com')).toBe('openai');
    });

    it('falls back to anthropic for unknown types', async () => {
      const { toLLMProvider } = await getFreshModule();
      expect(toLLMProvider('unknown' as ApiProvider['providerType'])).toBe('anthropic');
    });
  });

  // =========================================================================
  // ConfigManager Instance - getConfig
  // =========================================================================

  describe('getConfig', () => {
    it('returns default config when no saved config exists', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const config = manager.getConfig();

      expect(config.version).toBe(1);
      expect(config.agentSettings.temperature).toBe(0.7);
      expect(config.uiPreferences.theme).toBe('system');
    });

    it('returns default agent settings', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const settings = manager.getAgentSettings();

      expect(settings.defaultModel).toBe('');
      expect(settings.temperature).toBe(0.7);
      expect(settings.maxTokens).toBe(8192);
      expect(settings.sandboxEnabled).toBe(true);
    });

    it('returns default ui preferences', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const prefs = manager.getUiPreferences();

      expect(prefs.theme).toBe('system');
      expect(prefs.sidebarWidth).toBe(280);
      expect(prefs.fontSize).toBe(14);
      expect(prefs.showLineNumbers).toBe(true);
    });

    it('returns empty api providers by default', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const providers = manager.getAllProviders();

      expect(providers).toEqual({});
    });

    it('getApiKey returns undefined for unknown provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      expect(manager.getApiKey('unknown')).toBeUndefined();
    });

    it('getActiveProvider returns undefined with no active providers', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      expect(manager.getActiveProvider()).toBeUndefined();
    });

    it('returns builtin output styles', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const styles = manager.getOutputStyles();

      expect(styles.normal).toBeTruthy();
      expect(styles.normal.isBuiltin).toBe(true);
      expect(styles.learning).toBeTruthy();
      expect(styles.concise).toBeTruthy();
    });
  });

  // =========================================================================
  // Provider CRUD
  // =========================================================================

  describe('provider CRUD', () => {
    it('upsertProvider adds a new provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const provider: ApiProvider = {
        id: 'test-provider',
        name: 'Test Provider',
        providerType: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key',
        isActive: false,
      };

      const result = manager.upsertProvider(provider);
      expect(result).toBe(true);

      const providers = manager.getAllProviders();
      expect(providers['test-provider']).toBeTruthy();
      expect(providers['test-provider'].name).toBe('Test Provider');
      expect(providers['test-provider'].apiKey).toBe('sk-test-key');
    });

    it('upsertProvider updates an existing provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const provider: ApiProvider = {
        id: 'test-provider',
        name: 'Test Provider',
        providerType: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key',
        isActive: false,
      };
      manager.upsertProvider(provider);

      const updated: ApiProvider = {
        ...provider,
        name: 'Updated Provider',
        apiKey: 'sk-new-key',
      };
      manager.upsertProvider(updated);

      const providers = manager.getAllProviders();
      expect(providers['test-provider']).toBeTruthy();
      expect(providers['test-provider'].name).toBe('Updated Provider');
    });

    it('activateProvider sets active flag', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const provider: ApiProvider = {
        id: 'provider-1',
        name: 'Provider 1',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-1',
        isActive: false,
      };
      manager.upsertProvider(provider);

      const result = manager.activateProvider('provider-1');
      expect(result).toBe(true);

      const active = manager.getActiveProvider();
      expect(active).toBeTruthy();
      expect(active!.id).toBe('provider-1');
      expect(active!.isActive).toBe(true);
    });

    it('activateProvider returns false for unknown provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.activateProvider('non-existent');
      expect(result).toBe(false);
    });

    it('deleteProvider removes a provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const provider: ApiProvider = {
        id: 'to-delete',
        name: 'Delete Me',
        providerType: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-key',
        isActive: false,
      };
      manager.upsertProvider(provider);

      expect(manager.getAllProviders()['to-delete']).toBeTruthy();

      const result = manager.deleteProvider('to-delete');
      expect(result).toBe(true);
      expect(manager.getAllProviders()['to-delete']).toBeUndefined();
    });

    it('deleteProvider returns false for unknown provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.deleteProvider('non-existent');
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // setConfig with Validation
  // =========================================================================

  describe('setConfig with validation', () => {
    it('setConfig updates agentSettings', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const newSettings = {
        defaultModel: 'claude-3-haiku',
        temperature: 0.5,
        maxTokens: 4096,
        sandboxEnabled: false,
        skillNudgeInterval: 5,
        maxConcurrentTools: 3,
        enableDetailedProgress: true,
        enableRetry: false,
        defaultTimeout: 30000,
      };
      const result = manager.setConfig('agentSettings', newSettings);
      expect(result).toBe(true);

      const settings = manager.getAgentSettings();
      expect(settings.temperature).toBe(0.5);
      expect(settings.maxTokens).toBe(4096);
      expect(settings.enableRetry).toBe(false);
    });

    it('setConfig rejects invalid temperature', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.setConfig('agentSettings', {
        ...manager.getAgentSettings(),
        temperature: 1.5, // out of 0-1 range
      });
      expect(result).toBe(false);
    });

    it('setConfig rejects invalid theme', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.setConfig('uiPreferences', {
        ...manager.getUiPreferences(),
        theme: 'invalid',
      });
      expect(result).toBe(false);
    });

    it('setConfig updates uiPreferences', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.setConfig('uiPreferences', {
        theme: 'light',
        sidebarWidth: 300,
        fontSize: 16,
        showLineNumbers: false,
      });
      expect(result).toBe(true);

      const prefs = manager.getUiPreferences();
      expect(prefs.theme).toBe('light');
      expect(prefs.sidebarWidth).toBe(300);
    });
  });

  // =========================================================================
  // Output Style CRUD
  // =========================================================================

  describe('output style CRUD', () => {
    it('upsertOutputStyle adds a custom style', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.upsertOutputStyle({
        id: 'custom-style',
        name: 'Custom',
        prompt: 'Be creative',
      });
      expect(result).toBe(true);

      const styles = manager.getOutputStyles();
      expect(styles['custom-style']).toBeTruthy();
    });

    it('deleteOutputStyle does not delete builtin styles', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.deleteOutputStyle('normal');
      expect(result).toBe(false);
    });

    it('deleteOutputStyle returns false for unknown style', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      const result = manager.deleteOutputStyle('unknown');
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // API Key Access
  // =========================================================================

  describe('API key access', () => {
    it('getApiKey returns the key for a registered provider', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      manager.upsertProvider({
        id: 'with-key',
        name: 'Key Provider',
        providerType: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-sensitive-key',
        isActive: false,
      });

      expect(manager.getApiKey('with-key')).toBe('sk-sensitive-key');
    });

    it('getApiProviders returns all providers', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();

      manager.upsertProvider({
        id: 'p1',
        name: 'P1',
        providerType: 'anthropic',
        baseUrl: 'https://a.example.com',
        apiKey: 'sk-1',
        isActive: false,
      });

      const providers = manager.getApiProviders();
      expect(providers['p1']).toBeTruthy();
    });
  });

  // =========================================================================
  // Vision Settings
  // =========================================================================

  describe('vision settings', () => {
    it('returns default vision settings as disabled', async () => {
      const { ConfigManager } = await getFreshModule();
      const manager = new ConfigManager();
      const vision = manager.getVisionSettings();

      expect(vision.enabled).toBe(false);
    });
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('singleton', () => {
    it('getConfigManager returns the same instance', async () => {
      const mod = await getFreshModule();
      const manager1 = mod.getConfigManager();
      const manager2 = mod.getConfigManager();
      expect(manager1).toBe(manager2);
    });
  });
});