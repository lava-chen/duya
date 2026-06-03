import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaRestartTool,
  duyaRestartTool,
} from '../../src/tool/DuyaRestartTool/DuyaRestartTool.js';
import { DUYA_RESTART_TOOL_NAME } from '../../src/tool/DuyaRestartTool/constants.js';

const { mockConfigDb } = vi.hoisted(() => ({
  mockConfigDb: {
    restart: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  configDb: mockConfigDb,
}));

describe('DuyaRestartTool', () => {
  let tool: DuyaRestartTool;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SESSION_ID;
    delete process.env.DUYA_SESSION_ID;
    tool = new DuyaRestartTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_RESTART_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toHaveProperty('reason');
      expect(tool.input_schema.properties).toHaveProperty('resume');
    });

    it('should not have required fields', () => {
      expect(tool.input_schema.required).toBeUndefined();
    });
  });

  describe('execute - success', () => {
    it('should restart with default values', async () => {
      process.env.SESSION_ID = 'test-session-1';
      mockConfigDb.restart.mockResolvedValue({ ok: true, message: 'Restart initiated' });

      const result = await tool.execute({});
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(mockConfigDb.restart).toHaveBeenCalledWith({
        sessionId: 'test-session-1',
        reason: 'Agent requested restart',
        resume: true,
      });
    });

    it('should restart with custom reason', async () => {
      process.env.SESSION_ID = 'test-session-2';
      mockConfigDb.restart.mockResolvedValue({ ok: true });

      const result = await tool.execute({ reason: 'Switching to OpenAI provider' });
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(mockConfigDb.restart).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Switching to OpenAI provider' })
      );
    });

    it('should restart with resume false', async () => {
      process.env.DUYA_SESSION_ID = 'test-session-duya';
      mockConfigDb.restart.mockResolvedValue({ ok: true });

      await tool.execute({ resume: false });
      expect(mockConfigDb.restart).toHaveBeenCalledWith(
        expect.objectContaining({ resume: false })
      );
    });

    it('should use DUYA_SESSION_ID if SESSION_ID not set', async () => {
      delete process.env.SESSION_ID;
      process.env.DUYA_SESSION_ID = 'duya-env-session';
      mockConfigDb.restart.mockResolvedValue({ ok: true });

      await tool.execute({});
      expect(mockConfigDb.restart).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'duya-env-session' })
      );
    });
  });

  describe('execute - error handling', () => {
    it('should propagate restart errors', async () => {
      mockConfigDb.restart.mockRejectedValue(new Error('Process pool not available'));

      const result = await tool.execute({});
      expect(result.error).toBe(true);
      expect(result.result).toContain('Process pool not available');
    });

    it('should handle missing session ID gracefully', async () => {
      delete process.env.SESSION_ID;
      delete process.env.DUYA_SESSION_ID;
      mockConfigDb.restart.mockResolvedValue({ ok: true });

      const result = await tool.execute({});
      expect(result.error).toBeFalsy();
      expect(mockConfigDb.restart).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'unknown' })
      );
    });
  });
});

describe('duyaRestartTool singleton', () => {
  it('should be defined', () => {
    expect(duyaRestartTool).toBeDefined();
    expect(duyaRestartTool.name).toBe(DUYA_RESTART_TOOL_NAME);
  });
});