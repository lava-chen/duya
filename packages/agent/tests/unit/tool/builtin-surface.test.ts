import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RETIRED_MODULE_PATHS = [
  './TeamCreateTool/',
  './TeamDeleteTool/',
  './WebSearchTool/',
  './WebFetchTool/',
  './ListMcpResourcesTool/',
  './ReadMcpResourceTool/',
  './EnterWorktreeTool/',
  './ExitWorktreeTool/',
] as const;

describe('builtin tool source boundary', () => {
  it('does not import retired compatibility and placeholder modules', () => {
    const source = readFileSync(
      new URL('../../../src/tool/builtin.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("from './BrowserTool/BrowserTool.js'");
    for (const retiredPath of RETIRED_MODULE_PATHS) {
      expect(source).not.toContain(retiredPath);
    }
  });
});
