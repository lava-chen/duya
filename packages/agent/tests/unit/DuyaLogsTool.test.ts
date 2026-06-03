import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaLogsTool,
  duyaLogsTool,
} from '../../src/tool/DuyaLogsTool/DuyaLogsTool.js';
import { DUYA_LOGS_TOOL_NAME } from '../../src/tool/DuyaLogsTool/constants.js';

const { mockConfigDb } = vi.hoisted(() => ({
  mockConfigDb: {
    logsTail: vi.fn(),
    logsErrors: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  configDb: mockConfigDb,
}));

describe('DuyaLogsTool', () => {
  let tool: DuyaLogsTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DuyaLogsTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_LOGS_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.required).toContain('action');
      expect(tool.input_schema.properties).toHaveProperty('action');
      expect(tool.input_schema.properties).toHaveProperty('lines');
    });

    it('should return correct tool definition in toTool()', () => {
      const def = tool.toTool();
      expect(def.name).toBe(DUYA_LOGS_TOOL_NAME);
    });
  });

  describe('execute - tail', () => {
    it('should get tail logs with default lines', async () => {
      mockConfigDb.logsTail.mockResolvedValue({
        lines: 3,
        totalLines: 100,
        entries: ['[INFO] Server started', '[INFO] Agent initialized', '[DEBUG] Processing...'],
      });

      const result = await tool.execute({ action: 'tail' });
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.lines).toBe(3);
      expect(parsed.totalLines).toBe(100);
      expect(parsed.entries).toHaveLength(3);
      expect(mockConfigDb.logsTail).toHaveBeenCalledWith(50);
    });

    it('should pass custom line count', async () => {
      mockConfigDb.logsTail.mockResolvedValue({ lines: 10, totalLines: 100, entries: [] });

      await tool.execute({ action: 'tail', lines: 10 });
      expect(mockConfigDb.logsTail).toHaveBeenCalledWith(10);
    });

    it('should handle empty log file', async () => {
      mockConfigDb.logsTail.mockResolvedValue({
        lines: 0,
        totalLines: 0,
        entries: [],
        message: 'No log file found',
      });

      const result = await tool.execute({ action: 'tail' });
      const parsed = JSON.parse(result.result);
      expect(parsed.lines).toBe(0);
    });
  });

  describe('execute - errors', () => {
    it('should get error logs', async () => {
      mockConfigDb.logsErrors.mockResolvedValue({
        lines: 2,
        totalErrorLines: 5,
        entries: [
          '[ERROR] Database connection failed',
          '[ERROR] API timeout after 30s',
        ],
      });

      const result = await tool.execute({ action: 'errors' });
      const parsed = JSON.parse(result.result);
      expect(parsed.lines).toBe(2);
      expect(parsed.totalErrorLines).toBe(5);
      expect(parsed.entries).toHaveLength(2);
      expect(mockConfigDb.logsErrors).toHaveBeenCalledWith(50);
    });

    it('should handle no errors', async () => {
      mockConfigDb.logsErrors.mockResolvedValue({
        lines: 0,
        totalErrorLines: 0,
        entries: [],
      });

      const result = await tool.execute({ action: 'errors' });
      const parsed = JSON.parse(result.result);
      expect(parsed.lines).toBe(0);
    });

    it('should pass custom line count for errors', async () => {
      mockConfigDb.logsErrors.mockResolvedValue({ lines: 0, totalErrorLines: 0, entries: [] });

      await tool.execute({ action: 'errors', lines: 20 });
      expect(mockConfigDb.logsErrors).toHaveBeenCalledWith(20);
    });
  });

  describe('execute - invalid action', () => {
    it('should reject unknown action', async () => {
      const result = await tool.execute({ action: 'delete_logs' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Invalid input');
    });
  });

  describe('execute - error propagation', () => {
    it('should propagate log access errors', async () => {
      mockConfigDb.logsTail.mockRejectedValue(new Error('Permission denied'));

      const result = await tool.execute({ action: 'tail' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Permission denied');
    });
  });
});

describe('duyaLogsTool singleton', () => {
  it('should be defined', () => {
    expect(duyaLogsTool).toBeDefined();
    expect(duyaLogsTool.name).toBe(DUYA_LOGS_TOOL_NAME);
  });
});