import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaInfoTool,
  duyaInfoTool,
} from '../../src/tool/DuyaInfoTool/DuyaInfoTool.js';
import { DUYA_INFO_TOOL_NAME } from '../../src/tool/DuyaInfoTool/constants.js';

const { mockConfigDb } = vi.hoisted(() => ({
  mockConfigDb: {
    appInfo: vi.fn(),
    providerGetAll: vi.fn(),
    providerGetActive: vi.fn(),
    agentGetSettings: vi.fn(),
    visionGet: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  configDb: mockConfigDb,
}));

describe('DuyaInfoTool', () => {
  let tool: DuyaInfoTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DuyaInfoTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_INFO_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toHaveProperty('section');
      const sectionProp = (tool.input_schema.properties as Record<string, unknown>).section as Record<string, unknown>;
      expect(sectionProp.enum).toEqual(['all', 'providers', 'agent', 'vision', 'system']);
    });

    it('should have description', () => {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    });

    it('should return correct tool definition in toTool()', () => {
      const def = tool.toTool();
      expect(def.name).toBe(DUYA_INFO_TOOL_NAME);
      expect(def.description).toBe(tool.description);
      expect(def.input_schema).toBe(tool.input_schema);
    });
  });

  describe('execute - all sections', () => {
    beforeEach(() => {
      mockConfigDb.appInfo.mockResolvedValue({
        version: '0.1.0',
        platform: 'win32',
        arch: 'x64',
        nodeVersion: 'v20.0.0',
        electronVersion: '28.0.0',
      });
      mockConfigDb.providerGetAll.mockResolvedValue({
        openai: { id: 'openai', name: 'OpenAI', providerType: 'openai', isActive: true, apiKey: 'sk-test1234abcd' },
        anthropic: { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', isActive: false, apiKey: 'sk-ant-test' },
      });
      mockConfigDb.providerGetActive.mockResolvedValue({ id: 'openai', name: 'OpenAI', providerType: 'openai' });
      mockConfigDb.agentGetSettings.mockResolvedValue({ model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 });
      mockConfigDb.visionGet.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
    });

    it('should return all sections by default (no section param)', async () => {
      const result = await tool.execute({});
      expect(result.name).toBe(DUYA_INFO_TOOL_NAME);
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.system).toBeDefined();
      expect(parsed.providers).toBeDefined();
      expect(parsed.agent).toBeDefined();
      expect(parsed.vision).toBeDefined();
    });

    it('should return all sections with section=all', async () => {
      const result = await tool.execute({ section: 'all' });
      const parsed = JSON.parse(result.result);
      expect(parsed.system).toBeDefined();
      expect(parsed.providers).toBeDefined();
      expect(parsed.agent).toBeDefined();
      expect(parsed.vision).toBeDefined();
    });

    it('should mask API keys in provider list', async () => {
      const result = await tool.execute({ section: 'providers' });
      const parsed = JSON.parse(result.result);
      expect(parsed.providers).toBeDefined();
      expect(parsed.providers.count).toBe(2);

      const firstProvider = parsed.providers.all[0];
      expect(firstProvider.maskedKey).toMatch(/^sk-tes\.\.\.abcd$/);
      expect(firstProvider.maskedKey).not.toContain('1234');
    });
  });

  describe('execute - specific sections', () => {
    it('should return only system info', async () => {
      mockConfigDb.appInfo.mockResolvedValue({ version: '0.1.0', platform: 'linux' });
      const result = await tool.execute({ section: 'system' });
      const parsed = JSON.parse(result.result);
      expect(parsed.system).toBeDefined();
      expect(parsed.system.version).toBe('0.1.0');
      expect(parsed.providers).toBeUndefined();
    });

    it('should return only provider info', async () => {
      mockConfigDb.providerGetAll.mockResolvedValue({
        openai: { id: 'openai', name: 'OpenAI', providerType: 'openai', isActive: true, apiKey: 'sk-1234' },
      });
      mockConfigDb.providerGetActive.mockResolvedValue(null);
      const result = await tool.execute({ section: 'providers' });
      const parsed = JSON.parse(result.result);
      expect(parsed.providers).toBeDefined();
      expect(parsed.providers.active).toBeNull();
    });

    it('should return only agent settings', async () => {
      mockConfigDb.agentGetSettings.mockResolvedValue({ model: 'claude-sonnet-4', temperature: 0.3 });
      const result = await tool.execute({ section: 'agent' });
      const parsed = JSON.parse(result.result);
      expect(parsed.agent).toBeDefined();
      expect(parsed.agent.model).toBe('claude-sonnet-4');
    });

    it('should return only vision settings', async () => {
      mockConfigDb.visionGet.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
      const result = await tool.execute({ section: 'vision' });
      const parsed = JSON.parse(result.result);
      expect(parsed.vision).toBeDefined();
      expect(parsed.vision.provider).toBe('openai');
    });
  });

  describe('execute - error handling', () => {
    it('should handle system info failure gracefully', async () => {
      mockConfigDb.appInfo.mockRejectedValue(new Error('Connection lost'));
      mockConfigDb.providerGetAll.mockResolvedValue({});
      mockConfigDb.providerGetActive.mockResolvedValue(null);
      mockConfigDb.agentGetSettings.mockResolvedValue({});
      mockConfigDb.visionGet.mockResolvedValue({});

      const result = await tool.execute({});
      const parsed = JSON.parse(result.result);
      expect(parsed.system.error).toBe('Failed to get system info');
      expect(parsed.providers).toBeDefined();
    });

    it('should handle provider failure gracefully', async () => {
      mockConfigDb.appInfo.mockResolvedValue({ version: '1.0' });
      mockConfigDb.providerGetAll.mockRejectedValue(new Error('DB error'));
      mockConfigDb.agentGetSettings.mockResolvedValue({});
      mockConfigDb.visionGet.mockResolvedValue({});

      const result = await tool.execute({});
      const parsed = JSON.parse(result.result);
      expect(parsed.providers.error).toBe('Failed to get provider info');
      expect(parsed.system).toBeDefined();
    });
  });
});

describe('duyaInfoTool singleton', () => {
  it('should be defined', () => {
    expect(duyaInfoTool).toBeDefined();
    expect(duyaInfoTool.name).toBe(DUYA_INFO_TOOL_NAME);
  });
});