import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WikiNodeStore } from '../../packages/agent/src/wiki-agent/WikiNodeStore.js';
import { validateWikiReadInput } from '../../packages/agent/src/tool/wiki/WikiReadTool.js';
import { WikiMergeResolver } from '../../packages/agent/src/wiki-agent/WikiMergeResolver.js';
import type { MemoryCandidate, WikiNode } from '../../packages/agent/src/wiki-agent/types.js';

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-wiki-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Wiki store root semantics', () => {
  it('resolves workspace path and wiki root path to the same physical root', () => {
    const workspaceRoot = createTempWorkspace();
    const explicitRoot = path.join(workspaceRoot, 'wiki-llm');

    const storeFromWorkspace = new WikiNodeStore(workspaceRoot);
    const storeFromRoot = new WikiNodeStore(explicitRoot);

    expect(storeFromWorkspace.getRootPath()).toBe(explicitRoot);
    expect(storeFromRoot.getRootPath()).toBe(explicitRoot);
  });

  it('reads nodes from root-relative and legacy wiki-llm-prefixed paths', () => {
    const workspaceRoot = createTempWorkspace();
    const store = new WikiNodeStore(workspaceRoot);
    store.initialize();

    const node: WikiNode = {
      id: 'design-decision',
      type: 'concept',
      title: 'Design Decision',
      path: 'concepts/design-decision.md',
      content: 'Stable content.',
      aliases: ['decision'],
      tags: ['architecture'],
      createdAt: 1,
      updatedAt: 2,
      backlinks: [],
      sourceSessions: ['session-a'],
      lastObservedAt: 3,
    };

    store.writeNode(node);

    const rootRelative = store.readNode('concepts/design-decision.md');
    const legacyPrefixed = store.readNode('wiki-llm/concepts/design-decision.md');

    expect(rootRelative.title).toBe('Design Decision');
    expect(rootRelative.sourceSessions).toEqual(['session-a']);
    expect(rootRelative.lastObservedAt).toBe(3);
    expect(legacyPrefixed.title).toBe('Design Decision');
  });
});

describe('wiki_read input validation', () => {
  it('accepts root-relative paths and legacy wiki-llm-prefixed paths', () => {
    expect(validateWikiReadInput({ path: 'concepts/architecture.md' }).valid).toBe(true);
    expect(validateWikiReadInput({ path: 'wiki-llm/concepts/architecture.md' }).valid).toBe(true);
  });

  it('rejects traversal and non-markdown paths', () => {
    expect(validateWikiReadInput({ path: '../secrets.md' }).valid).toBe(false);
    expect(validateWikiReadInput({ path: 'concepts/' }).valid).toBe(false);
    expect(validateWikiReadInput({ path: 'concepts/architecture.txt' }).valid).toBe(false);
  });
});

describe('Wiki merge quality', () => {
  it('merges by section and preserves Original Context without blind update blocks', () => {
    const workspaceRoot = createTempWorkspace();
    const store = new WikiNodeStore(workspaceRoot);

    const resolver = new WikiMergeResolver(store, { sessionId: 'session-b' });
    const targetNode: WikiNode = {
      id: 'node-1',
      type: 'concept',
      title: 'Merge Target',
      path: 'concepts/merge-target.md',
      content: [
        '## Facts',
        '',
        'Existing fact.',
        '',
        '## Original Context',
        '',
        'Old context.',
      ].join('\n'),
      aliases: ['target'],
      tags: ['wiki'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      backlinks: [],
      sourceSessions: ['session-a'],
    };

    const candidate: MemoryCandidate = {
      id: 'cand-1',
      title: 'Merge Target',
      type: 'concept',
      content: [
        '## Facts',
        '',
        'New fact.',
        '',
        '## Notes',
        '',
        'A new section.',
      ].join('\n'),
      aliases: [],
      tags: ['wiki'],
      originalContext: 'New context.',
      confidence: 0.95,
      suggestedAction: 'merge',
    };

    const merged = resolver.applyMerge(candidate, targetNode);

    expect(merged.content).toContain('## Facts');
    expect(merged.content).toContain('Existing fact.');
    expect(merged.content).toContain('New fact.');
    expect(merged.content).toContain('## Notes');
    expect(merged.content).toContain('A new section.');
    expect(merged.content).toContain('## Original Context');
    expect(merged.content).toContain('Old context.');
    expect(merged.content).toContain('New context.');
    expect(merged.content).not.toContain('## Update (');
    expect(merged.sourceSessions).toEqual(['session-a', 'session-b']);
  });
});
