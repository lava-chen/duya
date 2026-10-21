import { describe, expect, it, vi } from 'vitest';
import { BriefTool } from '../../src/BriefTool/BriefTool.js';
import type { BriefDirectoryEntry, BriefWorkspacePort } from '../../src/BriefTool/ports.js';

function createWorkspacePort(
  directories: Record<string, readonly BriefDirectoryEntry[]>,
  files: Record<string, string>,
): BriefWorkspacePort {
  return {
    async readDirectory(root, relativePath) {
      return directories[`${root}:${relativePath}`] ?? [];
    },
    async readTextFile(root, relativePath) {
      const content = files[`${root}:${relativePath}`];
      if (content === undefined) throw new Error(`Missing file: ${relativePath}`);
      return content;
    },
  };
}

describe('BriefTool', () => {
  it('summarizes the supplied workspace through its injected file port', async () => {
    const port = createWorkspacePort(
      {
        '/repo:': [
          { name: 'src', isDirectory: true },
          { name: 'README.md', isDirectory: false },
          { name: '.git', isDirectory: true },
          { name: 'node_modules', isDirectory: true },
          { name: 'dist', isDirectory: true },
          { name: 'build', isDirectory: true },
        ],
        '/repo:src': [{ name: 'index.ts', isDirectory: false }],
      },
      { '/repo:package.json': JSON.stringify({ name: 'sample', version: '1.2.3', description: 'sample project' }) },
    );
    const readDirectory = vi.spyOn(port, 'readDirectory');
    const readTextFile = vi.spyOn(port, 'readTextFile');
    const result = await new BriefTool(port).execute({}, '/repo');
    const payload = JSON.parse(result.result) as {
      project: Record<string, unknown>;
      structure: string[];
    };

    expect(result.error).toBeUndefined();
    expect(payload.project).toEqual({ name: 'sample', version: '1.2.3', description: 'sample project' });
    expect(payload.structure).toEqual(['src/', '  index.ts', 'README.md']);
    expect(readDirectory).toHaveBeenCalledWith('/repo', '');
    expect(readDirectory).toHaveBeenCalledWith('/repo', 'src');
    expect(readTextFile).toHaveBeenCalledWith('/repo', 'package.json');
  });

  it('returns a structured error when workspace traversal fails', async () => {
    const port: BriefWorkspacePort = {
      async readDirectory() {
        throw new Error('workspace unavailable');
      },
      async readTextFile() {
        return '{}';
      },
    };

    const result = await new BriefTool(port).execute({}, '/repo');
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result)).toEqual({ error: 'workspace unavailable' });
  });

  it('retains the legacy prompt and tool metadata', () => {
    const tool = new BriefTool(createWorkspacePort({}, {}));
    expect(tool.toTool()).toEqual({
      name: 'Brief',
      description: 'Generate a brief summary of the codebase',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    expect(tool.getPrompt()).toContain('When starting work on a new project');
  });
});
