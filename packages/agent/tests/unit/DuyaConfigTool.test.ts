import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaConfigTool,
  duyaConfigTool,
} from '../../src/tool/DuyaConfigTool/DuyaConfigTool.js';
import { DUYA_CONFIG_TOOL_NAME } from '../../src/tool/DuyaConfigTool/constants.js';

const { mockConfigDb } = vi.hoisted(() => ({
  mockConfigDb: {
    providerGetAll: vi.fn(),
    providerUpsert: vi.fn(),
    providerDelete: vi.fn(),
    providerActivate: vi.fn(),
    agentGetSettings: vi.fn(),
    agentSetSettings: vi.fn(),
    visionGet: vi.fn(),
    visionSet: vi.fn(),
    outputStylesGet: vi.fn(),
    outputStylesSet: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  configDb: mockConfigDb,
}));

describe('DuyaConfigTool', () => {
  let tool: DuyaConfigTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DuyaConfigTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_CONFIG_TOOL_NAME);
    });

    it('should have input schema with action required', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.required).toContain('action');
      expect(tool.input_schema.properties).toHaveProperty('action');
    });

    it('should return correct tool definition in toTool()', () => {
      const def = tool.toTool();
      expect(def.name).toBe(DUYA_CONFIG_TOOL_NAME);
    });
  });

  describe('execute - providers_list', () => {
    it('should list all providers', async () => {
      mockConfigDb.providerGetAll.mockResolvedValue({
        openai: { id: 'openai', name: 'OpenAI', providerType: 'openai', isActive: true, baseUrl: 'https://api.openai.com' },
        anthropic: { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', isActive: false, baseUrl: '' },
      });

      const result = await tool.execute({ action: 'providers_list' });
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(2);
      expect(parsed.providers[0].id).toBe('openai');
    });

    it('should return empty list when no providers', async () => {
      mockConfigDb.providerGetAll.mockResolvedValue({});
      const result = await tool.execute({ action: 'providers_list' });
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(0);
    });
  });

  describe('execute - provider_add', () => {
    it('should add a provider with required fields', async () => {
      mockConfigDb.providerUpsert.mockResolvedValue({ ok: true });

      const result = await tool.execute({
        action: 'provider_add',
        id: 'my-ollama',
        name: 'Ollama Local',
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider.id).toBe('my-ollama');
      expect(mockConfigDb.providerUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'my-ollama', name: 'Ollama Local', providerType: 'ollama' })
      );
    });

    it('should add a provider with API key and isActive', async () => {
      mockConfigDb.providerUpsert.mockResolvedValue({ ok: true });

      const result = await tool.execute({
        action: 'provider_add',
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        apiKey: 'sk-test123',
        isActive: true,
      });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
    });

    it('should reject missing required fields', async () => {
      const result = await tool.execute({ action: 'provider_add', id: 'test' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('name');
    });
  });

  describe('execute - provider_remove', () => {
    it('should remove a provider', async () => {
      mockConfigDb.providerDelete.mockResolvedValue({ ok: true });

      const result = await tool.execute({ action: 'provider_remove', id: 'openai' });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.removed).toBe('openai');
    });

    it('should reject missing id', async () => {
      const result = await tool.execute({ action: 'provider_remove' });
      expect(result.error).toBe(true);
    });
  });

  describe('execute - provider_activate', () => {
    it('should activate a provider', async () => {
      mockConfigDb.providerActivate.mockResolvedValue({ ok: true });

      const result = await tool.execute({ action: 'provider_activate', id: 'anthropic' });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.active).toBe('anthropic');
    });

    it('should reject missing id', async () => {
      const result = await tool.execute({ action: 'provider_activate' });
      expect(result.error).toBe(true);
    });
  });

  describe('execute - settings_get/set', () => {
    it('should get current settings', async () => {
      mockConfigDb.agentGetSettings.mockResolvedValue({
        model: 'gpt-4o',
        temperature: 0.7,
        maxTokens: 4096,
      });

      const result = await tool.execute({ action: 'settings_get' });
      const parsed = JSON.parse(result.result);
      expect(parsed.model).toBe('gpt-4o');
      expect(parsed.temperature).toBe(0.7);
    });

    it('should update agent settings', async () => {
      mockConfigDb.agentSetSettings.mockResolvedValue({ ok: true });

      const result = await tool.execute({
        action: 'settings_set',
        model: 'claude-sonnet-4',
        temperature: 0.3,
        maxTokens: 8192,
      });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.changes).toEqual({ model: 'claude-sonnet-4', temperature: 0.3, maxTokens: 8192 });
    });

    it('should reject settings_set with no fields', async () => {
      const result = await tool.execute({ action: 'settings_set' });
      expect(result.error).toBe(true);
    });

    it('should set enableThinking', async () => {
      mockConfigDb.agentSetSettings.mockResolvedValue({ ok: true });

      const result = await tool.execute({
        action: 'settings_set',
        enableThinking: true,
        thinkingBudget: 16000,
      });
      const parsed = JSON.parse(result.result);
      expect(parsed.changes).toHaveProperty('enableThinking', true);
      expect(parsed.changes).toHaveProperty('thinkingBudget', 16000);
    });
  });

  describe('execute - vision_get/set', () => {
    it('should get vision settings', async () => {
      mockConfigDb.visionGet.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });

      const result = await tool.execute({ action: 'vision_get' });
      const parsed = JSON.parse(result.result);
      expect(parsed.provider).toBe('openai');
      expect(parsed.model).toBe('gpt-4o');
    });

    it('should set vision settings', async () => {
      mockConfigDb.visionSet.mockResolvedValue({ ok: true });

      const result = await tool.execute({
        action: 'vision_set',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
      });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
    });

    it('should reject vision_set with no provider or model', async () => {
      const result = await tool.execute({ action: 'vision_set' });
      expect(result.error).toBe(true);
    });
  });

  describe('execute - style_get/set', () => {
    it('should get output styles', async () => {
      mockConfigDb.outputStylesGet.mockResolvedValue({ Normal: {}, Concise: {}, Detailed: {} });

      const result = await tool.execute({ action: 'style_get' });
      const parsed = JSON.parse(result.result);
      expect(parsed).toEqual({ Normal: {}, Concise: {}, Detailed: {} });
    });

    it('should set output style', async () => {
      mockConfigDb.outputStylesSet.mockResolvedValue({ ok: true, styleId: 'Concise' });

      const result = await tool.execute({ action: 'style_set', styleId: 'Concise' });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
    });

    it('should reject style_set without styleId', async () => {
      const result = await tool.execute({ action: 'style_set' });
      expect(result.error).toBe(true);
    });
  });

  describe('execute - invalid action', () => {
    it('should reject unknown action', async () => {
      const result = await tool.execute({ action: 'invalid_action' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Invalid input');
    });
  });

  describe('execute - error propagation', () => {
    it('should return error when DB operation fails', async () => {
      mockConfigDb.providerGetAll.mockRejectedValue(new Error('Database locked'));

      const result = await tool.execute({ action: 'providers_list' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Database locked');
    });
  });
});

describe('duyaConfigTool singleton', () => {
  it('should be defined', () => {
    expect(duyaConfigTool).toBeDefined();
    expect(duyaConfigTool.name).toBe(DUYA_CONFIG_TOOL_NAME);
  });
});