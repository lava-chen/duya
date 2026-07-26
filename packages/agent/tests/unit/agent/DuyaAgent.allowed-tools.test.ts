import { describe, expect, it } from 'vitest';
import { isToolVisible } from '../../../src/agent-profile/ToolFilter.js';

const tools = ['read', 'grep', 'glob', 'write'] as const;
const EMPTY = new Set<string>();

describe('DuyaAgent allowedTools filtering contract', () => {
  it('keeps the lowercase minimal toolset and excludes write tools', () => {
    const allowed = ['read', 'grep', 'glob'];
    const visible = tools.filter((name) =>
      isToolVisible(name, 'always', EMPTY, { allowedTools: allowed }),
    );
    expect(visible).toEqual(['read', 'grep', 'glob']);
  });

  it('does not silently match display-cased tool names', () => {
    const allowed = ['Read', 'Grep', 'Glob'];
    const visible = tools.filter((name) =>
      isToolVisible(name, 'always', EMPTY, { allowedTools: allowed }),
    );
    expect(visible).toEqual([]);
  });
});
