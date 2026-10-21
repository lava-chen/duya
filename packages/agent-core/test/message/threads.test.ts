import { describe, expect, it } from 'vitest';
import type { AgentMessage, MessageEntry } from '../../src/message/message-framework.js';
import {
  THREAD_METADATA_KEY,
  readThreadMeta,
  isBranchedMessage,
  isReplyMessage,
  isBranchedEntry,
  mergeThreadMetadata,
  indexThreadViews,
  resolveBranchRoot,
  threadChainContains,
  branchThreadDescendants,
  branchReplyCounts,
  getThread,
  validateReplyTarget,
  resolveReplyMeta,
  renderReplyQuotePrefix,
  messageToQuoteText,
  applyReplyQuoteContext,
  collectMessageIds,
  type ThreadMeta,
  type ThreadMessageView,
} from '../../src/message/threads.js';

const createdAt = 1_700_000_000_000;

// ─── Builders ────────────────────────────────────────────────────────────

function msg(
  id: string,
  role: 'user' | 'assistant' = 'user',
  meta?: ThreadMeta,
): AgentMessage {
  const base: AgentMessage = {
    role,
    id,
    timestamp: createdAt,
    visibility: 'visible',
    content: `content of ${id}`,
  };
  if (meta) {
    base.metadata = mergeThreadMetadata(base.metadata, meta);
  }
  return base;
}

function entry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id: `entry:${id}`, parentId: null, createdAt, message };
}

/** Plain main-line message, then a few branched replies. */
function simpleThread(): MessageEntry[] {
  const root = entry('root', msg('root', 'user'));
  const a = entry('a', msg('a', 'user', { replyToId: 'root', branched: true }));
  const b = entry('b', msg('b', 'user', { replyToId: 'a', branched: true }));
  const c = entry('c', msg('c', 'user', { replyToId: 'root', branched: true }));
  return [root, a, b, c];
}

// ─── readThreadMeta / predicates ─────────────────────────────────────────

describe('readThreadMeta / predicates', () => {
  it('returns undefined for old messages without the key', () => {
    expect(readThreadMeta(msg('x'))).toBeUndefined();
    expect(readThreadMeta({ role: 'user', id: 'y', content: '' })).toBeUndefined();
    expect(readThreadMeta(undefined)).toBeUndefined();
  });

  it('round-trips replyToId and branched', () => {
    const meta = readThreadMeta(msg('a', 'user', { replyToId: 'root', branched: true }));
    expect(meta).toEqual({ replyToId: 'root', branched: true });
  });

  it('ignores malformed metadata shapes', () => {
    const bad = msg('x');
    bad.metadata = { [THREAD_METADATA_KEY]: 'not-an-object' };
    expect(readThreadMeta(bad)).toBeUndefined();
    const bad2 = msg('y');
    bad2.metadata = { [THREAD_METADATA_KEY]: [] };
    expect(readThreadMeta(bad2)).toBeUndefined();
  });

  it('predicates branch vs reply', () => {
    expect(isBranchedMessage(msg('x'))).toBe(false);
    expect(isBranchedMessage(msg('a', 'user', { replyToId: 'r', branched: true }))).toBe(true);
    expect(isReplyMessage(msg('a', 'user', { replyToId: 'r' }))).toBe(true);
    expect(isReplyMessage(msg('a', 'user', { branched: true }))).toBe(false);
  });

  it('isBranchedEntry checks timeline entries', () => {
    expect(isBranchedEntry(entry('e', msg('m')))).toBe(false);
    expect(
      isBranchedEntry(entry('e', msg('m', 'user', { replyToId: 'r', branched: true }))),
    ).toBe(true);
  });

  it('mergeThreadMetadata never mutates the base', () => {
    const base = { a: 1 };
    const merged = mergeThreadMetadata(base, { replyToId: 'r', branched: true });
    expect(merged.a).toBe(1);
    expect(merged[THREAD_METADATA_KEY]).toEqual({ replyToId: 'r', branched: true });
    expect(base[THREAD_METADATA_KEY]).toBeUndefined();
  });
});

// ─── Creation rules (P2.2 pure part) ─────────────────────────────────────

describe('validateReplyTarget / resolveReplyMeta', () => {
  const known = new Set(['root', 'a']);

  it('validates target existence', () => {
    expect(validateReplyTarget('root', known)).toBe(true);
    expect(validateReplyTarget('missing', known)).toBe(false);
  });

  it('strips when replyToId is absent', () => {
    expect(resolveReplyMeta(undefined, false, known)).toBeUndefined();
  });

  it('strips silently when target does not exist (grok stripReplyTo)', () => {
    expect(resolveReplyMeta('ghost', true, known)).toBeUndefined();
    expect(resolveReplyMeta('ghost', undefined, known)).toBeUndefined();
  });

  it('fork carries branched=true', () => {
    expect(resolveReplyMeta('root', true, known)).toEqual({ replyToId: 'root', branched: true });
  });

  it('plain reply omits branched', () => {
    expect(resolveReplyMeta('root', false, known)).toEqual({ replyToId: 'root' });
    expect(resolveReplyMeta('root', undefined, known)).toEqual({ replyToId: 'root' });
  });
});

// ─── resolveBranchRoot ───────────────────────────────────────────────────

describe('resolveBranchRoot', () => {
  it('plain message resolves to itself (potential root)', () => {
    const byId = indexThreadViews(simpleThread());
    expect(resolveBranchRoot('root', byId)).toBe('root');
  });

  it('direct fork resolves to its root', () => {
    const byId = indexThreadViews(simpleThread());
    expect(resolveBranchRoot('a', byId)).toBe('root');
  });

  it('nested fork walks up to the nearest non-branched ancestor', () => {
    const byId = indexThreadViews(simpleThread());
    expect(resolveBranchRoot('b', byId)).toBe('root');
  });

  it('unknown id resolves undefined', () => {
    expect(resolveBranchRoot('nope', indexThreadViews([]))).toBeUndefined();
  });

  it('dangling reference resolves undefined', () => {
    const entries = [entry('a', msg('a', 'user', { replyToId: 'ghost', branched: true }))];
    expect(resolveBranchRoot('a', indexThreadViews(entries))).toBeUndefined();
  });

  it('orphan branch head (branched, no replyToId) resolves undefined', () => {
    const entries = [entry('a', msg('a', 'user', { branched: true }))];
    expect(resolveBranchRoot('a', indexThreadViews(entries))).toBeUndefined();
  });

  it('cycle resolves undefined', () => {
    const a = entry('a', msg('a', 'user', { replyToId: 'b', branched: true }));
    const b = entry('b', msg('b', 'user', { replyToId: 'a', branched: true }));
    expect(resolveBranchRoot('a', indexThreadViews([a, b]))).toBeUndefined();
  });

  it('chain to a branched ancestor still resolves the true root', () => {
    // a -> b (b branched onto root) -> root : both are branches of root.
    const root = entry('root', msg('root', 'user'));
    const b = entry('b', msg('b', 'user', { replyToId: 'root', branched: true }));
    const a = entry('a', msg('a', 'user', { replyToId: 'b', branched: true }));
    const byId = indexThreadViews([root, b, a]);
    expect(resolveBranchRoot('a', byId)).toBe('root');
    expect(resolveBranchRoot('b', byId)).toBe('root');
  });
});

// ─── Descendants / counts / getThread ────────────────────────────────────

describe('branchThreadDescendants / branchReplyCounts / getThread', () => {
  it('collects direct and nested forks under the same root', () => {
    const entries = simpleThread(); // root, a(root), b(a), c(root)
    const ids = branchThreadDescendants('root', entries).map((e) => e.message.id);
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('orphan branches are never attributed', () => {
    const entries = [
      entry('root', msg('root', 'user')),
      entry('orphan', msg('orphan', 'user', { branched: true })),
    ];
    expect(branchThreadDescendants('root', entries)).toHaveLength(0);
  });

  it('counts replies per root without counting the root', () => {
    const counts = branchReplyCounts(simpleThread());
    expect(counts.get('root')).toBe(3);
    expect(counts.size).toBe(1);
  });

  it('two independent threads count separately', () => {
    const entries = [
      entry('r1', msg('r1', 'user')),
      entry('r2', msg('r2', 'user')),
      entry('a', msg('a', 'user', { replyToId: 'r1', branched: true })),
      entry('b', msg('b', 'user', { replyToId: 'r2', branched: true })),
    ];
    const counts = branchReplyCounts(entries);
    expect(counts.get('r1')).toBe(1);
    expect(counts.get('r2')).toBe(1);
  });

  it('getThread returns root + ordered descendants', () => {
    const thread = getThread('root', simpleThread());
    expect(thread.root?.message.id).toBe('root');
    expect(thread.descendants.map((e) => e.message.id)).toEqual(['a', 'b', 'c']);
  });

  it('getThread survives a missing root via chain matching', () => {
    // Root is compacted away; only the branched entries survive the reload.
    const entries = [
      entry('a', msg('a', 'user', { replyToId: 'root', branched: true })),
      entry('b', msg('b', 'user', { replyToId: 'a', branched: true })),
    ];
    const thread = getThread('root', entries);
    expect(thread.root).toBeUndefined();
    expect(thread.descendants.map((e) => e.message.id)).toEqual(['a', 'b']);
  });

  it('threadChainContains only walks branched chains', () => {
    const byId = indexThreadViews(simpleThread());
    expect(threadChainContains('root', 'c', byId)).toBe(true);
    // a plain (non-branched) chain member is not a branch walk
    expect(threadChainContains('root', 'root', byId)).toBe(true);
    expect(threadChainContains('ghost', 'c', byId)).toBe(false);
  });
});

// ─── Quote helpers (P2.3 pure part) ──────────────────────────────────────

describe('quote helpers', () => {
  it('renders the grok-aligned prefix', () => {
    expect(renderReplyQuotePrefix('msg-1', 'hello world')).toBe(
      '[In reply to msg-1: "hello world"]',
    );
  });

  it('extracts and bounds quote text', () => {
    const long = msg('long', 'assistant');
    long.content = 'a'.repeat(600);
    const quote = messageToQuoteText(long);
    expect(quote.length).toBeLessThanOrEqual(501);
    expect(quote.endsWith('…')).toBe(true);
  });

  it('reads quote text from text blocks', () => {
    const rich = msg('rich', 'assistant');
    rich.content = [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: ' hmm ' }];
    expect(messageToQuoteText(rich)).toBe('hello hmm');
  });

  it('applyReplyQuoteContext prefixes a reply user message once (idempotent)', () => {
    const root = msg('root', 'assistant', undefined);
    root.content = 'The answer is 42';
    const reply = msg('reply', 'user', { replyToId: 'root' });
    reply.content = 'Why 42?';

    const lookup = (id: string) => (id === 'root' ? 'The answer is 42' : '');
    const once = applyReplyQuoteContext([reply], lookup);
    expect((once[0] as { content: string }).content).toContain('[In reply to root: "The answer is 42"]');
    // second pass must not double-inject
    const twice = applyReplyQuoteContext(once, lookup);
    expect(twice[0] as { content: string }).toEqual(once[0] as { content: string });
  });

  it('prefixes structured content with a leading text block', () => {
    const reply = msg('reply', 'user', { replyToId: 'root' });
    reply.content = [{ type: 'text', text: 'hi' }];
    const lookup = () => 'quote-me';
    const out = applyReplyQuoteContext([reply], lookup);
    const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0]).toEqual({ type: 'text', text: '[In reply to root: "quote-me"]' });
    expect(content[1]).toEqual({ type: 'text', text: 'hi' });
  });

  it('leaves messages without replyToId / without a quote untouched', () => {
    const plain = msg('plain', 'user');
    const out = applyReplyQuoteContext([plain], () => 'x');
    expect(out).toEqual([plain]);
  });

  it('collectMessageIds gathers timeline message ids', () => {
    const ids = collectMessageIds(simpleThread());
    expect(ids).toEqual(new Set(['root', 'a', 'b', 'c']));
  });

  it('indexThreadViews skips non-message entries', () => {
    const entries: MessageEntry[] = simpleThread();
    const byId = indexThreadViews([...entries, { type: 'model_change', id: 'mc', parentId: null, createdAt, fromModel: 'a', toModel: 'b' }]);
    expect(byId.size).toBe(4);
    expect((byId.get('a') as ThreadMessageView).replyToId).toBe('root');
  });
});
