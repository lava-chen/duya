/**
 * e2e/perf/lib/fixtures.mjs — the public fixture generator.
 *
 * Every agent in the Desktop performance sprint measures against the SAME
 * fixtures, otherwise the numbers are not comparable across agents. This
 * module is the single source of those fixtures.
 *
 * FIXTURE IDS (the agreed identifiers)
 *
 *   perf/session-100        100 history messages in one session
 *   perf/session-1000      1000 history messages in one session
 *   perf/session-10000    10000 history messages in one session
 *   perf/stream-long-reply  one long reply streamed token by token
 *   perf/stream-tool-storm  a large number of tool events flowing in
 *   perf/typing-30s         30 seconds of continuous typing in the composer
 *
 * DETERMINISM
 *
 * Nothing here reads the clock, the filesystem or a random source. The text
 * comes from a fixed word list and the row order from a fixed seed, so two
 * runs — on two machines — produce byte-identical payloads. The digest
 * printed in the report is the SHA-256 of the canonical payload, so a report
 * can be checked against the fixture it claims to have used.
 *
 * MESSAGE MIX (the convention other agents should assume)
 *
 * A history fixture repeats a 10-row block:
 *
 *   0 user text      1 assistant text   2 user text    3 assistant text
 *   4 user text      5 assistant tool_use                6 tool tool_result
 *   7 assistant text 8 user text        9 assistant text
 *
 * i.e. 40% user text, 40% assistant text and 20% tool rows (one tool_use
 * plus its tool_result). Text rows are ~180 characters of fixed filler; the
 * last row of the last block is truncated so the fixture always has exactly
 * the requested number of rows.
 */
import { createHash } from 'node:crypto';

export const FIXTURE_IDS = Object.freeze([
  'perf/session-100',
  'perf/session-1000',
  'perf/session-10000',
  'perf/stream-long-reply',
  'perf/stream-long-reply-fenced',
  'perf/stream-tool-storm',
  'perf/typing-30s',
]);

/** The history fixtures, keyed by id, with the row count each one carries. */
const HISTORY_SIZES = new Map([
  ['perf/session-100', 100],
  ['perf/session-1000', 1000],
  ['perf/session-10000', 10000],
]);

/** Fixed vocabulary — the fixture text must not depend on anything external. */
const WORDS = [
  'perf', 'harness', 'renderer', 'commit', 'fixture', 'session', 'timeline',
  'stream', 'tool', 'event', 'longtask', 'frame', 'p95', 'baseline', 'delta',
  'collector', 'electron', 'preview', 'namespace', 'digest', 'percentile',
  'maintainer', 'renderer', 'budget', 'regression', 'threshold', 'observation',
];

const TOOL_NAMES = ['Read', 'Grep', 'Bash', 'Edit', 'Glob'];

/** mulberry32 — small, fast, and identical on every platform. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function filler(random, words) {
  const parts = [];
  for (let i = 0; i < words; i += 1) {
    parts.push(WORDS[Math.floor(random() * WORDS.length)]);
  }
  return parts.join(' ');
}

/**
 * The row kind for one slot of the 10-row block. Exported so a reader (or
 * another agent's script) can reason about the mix without re-deriving it.
 */
export function historyRowKind(index) {
  const slot = index % 10;
  if (slot === 5) return 'tool_use';
  if (slot === 6) return 'tool_result';
  if (slot === 0 || slot === 2 || slot === 4 || slot === 8) return 'user';
  return 'assistant';
}

/**
 * Build the message rows of a history fixture.
 *
 * The rows are shaped like the flat IPC message DTO the product's own
 * `db:message:replace` handler accepts, so the fixture can be injected
 * through the real bridge and land in the real store.
 *
 * `options.idPrefix` namespaces the row ids. It is REQUIRED whenever the same
 * fixture is seeded into more than one session of the same database: the
 * transcript store appends with INSERT OR IGNORE on the message id, so two
 * sessions carrying the same ids would leave the second session empty (and
 * the product would read back zero rows).
 */
export function buildSessionMessages(fixtureId, options = {}) {
  const total = HISTORY_SIZES.get(fixtureId);
  if (total === undefined) {
    throw new Error(`not a history fixture: ${fixtureId}`);
  }
  const random = makeRandom(options.seed ?? 0x5eed1234);
  const baseTime = options.baseTime ?? 1_700_000_000_000;
  const idPrefix = options.idPrefix
    ? `${options.idPrefix.replace(/[^a-z0-9]+/gi, '-')}-`
    : '';
  const rows = [];
  let toolCallSeq = 0;

  for (let index = 0; index < total; index += 1) {
    const kind = historyRowKind(index);
    const id = `${idPrefix}${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-m${String(index).padStart(5, '0')}`;
    const createdAt = baseTime + index * 1000;
    if (kind === 'tool_use') {
      toolCallSeq += 1;
      const toolName = TOOL_NAMES[index % TOOL_NAMES.length];
      rows.push({
        id,
        role: 'assistant',
        content: '',
        created_at: createdAt,
        msg_type: 'tool_use',
        tool_name: toolName,
        tool_input: JSON.stringify({
          path: `src/perf/fixture-${index}.ts`,
          pattern: `perf-${index}`,
        }),
        tool_call_id: `call-${toolCallSeq}`,
      });
      continue;
    }
    if (kind === 'tool_result') {
      const toolName = TOOL_NAMES[(index - 1) % TOOL_NAMES.length];
      rows.push({
        id,
        role: 'tool',
        content: filler(random, 24),
        created_at: createdAt,
        msg_type: 'tool_result',
        tool_name: toolName,
        tool_call_id: `call-${toolCallSeq}`,
      });
      continue;
    }
    rows.push({
      id,
      role: kind,
      content: filler(random, 28),
      created_at: createdAt,
      msg_type: 'text',
    });
  }
  return rows;
}

/** The streamed chunks of the long-reply fixture. */
export function buildStreamChunks(fixtureId = 'perf/stream-long-reply', options = {}) {
  const chunkCount = options.chunkCount ?? 2000;
  const chunkChars = options.chunkChars ?? 12;
  const intervalMs = options.intervalMs ?? 10;
  const random = makeRandom(options.seed ?? 0x51ea3);
  const chunks = [];
  let text = '';
  for (let i = 0; i < chunkCount; i += 1) {
    const piece = filler(random, 2);
    text += piece;
    chunks.push({ index: i, text: piece, offset: text.length });
  }
  return {
    fixtureId,
    chunkCount,
    chunkChars,
    intervalMs,
    totalChars: text.length,
    chunks,
  };
}

/**
 * The code blocks of the fenced long-reply fixture.
 *
 * The plain long-reply fixture is prose only, so the shared harness cannot
 * see what a syntax-highlighted code block costs while a reply is still
 * growing: the fence arrives in pieces, and the highlighter re-tokenizes the
 * whole block on every frame. These blocks are what that cost is made of.
 */
const FENCED_BLOCKS = [
  {
    language: 'ts',
    code: [
      'export function summarizeSession(rows: Row[]): string {',
      '  const users = rows.filter((row) => row.role === \'user\');',
      '  const replies = rows.filter((row) => row.role === \'assistant\');',
      '  const ratio = replies.length === 0 ? 0 : users.length / replies.length;',
      '  return `${users.length} user turns, ${replies.length} replies`;',
      '}',
    ],
  },
  {
    language: 'python',
    code: [
      'def percentile(values, p):',
      '    ordered = sorted(values)',
      '    if not ordered:',
      '        raise ValueError("no values")',
      '    index = round((len(ordered) - 1) * p)',
      '    return ordered[index]',
    ],
  },
  {
    language: 'bash',
    code: [
      'git diff --stat master..HEAD',
      'git log --oneline -n 20',
      'npm run typecheck:all',
      'npm run architecture:check',
    ],
  },
];

/**
 * The prose-and-code text of the fenced long-reply fixture.
 *
 * The prose is the same vocabulary as the plain fixture, so the difference
 * between the two fixtures IS the code blocks and what highlighting them
 * costs.
 */
function buildFencedText(random, totalChars) {
  const parts = [];
  let length = 0;
  let blockIndex = 0;
  while (length < totalChars) {
    const prose = filler(random, 600);
    parts.push(prose);
    length += prose.length;
    const block = FENCED_BLOCKS[blockIndex % FENCED_BLOCKS.length];
    blockIndex += 1;
    const fenced = `\n\n\`\`\`${block.language}\n${block.code.join('\n')}\n\`\`\`\n\n`;
    parts.push(fenced);
    length += fenced.length;
  }
  return parts.join('');
}

/**
 * The streamed chunks of the FENCED long-reply fixture.
 *
 * Same size and same cadence as the plain one, with code blocks mixed into
 * the prose. The fence markers are split across chunks on purpose: that is
 * what a growing reply looks like, and it is the case the highlighter has to
 * survive.
 */
export function buildFencedStreamChunks(fixtureId = 'perf/stream-long-reply-fenced', options = {}) {
  const chunkCount = options.chunkCount ?? 2000;
  const chunkChars = options.chunkChars ?? 12;
  const intervalMs = options.intervalMs ?? 10;
  const random = makeRandom(options.seed ?? 0x51ea3);
  const text = buildFencedText(random, chunkCount * chunkChars);
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    const piece = text.slice(offset, offset + chunkChars);
    chunks.push({ index: chunks.length, text: piece, offset: offset + piece.length });
  }
  return {
    fixtureId,
    chunkCount,
    chunkChars,
    intervalMs,
    totalChars: text.length,
    chunks,
  };
}

/**
 * The rows of the tool-storm fixture: a long run of tool_use / tool_result
 * pairs, delivered in batches so the renderer sees a sustained flow rather
 * than one giant synchronous write.
 */
export function buildToolStormRows(fixtureId = 'perf/stream-tool-storm', options = {}) {
  const toolCalls = options.toolCalls ?? 200;
  const batchSize = options.batchSize ?? 8;
  const intervalMs = options.intervalMs ?? 16;
  const random = makeRandom(options.seed ?? 0x570f11);
  const rows = [];
  for (let i = 0; i < toolCalls; i += 1) {
    const toolName = TOOL_NAMES[i % TOOL_NAMES.length];
    rows.push({
      id: `${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-call-${String(i).padStart(4, '0')}`,
      role: 'assistant',
      content: '',
      created_at: 1_700_000_000_000 + i * 10,
      msg_type: 'tool_use',
      tool_name: toolName,
      tool_input: JSON.stringify({ path: `src/perf/storm-${i}.ts` }),
      tool_call_id: `storm-call-${i}`,
    });
    rows.push({
      id: `${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-result-${String(i).padStart(4, '0')}`,
      role: 'tool',
      content: filler(random, 16),
      created_at: 1_700_000_000_000 + i * 10 + 5,
      msg_type: 'tool_result',
      tool_name: toolName,
      tool_call_id: `storm-call-${i}`,
    });
  }
  const batches = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize));
  }
  return {
    fixtureId,
    toolCalls,
    batchSize,
    intervalMs,
    rowCount: rows.length,
    rows,
    batches,
  };
}

/** The typing schedule of the typing fixture. */
export function buildTypingFixture(fixtureId = 'perf/typing-30s', options = {}) {
  const durationMs = options.durationMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 60;
  const random = makeRandom(options.seed ?? 0x79f1a5);
  const keystrokes = Math.floor(durationMs / intervalMs);
  // The text has to be exactly `keystrokes` characters long: the harness
  // types it one character at a time, so a longer string would make the run
  // longer than the fixture says.
  const words = [];
  while (words.join(' ').length < keystrokes) {
    words.push(WORDS[Math.floor(random() * WORDS.length)]);
  }
  const text = words.join(' ').slice(0, keystrokes);
  return {
    fixtureId,
    durationMs,
    intervalMs,
    keystrokes,
    text,
  };
}

/** Human-readable description of a fixture, for the report. */
export function describeFixture(fixtureId) {
  if (HISTORY_SIZES.has(fixtureId)) {
    return {
      id: fixtureId,
      kind: 'history-session',
      messageCount: HISTORY_SIZES.get(fixtureId),
      mix: '40% user text, 40% assistant text, 20% tool rows (10-row block)',
    };
  }
  if (fixtureId === 'perf/stream-long-reply') {
    return {
      id: fixtureId,
      kind: 'streamed-text',
      chunkCount: 2000,
      chunkChars: 12,
      intervalMs: 10,
    };
  }
  if (fixtureId === 'perf/stream-long-reply-fenced') {
    return {
      id: fixtureId,
      kind: 'streamed-text-with-code',
      chunkCount: 2000,
      chunkChars: 12,
      intervalMs: 10,
      codeBlocks: FENCED_BLOCKS.length,
    };
  }
  if (fixtureId === 'perf/stream-tool-storm') {
    return {
      id: fixtureId,
      kind: 'streamed-tool-events',
      toolCalls: 200,
      batchSize: 8,
      intervalMs: 16,
      rowCount: 400,
    };
  }
  if (fixtureId === 'perf/typing-30s') {
    return {
      id: fixtureId,
      kind: 'composer-typing',
      durationMs: 30_000,
      intervalMs: 60,
      keystrokes: 500,
    };
  }
  throw new Error(`unknown fixture: ${fixtureId}`);
}

/**
 * The canonical payload of a fixture, hashed into the report.
 *
 * The digest is over the payload the harness actually injected, so a report
 * can be verified against the fixture it claims to have used. The canonical
 * payload is the UN-namespaced one: the per-session id namespace changes the
 * row ids (the transcript store keys on them) but not the fixture content, so
 * the digest stays the same whichever session the rows were seeded into.
 */
export function fixturePayload(fixtureId, options = {}) {
  if (HISTORY_SIZES.has(fixtureId)) {
    // The canonical payload is the UN-namespaced one: the per-session id
    // namespace changes the row ids (the transcript store keys on them) but
    // not the fixture content, so it must not change the digest. Every other
    // option (the seed) DOES change the content and therefore the digest.
    const { idPrefix: _namespace, ...canonical } = options;
    return { kind: 'history-session', rows: buildSessionMessages(fixtureId, canonical) };
  }
  if (fixtureId === 'perf/stream-long-reply') {
    return { kind: 'streamed-text', ...buildStreamChunks(fixtureId, options) };
  }
  if (fixtureId === 'perf/stream-long-reply-fenced') {
    return { kind: 'streamed-text-with-code', ...buildFencedStreamChunks(fixtureId, options) };
  }
  if (fixtureId === 'perf/stream-tool-storm') {
    const storm = buildToolStormRows(fixtureId, options);
    return {
      kind: 'streamed-tool-events',
      rowCount: storm.rowCount,
      toolCalls: storm.toolCalls,
      batchSize: storm.batchSize,
      intervalMs: storm.intervalMs,
      batches: storm.batches,
    };
  }
  if (fixtureId === 'perf/typing-30s') {
    return { kind: 'composer-typing', ...buildTypingFixture(fixtureId, options) };
  }
  throw new Error(`unknown fixture: ${fixtureId}`);
}

/** SHA-256 of the canonical fixture payload, truncated to 16 hex chars. */
export function fixtureDigest(fixtureId, options = {}) {
  const payload = fixturePayload(fixtureId, options);
  const canonical = JSON.stringify(payload);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
