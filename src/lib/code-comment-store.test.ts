import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addCodeComment,
  buildCodeCommentsPromptBlock,
  getCodeComments,
  getPendingCodeComments,
  makeCodeCommentId,
  markCodeCommentsSent,
  removeCodeComment,
} from './code-comment-store';

const WS = 'E:/workspace/demo';

function commentCount(overrides: Partial<Parameters<typeof addCodeComment>[1]> = {}) {
  return {
    path: 'src/foo.ts',
    startLine: 12,
    endLine: 18,
    selectedText: 'const answer = 42;',
    comment: '这里改成常量',
    ...overrides,
  };
}

describe('code-comment-store', () => {
  beforeEach(() => {
    // Start every test from an empty store regardless of module state.
    for (const existing of [...getCodeComments(WS)]) {
      removeCodeComment(WS, existing.id);
    }
  });

  afterEach(() => {
    for (const existing of [...getCodeComments(WS)]) {
      removeCodeComment(WS, existing.id);
    }
  });

  it('normalizes inverted ranges and derives a deterministic id', () => {
    const added = addCodeComment(WS, commentCount({ startLine: 18, endLine: 12 }));
    expect(added.startLine).toBe(12);
    expect(added.endLine).toBe(18);
    expect(added.id).toBe('src/foo.ts:12-18');
    expect(makeCodeCommentId('src/foo.ts', 18, 12)).toBe('src/foo.ts:12-18');
  });

  it('upserts the same range instead of stacking duplicates', () => {
    addCodeComment(WS, commentCount());
    addCodeComment(WS, commentCount({ comment: '更新后的评论' }));
    const comments = getCodeComments(WS);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.comment).toBe('更新后的评论');
  });

  it('keeps workspaces isolated', () => {
    addCodeComment(WS, commentCount());
    addCodeComment('E:/workspace/other', commentCount({ path: 'src/bar.ts' }));
    expect(getCodeComments(WS)).toHaveLength(1);
    expect(getCodeComments('E:/workspace/other')).toHaveLength(1);
    expect(getCodeComments('E:/workspace/other')[0]?.path).toBe('src/bar.ts');
  });

  it('returns a stable empty snapshot for unknown workspaces', () => {
    const first = getCodeComments('E:/workspace/missing');
    const second = getCodeComments('E:/workspace/missing');
    expect(first).toBe(second);
    expect(first).toHaveLength(0);
  });

  it('returns stable pending snapshots for useSyncExternalStore', () => {
    // New array identity per call would loop React updates (getSnapshot
    // must be cached) — empty bucket and populated bucket both need it.
    expect(getPendingCodeComments(WS)).toBe(getPendingCodeComments(WS));

    addCodeComment(WS, commentCount());
    const pending = getPendingCodeComments(WS);
    expect(getPendingCodeComments(WS)).toBe(pending);

    markCodeCommentsSent(WS);
    const sent = getPendingCodeComments(WS);
    expect(sent).toHaveLength(0);
    expect(getPendingCodeComments(WS)).toBe(sent);
  });

  it('removes by id and only emits when something changed', () => {
    const added = addCodeComment(WS, commentCount());
    removeCodeComment(WS, added.id);
    expect(getCodeComments(WS)).toHaveLength(0);
    removeCodeComment(WS, added.id);
    expect(getCodeComments(WS)).toHaveLength(0);
  });

  it('marks comments sent and reports pending separately', () => {
    addCodeComment(WS, commentCount());
    addCodeComment(WS, commentCount({ path: 'src/bar.ts', startLine: 1, endLine: 2 }));
    expect(getPendingCodeComments(WS)).toHaveLength(2);

    markCodeCommentsSent(WS);
    expect(getPendingCodeComments(WS)).toHaveLength(0);
    expect(getCodeComments(WS)).toHaveLength(2);
    expect(getCodeComments(WS).every((comment) => comment.sentAt !== null)).toBe(true);
  });

  it('builds the prompt block from pending comments only', () => {
    expect(buildCodeCommentsPromptBlock(WS)).toBe('');

    addCodeComment(WS, commentCount());
    addCodeComment(
      WS,
      commentCount({ path: 'src/bar.ts', startLine: 3, endLine: 3, selectedText: 'x', comment: 'b' }),
    );
    markCodeCommentsSent(WS);
    expect(buildCodeCommentsPromptBlock(WS)).toBe('');

    addCodeComment(WS, commentCount({ comment: '重新提出' }));
    const block = buildCodeCommentsPromptBlock(WS);
    expect(block).toContain('# Code comments:');
    expect(block).toContain('## Comment 1');
    expect(block).toContain('File: src/foo.ts');
    expect(block).toContain('Lines: 12-18');
    expect(block).toContain('const answer = 42;');
    expect(block).toContain('Comment:');
    expect(block).toContain('重新提出');
    // Sent comments must not leak into the next block.
    expect(block).not.toContain('src/bar.ts');
  });

  it('renders single-line comments with a single line label', () => {
    addCodeComment(WS, commentCount({ startLine: 7, endLine: 7 }));
    const block = buildCodeCommentsPromptBlock(WS);
    expect(block).toContain('Lines: 7');
    expect(block).not.toContain('Lines: 7-');
  });
});
