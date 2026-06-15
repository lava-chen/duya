import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateReadInput,
  ReadTool,
  _resetSharedParser,
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

    it('should validate cell_range with start and end', () => {
      const result = validateReadInput({
        file_path: '/test.ipynb',
        cell_range: { start: 1, end: 5 },
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data.cell_range).toEqual({ start: 1, end: 5 });
      }
    });

    it('should accept cell_range with end=-1 (end of notebook)', () => {
      const result = validateReadInput({
        file_path: '/test.ipynb',
        cell_range: { start: 5, end: -1 },
      });
      expect(result.valid).toBe(true);
    });

    it('should reject cell_range start < 1', () => {
      const result = validateReadInput({
        file_path: '/test.ipynb',
        cell_range: { start: 0, end: 5 },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cell_range.start');
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

describe('ReadTool .ipynb dispatch', () => {
  beforeEach(() => {
    _resetSharedParser();
  });

  it('routes .ipynb through the document parser (not text mode)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-ipynb-'));
    const path = join(dir, 'foo.ipynb');
    const nb = {
      nbformat: 4,
      metadata: { language_info: { name: 'python' } },
      cells: [{ cell_type: 'code', source: 'x=1', outputs: [], execution_count: 1 }],
    };
    writeFileSync(path, JSON.stringify(nb));
    try {
      const tool = new ReadTool();
      const result = await tool.execute({ file_path: path });
      expect(result.error).toBeFalsy();
      expect(result.result).toContain('1 cells');
      expect(result.result).toContain('<cell id="cell-1">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes .ipynb to document mode even when cell_range is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-ipynb-'));
    const path = join(dir, 'foo.ipynb');
    const nb = {
      nbformat: 4,
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'code', source: 'a=1', outputs: [], execution_count: 1 },
        { cell_type: 'code', source: 'b=2', outputs: [], execution_count: 2 },
        { cell_type: 'code', source: 'c=3', outputs: [], execution_count: 3 },
      ],
    };
    writeFileSync(path, JSON.stringify(nb));
    try {
      const tool = new ReadTool();
      const result = await tool.execute({ file_path: path, cell_range: { start: 2, end: 3 } });
      expect(result.error).toBeFalsy();
      expect(result.result).toContain('<cell id="cell-2">');
      expect(result.result).toContain('<cell id="cell-3">');
      expect(result.result).not.toContain('<cell id="cell-1">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a system reminder when cell_range is set for non-ipynb files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-ipynb-'));
    const path = join(dir, 'foo.txt');
    writeFileSync(path, 'hello\nworld\n');
    try {
      const tool = new ReadTool();
      const result = await tool.execute({ file_path: path, cell_range: { start: 1, end: 2 } });
      // cell_range ignored, file still read as text
      expect(result.error).toBeFalsy();
      expect(result.result).toContain('hello');
      expect(result.result).toContain('cell_range only applies to .ipynb files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
