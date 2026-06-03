import { describe, it, expect } from 'vitest';
import {
  validateReadInput,
  ReadTool,
} from '../../../src/tool/ReadTool/ReadTool.js';

describe('ReadTool', () => {
  describe('validateReadInput', () => {
    it('should validate correct input', () => {
      const result = validateReadInput({ file_path: '/test.txt' });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.file_path).toBe('/test.txt');
      }
    });

    it('should reject empty file_path', () => {
      const result = validateReadInput({ file_path: '' });
      expect(result.valid).toBe(false);
    });

    it('should reject missing file_path', () => {
      const result = validateReadInput({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('file_path must be a string');
    });

    it('should reject null input', () => {
      const result = validateReadInput(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Input must be an object');
    });

    it('should validate line_range with valid start and end', () => {
      const result = validateReadInput({
        file_path: '/test.txt',
        line_range: { start: 1, end: 10 },
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.line_range).toEqual({ start: 1, end: 10 });
      }
    });

    it('should reject invalid line_range start (0)', () => {
      const result = validateReadInput({
        file_path: '/test.txt',
        line_range: { start: 0, end: 10 },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('line_range.start must be an integer >= 1');
    });

    it('should reject negative line_range start', () => {
      const result = validateReadInput({
        file_path: '/test.txt',
        line_range: { start: -1, end: 10 },
      });
      expect(result.valid).toBe(false);
    });

    it('should accept line_range with end=-1 (end of file)', () => {
      const result = validateReadInput({
        file_path: '/test.txt',
        line_range: { start: 1, end: -1 },
      });
      expect(result.valid).toBe(true);
    });

    it('should reject line_range end exceeding maximum', () => {
      const result = validateReadInput({
        file_path: '/test.txt',
        line_range: { start: 1, end: 2000000 },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot exceed 1000000');
    });
  });

  describe('ReadTool class', () => {
    it('should have correct name', () => {
      const tool = new ReadTool();
      expect(tool.name).toBe('read');
    });

    it('should have interrupt behavior "block"', () => {
      const tool = new ReadTool();
      expect(tool.interruptBehavior).toBe('block');
    });

    it('should be concurrency safe', () => {
      const tool = new ReadTool();
      expect(tool.isConcurrencySafe()).toBe(true);
    });

    it('should have proper input schema', () => {
      const tool = new ReadTool();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
    });

    it('should return correct schema in toTool()', () => {
      const tool = new ReadTool();
      const toolDef = tool.toTool();
      expect(toolDef.name).toBe('read');
      expect(toolDef.input_schema.type).toBe('object');
      expect(toolDef.input_schema.properties).toBeDefined();
      expect(toolDef.input_schema.properties).toHaveProperty('file_path');
      expect(toolDef.input_schema.required).toContain('file_path');
    });

    it('should generate correct user facing description', () => {
      const tool = new ReadTool();
      expect(tool.generateUserFacingDescription({ file_path: '/test.txt' })).toBe('read: /test.txt');
      expect(tool.generateUserFacingDescription({ file_path: '/test.txt', line_range: { start: 1, end: 10 } })).toBe('read: /test.txt:1-10');
    });
  });
});
