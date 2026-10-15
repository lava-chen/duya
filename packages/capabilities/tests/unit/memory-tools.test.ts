import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { MemoryWriteTool, validateMemoryContent } from '../../src/MemoryTools/MemoryWriteTool.js';
import { WriteStage1PolicyTool } from '../../src/MemoryTools/WriteStage1PolicyTool.js';
import type { MemoryToolFilePort } from '../../src/MemoryTools/ports.js';

function createMemoryFiles(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const directories = new Set<string>();
  const port: MemoryToolFilePort = {
    ensureDirectory(directoryPath) {
      directories.add(directoryPath);
    },
    readTextFileIfExists(filePath) {
      return files.get(filePath);
    },
    writeTextFile(filePath, content) {
      files.set(filePath, content);
    },
  };

  return { port, files, directories };
}

describe('memory capability tools', () => {
  it('validates and writes a memory document through the injected file port', async () => {
    const root = path.resolve('memory-root');
    const file = 'global/areas/verification.md';
    const fullPath = path.resolve(root, file);
    const content = '---\nstatus: active\n---\n\n# Verification\nDurable note.';
    const memory = createMemoryFiles();
    const tool = new MemoryWriteTool(memory.port);

    const result = await tool.execute({ file, content }, root);

    expect(validateMemoryContent(content)).toEqual({ ok: true });
    expect(result).toMatchObject({ name: 'memory_write', result: `Wrote ${file}` });
    expect(memory.directories).toContain(path.dirname(fullPath));
    expect(memory.files.get(fullPath)).toBe(content);
  });

  it('rejects traversal before writing', async () => {
    const memory = createMemoryFiles();
    const tool = new MemoryWriteTool(memory.port);

    const result = await tool.execute({ file: '../outside.md', content: '# Safe title' }, path.resolve('memory-root'));

    expect(result).toMatchObject({ name: 'memory_write', error: true });
    expect(memory.files.size).toBe(0);
    expect(memory.directories.size).toBe(0);
  });

  it('writes the Stage 1 policy and increments its version sidecar', async () => {
    const root = path.resolve('memory-root');
    const policyPath = path.join(root, 'memory-config', 'stage1_policy.md');
    const versionPath = `${policyPath}.version`;
    const memory = createMemoryFiles({ [versionPath]: '3' });
    const tool = new WriteStage1PolicyTool(memory.port);

    const result = await tool.execute({ content: '# Updated policy' }, root);

    expect(result).toMatchObject({
      name: 'write_stage1_policy',
      result: 'Wrote stage1_policy.md and bumped version',
    });
    expect(memory.files.get(policyPath)).toBe('# Updated policy');
    expect(memory.files.get(versionPath)).toBe('4');
  });
});
