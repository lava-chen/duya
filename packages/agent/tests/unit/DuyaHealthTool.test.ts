import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaHealthTool,
  duyaHealthTool,
} from '../../src/tool/DuyaHealthTool/DuyaHealthTool.js';
import { DUYA_HEALTH_TOOL_NAME } from '../../src/tool/DuyaHealthTool/constants.js';

const { mockConfigDb } = vi.hoisted(() => ({
  mockConfigDb: {
    healthTestProvider: vi.fn(),
    healthGatewayStatus: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  configDb: mockConfigDb,
}));

describe('DuyaHealthTool', () => {
  let tool: DuyaHealthTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DuyaHealthTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_HEALTH_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.required).toContain('action');
      expect(tool.input_schema.properties).toHaveProperty('action');
      expect(tool.input_schema.properties).toHaveProperty('providerId');
    });

    it('should return correct tool definition in toTool()', () => {
      const def = tool.toTool();
      expect(def.name).toBe(DUYA_HEALTH_TOOL_NAME);
    });
  });

  describe('execute - test_provider', () => {
    it('should test default provider (no providerId)', async () => {
      mockConfigDb.healthTestProvider.mockResolvedValue({
        success: true,
        message: 'Connection successful',
      });

      const result = await tool.execute({ action: 'test_provider' });
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.success).toBe(true);
      expect(mockConfigDb.healthTestProvider).toHaveBeenCalledWith({ providerId: undefined });
    });

    it('should test specific provider', async () => {
      mockConfigDb.healthTestProvider.mockResolvedValue({ success: true });

      const result = await tool.execute({
        action: 'test_provider',
        providerId: 'openai',
      });
      const parsed = JSON.parse(result.result);
      expect(parsed.success).toBe(true);
      expect(mockConfigDb.healthTestProvider).toHaveBeenCalledWith({ providerId: 'openai' });
    });

    it('should handle connection failure', async () => {
      mockConfigDb.healthTestProvider.mockResolvedValue({
        success: false,
        message: 'Connection failed',
        error: { code: 'ECONNREFUSED', message: 'Connection refused' },
      });

      const result = await tool.execute({ action: 'test_provider' });
      const parsed = JSON.parse(result.result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ECONNREFUSED');
    });
  });

  describe('execute - gateway_status', () => {
    it('should return gateway status', async () => {
      mockConfigDb.healthGatewayStatus.mockResolvedValue({
        gateways: { telegram: { chatCount: 3, active: true, lastActivity: '2026-01-01T00:00:00Z' } },
        total: 1,
        types: ['telegram'],
      });

      const result = await tool.execute({ action: 'gateway_status' });
      const parsed = JSON.parse(result.result);
      expect(parsed.total).toBe(1);
      expect(parsed.types).toContain('telegram');
      expect(parsed.gateways.telegram.active).toBe(true);
    });

    it('should handle no gateways', async () => {
      mockConfigDb.healthGatewayStatus.mockResolvedValue({
        gateways: {},
        total: 0,
        types: [],
      });

      const result = await tool.execute({ action: 'gateway_status' });
      const parsed = JSON.parse(result.result);
      expect(parsed.total).toBe(0);
    });
  });

  describe('execute - invalid action', () => {
    it('should reject unknown action', async () => {
      const result = await tool.execute({ action: 'restart_server' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Invalid input');
    });
  });

  describe('execute - error propagation', () => {
    it('should propagate test provider errors', async () => {
      mockConfigDb.healthTestProvider.mockRejectedValue(new Error('Timeout'));

      const result = await tool.execute({ action: 'test_provider' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Timeout');
    });
  });
});

describe('duyaHealthTool singleton', () => {
  it('should be defined', () => {
    expect(duyaHealthTool).toBeDefined();
    expect(duyaHealthTool.name).toBe(DUYA_HEALTH_TOOL_NAME);
  });
});