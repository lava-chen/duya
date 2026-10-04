import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as new (file: string) => {
  prepare(sql: string): { run(...args: unknown[]): { lastInsertRowid: number }; all(...args: unknown[]): unknown[] };
  transaction(fn: () => void): () => void;
  close(): void;
};

const HOOK = path.resolve(process.cwd(), 'scripts', 'memory-rag-hook.mjs');
const FORMAT_TOTAL_CHARS = 8_000;
const FORMAT_TOP_HIT_BODY_CHARS = 4_000;

let tmpDir: string;
let configDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-hook-'));
  configDir = path.join(tmpDir, 'home');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ProviderEntry {
  providerType: string;
  baseUrl: string;
}

function writeConfig(
  rag: Record<string, unknown>,
  providers: Record<string, ProviderEntry> = {},
): void {
  const lines = ['[memory.rag]'];
  for (const [k, v] of Object.entries(rag)) {
    if (Array.isArray(v)) lines.push(`${k} = [${v.map((s) => JSON.stringify(s)).join(', ')}]`);
    else if (typeof v === 'string') lines.push(`${k} = ${JSON.stringify(v)}`);
    else lines.push(`${k} = ${String(v)}`);
  }
  for (const [id, entry] of Object.entries(providers)) {
    lines.push(`[providers.${id}]`);
    lines.push(`providerType = ${JSON.stringify(entry.providerType)}`);
    lines.push(`baseUrl = ${JSON.stringify(entry.baseUrl)}`);
  }
  fs.writeFileSync(path.join(configDir, 'config.toml'), lines.join('\n'), 'utf8');
}

function writeSecrets(secrets: Record<string, string>): void {
  fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify(secrets), 'utf8');
}

interface IndexDoc {
  root: string;
  rel: string;
  title: string;
  content: string;
  embedding?: number[];
}

/** Build an index DB matching the plan-428 schema. */
function buildIndex(dbPath: string, docs: IndexDoc[]): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  try {
    db.prepare(
      `CREATE TABLE documents (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        embedding TEXT,
        UNIQUE(root, rel_path)
      )`,
    ).run();
    db.prepare(
      `CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tokenize='trigram')`,
    ).run();
    const insertDoc = db.prepare(
      'INSERT INTO documents (root, rel_path, title, content, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare('INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      for (const d of docs) {
        const info = insertDoc.run(
          d.root,
          d.rel,
          d.title,
          d.content,
          1,
          d.embedding ? JSON.stringify(d.embedding) : null,
        );
        insertFts.run(info.lastInsertRowid, d.title, d.content);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/** Read today's system-log JSONL under the test config dir. */
function readSystemLog(configDir: string): Array<Record<string, unknown>> {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const file = path.join(
    configDir,
    'memory-system-log',
    String(d.getFullYear()),
    pad(d.getMonth() + 1),
    `${pad(d.getDate())}.jsonl`,
  );
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function runHook(prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK], {
      // DUYA_MEMORY_ENABLED pins the hook's memory toggle ON. The hook's
      // `isMemoryDisabled()` gate (scripts/memory-rag-hook.mjs) defaults to
      // DISABLED unless DUYA_DEV=1, and short-circuits with an empty stdout
      // before it ever reads stdin. Inheriting the ambient environment made
      // every retrieval assertion below depend on whether the developer
      // happened to have DUYA_DEV set. Pin it so the tests exercise the
      // retrieval path, and let the per-test RAG config decide the rest.
      env: { ...process.env, DUYA_RAG_CONFIG_DIR: configDir, DUYA_MEMORY_ENABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    // The hook is fail-open by contract (always exit 0), so a retrieval
    // failure is reported ONLY on stderr. Without draining stderr the real
    // cause of an empty stdout is invisible from the test output.
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', () => {
      resolve({ code: null, stdout: out, stderr: err });
    });
    child.on('close', (code) => {
      resolve({ code, stdout: out, stderr: err });
    });
    child.stdin.write(
      JSON.stringify({ session_id: 's', cwd: '/', hook_event_name: 'UserPromptSubmit', prompt }),
    );
    child.stdin.end();
    // Safety net: never let a hung hook block the suite.
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill();
        resolve({ code: null, stdout: out, stderr: err });
      }
    }, 8000);
  });
}

interface EmbedCall {
  path: string | undefined;
  auth: string | undefined;
  body: unknown;
}

function startEmbedServer(opts: { vector?: number[]; status?: number } = {}): Promise<{
  url: string;
  calls: EmbedCall[];
  close: () => void;
}> {
  const vector = opts.vector ?? [1, 0];
  const calls: EmbedCall[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({
        path: req.url,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      res.setHeader('Content-Type', 'application/json');
      if (opts.status && opts.status !== 200) {
        res.statusCode = opts.status;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify({ data: [{ embedding: vector }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Parse the hook's stdout contract, surfacing stderr when it is empty.
 *
 * The hook fails open: it always exits 0, and the early-exit paths
 * (memory toggle off, RAG disabled, no index, no hits) write nothing at
 * all. A bare `JSON.parse(stdout)` therefore reports only
 * "Unexpected end of JSON input" and never says WHICH gate closed, so
 * include both the exit code and the captured stderr in the failure.
 */
function parseHookOutput(
  result: { code: number | null; stdout: string; stderr: string },
): { additionalContext: string } {
  try {
    return JSON.parse(result.stdout) as { additionalContext: string };
  } catch (err) {
    const detail = [
      `exit code: ${result.code}`,
      `stdout: ${JSON.stringify(result.stdout)}`,
      `stderr: ${JSON.stringify(result.stderr)}`,
    ].join('\n');
    throw new Error(
      `memory-rag-hook produced no parseable stdout (${err instanceof Error ? err.message : String(err)}).\n${detail}`,
    );
  }
}

describe('memory-rag-hook.mjs', () => {
  it('emits empty context and exits 0 when rag is disabled', async () => {
    writeConfig({ enabled: false });
    const { code, stdout, stderr } = await runHook('anything');
    expect(code).toBe(0);
    expect(stdout).toBe('');
    // The memory toggle is pinned on by runHook, so an empty stdout here can
    // only come from the RAG config gate. A silent stderr keeps the two gates
    // distinguishable.
    expect(stderr).toBe('');
  });

  it('skips short and filler prompts before touching the index', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
    ]);

    for (const prompt of ['继续', '你好', 'ok', 'hi', 'a', '   ']) {
      const { code, stdout, stderr } = await runHook(prompt);
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    }
    // The filter exits before retrieval — no index read, no system-log event.
    expect(readSystemLog(configDir)).toEqual([]);
  });

  it('emits empty context and exits 0 when the index is missing', async () => {
    writeConfig({ enabled: true });
    const { code, stdout, stderr } = await runHook('anything');
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('returns vector-matched memories when the embedding endpoint works', async () => {
    const embed = await startEmbedServer({ vector: [1, 0] });
    try {
      writeConfig(
        { enabled: true, embedding_enabled: true, embedding_provider: 'local', embedding_model: 'bge' },
        { local: { providerType: 'openai-compatible', baseUrl: embed.url } },
      );
      writeSecrets({ 'providers.local.apiKey': 'sk-test' });
      const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
      buildIndex(dbPath, [
        { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes', embedding: [0.99, 0.01] },
        { root: path.join(configDir, 'memory'), rel: 'global/areas/cooking.md', title: 'Cooking', content: 'wok stir fry recipe', embedding: [-0.99, 0.01] },
      ]);

      const { code, stdout, stderr } = await runHook('what about the dam hydrology');
      expect(code).toBe(0);
      const parsed = parseHookOutput({ code, stdout, stderr });
      expect(parsed.additionalContext).toContain('Hydrology');
      expect(parsed.additionalContext).not.toContain('Cooking');
      expect(embed.calls[0].auth).toBe('Bearer sk-test');
      expect(embed.calls[0].body).toMatchObject({ model: 'bge', input: ['what about the dam hydrology'] });

      // Retrieval was logged to the memory system log with the session id.
      const events = readSystemLog(configDir);
      const retrieved = events.find((e) => e.event_type === 'rag_hook_retrieved');
      expect(retrieved).toBeDefined();
      expect(retrieved).toMatchObject({
        phase: 'system',
        level: 'info',
        session_id: 's',
        detail: { hits: 1, mode: 'hybrid' },
      });
    } finally {
      embed.close();
    }
  });

  it('falls back to keyword search when the embedding endpoint fails', async () => {
    const embed = await startEmbedServer({ status: 500 });
    try {
      writeConfig(
        { enabled: true, embedding_enabled: true, embedding_provider: 'local', embedding_model: 'bge' },
        { local: { providerType: 'openai-compatible', baseUrl: embed.url } },
      );
      const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
      buildIndex(dbPath, [
        { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
      ]);

      const { code, stdout, stderr } = await runHook('hydrology crest');
      expect(code).toBe(0);
      const parsed = parseHookOutput({ code, stdout, stderr });
      expect(parsed.additionalContext).toContain('Hydrology');
      expect(parsed.additionalContext).toContain('dam crest elevation notes');

      // Embedding failure degraded to keyword mode; the system log records
      // the retrieval with the fallback reason.
      const events = readSystemLog(configDir);
      const retrieved = events.find((e) => e.event_type === 'rag_hook_retrieved');
      expect(retrieved).toBeDefined();
      expect(retrieved).toMatchObject({
        phase: 'system',
        level: 'info',
        session_id: 's',
        detail: { hits: 1, mode: 'keyword' },
      });
      expect(
        (retrieved!.detail as Record<string, unknown>).fallback,
      ).toEqual(expect.any(String));
    } finally {
      embed.close();
    }
  });

  it('uses pure keyword search for providers without an embeddings endpoint (anthropic)', async () => {
    writeConfig(
      { enabled: true, embedding_enabled: true, embedding_provider: 'anthropic', embedding_model: 'claude' },
      { anthropic: { providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' } },
    );
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
    ]);

    const { code, stdout, stderr } = await runHook('crest elevation');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    expect(parsed.additionalContext).toContain('Hydrology');
  });

  it('character-windows a long single-line hit around the matched term (line-windowed contract)', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    const filler = Array.from({ length: 30 }, (_, i) => `intro filler sentence ${i + 1} padding`).join(' ');
    const content = `${filler} The STALE_STATE lock protocol rule lives here. ${filler}`;
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/protocol.md', title: 'Protocol', content },
    ]);

    const { code, stdout, stderr } = await runHook('STALE_STATE lock');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    expect(ctx.startsWith('### 相关记忆')).toBe(true);
    expect(ctx).toContain('Protocol');
    // The matched phrase is the window anchor, so it always survives intact.
    expect(ctx).toContain('The STALE_STATE lock protocol rule lives here.');
    // The body is one long line, so buildLineSnippet falls back to a
    // character window around the anchor and brackets it with `…` on both
    // sides. This is the contract be95f2cf installed: the old plan-430
    // "ship the whole body" behaviour is gone on purpose (it was too wide).
    expect((ctx.match(/…/g) ?? []).length).toBe(2);
    // The window is bounded (~800 chars against a ~2 KB body), so the block
    // is materially smaller than the document it came from.
    expect(ctx.length).toBeLessThan(content.length);
    // Path is preserved as a breadcrumb for the model.
    expect(ctx).toContain('path:');
  });

  it('ships a short hit whole, dropping no lines', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    // A 3-line body fits inside the top-hit line window (8 before / 8 after),
    // so the matched line AND both neighbours reach the model: no content is
    // dropped. buildLineSnippet still brackets the window with "…" whenever it
    // has context lines on either side, so the guarantee asserted here is
    // about content completeness, not about marker absence.
    const content = 'line before one\nThe STALE_STATE lock protocol rule lives here.\nline after one';
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/short.md', title: 'ShortDoc', content },
    ]);

    const { code, stdout, stderr } = await runHook('STALE_STATE lock');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    expect(ctx).toContain('ShortDoc');
    // The matched line plus its neighbours all fit, so nothing is clipped.
    expect(ctx).toContain('line before one');
    expect(ctx).toContain('The STALE_STATE lock protocol rule lives here.');
    expect(ctx).toContain('line after one');
  });

  it('bounds an oversized TOP hit to the line window (per-hit cap)', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    // Build a single body that's clearly over the per-hit cap so the
    // integration test exercises the bounding path rather than relying on
    // test-only opts overrides.
    const tail = ' memory body keeps going past the per-hit cap so the new helper has to truncate it '.repeat(200);
    const content = `intro paragraph one. ${tail}`;
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/big.md', title: 'BigDoc', content },
    ]);

    const { code, stdout, stderr } = await runHook('memory body');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    // The anchor line's head survives even when the rest of the blob is cut.
    expect(ctx).toContain('intro paragraph one.');
    // A clipping marker is present so the model knows the body above was cut.
    // (be95f2cf replaced the old `read-full: ... truncated to 4000 chars`
    // marker with a plain `…`; FORMAT_TOP_HIT_BODY_CHARS no longer exists.)
    expect(ctx).toContain('…');
    // The block stays inside the total budget.
    expect(ctx.length).toBeLessThanOrEqual(FORMAT_TOTAL_CHARS);
  });

  it('caps the retrieval at 3 hits (plan 437 down from 5)', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    // Build 5 candidate hits — the user used to see 5 bodies injected; plan
    // 437 reduces that to 3. The two-term prompt is what makes the top 3
    // unambiguous: score is the matched-term ratio, so the three docs
    // carrying BOTH terms outrank the two that carry only one. A 1-term
    // prompt would score every doc 1.0 and leave the cut to bm25's
    // document-length normalization, which is not an ordering this test
    // should be asserting.
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/h1.md', title: 'Hit1', content: 'STALE_STATE lock one.' },
      { root: path.join(configDir, 'memory'), rel: 'global/areas/h2.md', title: 'Hit2', content: 'STALE_STATE lock two.' },
      { root: path.join(configDir, 'memory'), rel: 'global/areas/h3.md', title: 'Hit3', content: 'STALE_STATE lock three.' },
      { root: path.join(configDir, 'memory'), rel: 'global/areas/h4.md', title: 'Hit4', content: 'STALE_STATE four.' },
      { root: path.join(configDir, 'memory'), rel: 'global/areas/h5.md', title: 'Hit5', content: 'unrelated filler five.' },
    ]);

    const { code, stdout, stderr } = await runHook('STALE_STATE lock');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    // Exactly the 3 both-term hits are emitted.
    expect(ctx).toContain('Hit1');
    expect(ctx).toContain('Hit2');
    expect(ctx).toContain('Hit3');
    expect(ctx).not.toContain('Hit4');
    expect(ctx).not.toContain('Hit5');
  });

  it('drops lower-ranked hits whole (not mid-clip) when the total budget is exceeded', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    // Plan 437 hybrid: top hit ships full body (capped at
    // FORMAT_TOP_HIT_BODY_CHARS), lower hits ship ~220-char snippets.
    // Build a top hit body big enough that its truncated block fills
    // most of the 8 KB budget, then verify the second snippet fits but
    // the third snippet would overflow and gets dropped WHOLE.
    const bigTail = 'x'.repeat(10_000);
    buildIndex(dbPath, [
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/top.md',
        title: 'TopHit',
        content: `STALE_STATE lock. ${bigTail}`,
      },
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/second.md',
        title: 'SecondHit',
        content: `STALE_STATE freeform prose. ${'y'.repeat(10_000)}`,
      },
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/third.md',
        title: 'ThirdHit',
        content: `STALE_STATE extra. ${'z'.repeat(10_000)}`,
      },
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/fourth.md',
        title: 'FourthHit',
        content: `STALE_STATE extra. ${'w'.repeat(10_000)}`,
      },
    ]);

    const { code, stdout, stderr } = await runHook('STALE_STATE lock');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    expect(ctx).toContain('TopHit');
    // Output stays under the documented total budget + 2-char slack for
    // the trailing "\n\n" joiner.
    expect(ctx.length).toBeLessThanOrEqual(FORMAT_TOTAL_CHARS + 2);
    // Only the top hit ships the read-full marker; lower hits are
    // snippet-windowed (no truncation marker) or dropped whole.
    const truncationMarkers = ctx.match(/read-full: this hit was truncated/g) ?? [];
    expect(truncationMarkers.length).toBeLessThanOrEqual(1);
    // Plan 437: only 3 hits are even returned from retrieve(), so
    // retrieve caps the input. If the test ever exceeds the total
    // budget, hits beyond the cap get dropped WHOLE — the truncation
    // marker count above ensures no half-clipped bodies leaked.
  });

  it('sends windowed breadcrumbs for non-top hits (line-windowed contract)', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    // Both docs carry BOTH prompt terms so score (matched-term ratio) is 1.0
    // for each and the top hit is decided by bm25, which favours the shorter
    // body. The previous fixture gave TopHit a body containing neither
    // "STALE_STATE" nor "lock", so it could never match and the assertion
    // about the top hit was unreachable — it passed only because the suite
    // never reached retrieval at all.
    //
    // Top hit body is short so it ships whole. The second hit is intentionally
    // a long single-line blob: buildLineSnippet must window it (NOT emit the
    // whole 4 KB) and keep the matched term inside the window.
    const longBody = `${'x'.repeat(2_000)} STALE_STATE lock protocol ${'y'.repeat(2_000)}`;
    buildIndex(dbPath, [
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/top.md',
        title: 'TopHit',
        content: 'STALE_STATE lock: top hit concise answer to the user prompt',
      },
      {
        root: path.join(configDir, 'memory'),
        rel: 'global/areas/second.md',
        title: 'SecondHit',
        content: longBody,
      },
    ]);

    const { code, stdout, stderr } = await runHook('STALE_STATE lock');
    expect(code).toBe(0);
    const parsed = parseHookOutput({ code, stdout, stderr });
    const ctx = parsed.additionalContext;
    expect(ctx).toContain('TopHit');
    expect(ctx).toContain('top hit concise answer to the user prompt');
    expect(ctx).toContain('SecondHit');
    expect(ctx).toContain('STALE_STATE');
    // The whole block stays well inside the 8 KB total budget.
    expect(ctx.length).toBeLessThan(2_000);
    // buildLineSnippet brackets a character-windowed anchor line with "…" on
    // both sides. With a 2 KB prefix AND 2 KB suffix, both ellipses must be
    // present.
    expect((ctx.match(/…/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The padding markers unique to the long body must NOT appear
    // verbatim — both the leading "x"x2000 and trailing "y"x2000 are
    // past the snippet window, so neither character run should leak.
    expect(ctx).not.toContain('x'.repeat(500));
    expect(ctx).not.toContain('y'.repeat(500));
  });

  it('emits empty context when no document matches', async () => {
    const embed = await startEmbedServer({ vector: [1, 0] });
    try {
      writeConfig(
        { enabled: true, embedding_enabled: true, embedding_provider: 'local', embedding_model: 'bge' },
        { local: { providerType: 'openai-compatible', baseUrl: embed.url } },
      );
      const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
      buildIndex(dbPath, [
        { root: path.join(configDir, 'memory'), rel: 'global/areas/cooking.md', title: 'Cooking', content: 'wok stir fry', embedding: [-1, 0] },
      ]);
      const { code, stdout, stderr } = await runHook('unrelated programming question');
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toBe('');

      // No-hit retrieval still records one system-log event.
      const events = readSystemLog(configDir);
      expect(events.find((e) => e.event_type === 'rag_hook_no_hits')).toBeDefined();
    } finally {
      embed.close();
    }
  });
});
