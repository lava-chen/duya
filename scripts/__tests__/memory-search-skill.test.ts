/**
 * scripts/__tests__/memory-search-skill.test.ts
 *
 * Tests for the memory-search skill script (CLI entry: --query/-q + --json;
 * hook stdin entry). The script is a thin wrapper over
 * scripts/memory-rag-lib.mjs — the hook-contract behavior itself is covered
 * by memory-rag-hook.test.ts.
 */

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
  close(): void;
};

const SCRIPT = path.resolve(
  process.cwd(),
  'packages',
  'agent',
  'skills',
  '.system',
  'memory-search',
  'scripts',
  'memory-search.mjs',
);

let tmpDir: string;
let configDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-search-skill-'));
  configDir = path.join(tmpDir, 'home');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(rag: Record<string, unknown>): void {
  const lines = ['[memory.rag]'];
  for (const [k, v] of Object.entries(rag)) {
    if (Array.isArray(v)) lines.push(`${k} = [${v.map((s) => JSON.stringify(s)).join(', ')}]`);
    else if (typeof v === 'string') lines.push(`${k} = ${JSON.stringify(v)}`);
    else lines.push(`${k} = ${String(v)}`);
  }
  fs.writeFileSync(path.join(configDir, 'config.toml'), lines.join('\n'), 'utf8');
}

function buildIndex(dbPath: string, docs: Array<{ root: string; rel: string; title: string; content: string; embedding?: number[] }>): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  try {
    db.prepare(
      `CREATE TABLE documents (
         root TEXT NOT NULL, rel_path TEXT NOT NULL, title TEXT NOT NULL,
         content TEXT NOT NULL, updated_at INTEGER NOT NULL, embedding TEXT,
         PRIMARY KEY (root, rel_path)
       )`,
    ).run();
    db.prepare(`CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tokenize='trigram')`).run();
    const ins = db.prepare('INSERT INTO documents (root, rel_path, title, content, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?)');
    const insFts = db.prepare('INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)');
    docs.forEach((d, i) => {
      const rowid = i + 1;
      ins.run(d.root, d.rel, d.title, d.content, Date.now(), d.embedding ? JSON.stringify(d.embedding) : null);
      insFts.run(rowid, d.title, d.content);
    });
  } finally {
    db.close();
  }
}

function runScript(
  args: string[],
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, DUYA_RAG_CONFIG_DIR: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => resolve({ code: null, stdout: out, stderr: err }));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill();
        resolve({ code: null, stdout: out, stderr: err });
      }
    }, 5000);
  });
}

describe('memory-search skill script', () => {
  it('searches via --query and prints readable hits', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
      { root: path.join(configDir, 'memory'), rel: 'global/areas/cooking.md', title: 'Cooking', content: 'wok stir fry recipe' },
    ]);

    const { code, stdout } = await runScript(['--query', 'dam crest elevation']);
    expect(code).toBe(0);
    expect(stdout).toContain('Hydrology');
    expect(stdout).not.toContain('Cooking');
  });

  it('supports --json output with title/path/snippet', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
    ]);

    const { code, stdout } = await runScript(['-q', 'hydrology', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; mode: string; hits: Array<{ title: string; path: string; snippet: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.hits.length).toBeGreaterThanOrEqual(1);
    expect(parsed.hits[0].title).toBe('Hydrology');
    expect(parsed.hits[0].path).toContain('hydrology.md');
  });

  it('windows the snippet around the matched term instead of the file head', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    const filler = Array.from({ length: 30 }, (_, i) => `intro filler sentence ${i + 1} padding`).join(' ');
    const content = `${filler} The STALE_STATE lock protocol lives here. ${filler}`;
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/protocol.md', title: 'Protocol', content },
    ]);

    const { code, stdout } = await runScript(['-q', 'STALE_STATE', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; hits: Array<{ snippet: string }> };
    expect(parsed.hits.length).toBeGreaterThanOrEqual(1);
    expect(parsed.hits[0].snippet).toContain('STALE_STATE');
    expect(parsed.hits[0].snippet).toContain('…');
    // The window must not START at the file head ('intro filler sentence 1'
    // is the document's first words) — the preview opens around the term.
    expect(parsed.hits[0].snippet.startsWith('intro filler sentence 1')).toBe(false);
  });

  it('skips short queries in CLI mode', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
    ]);

    const text = await runScript(['--query', '继续']);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe('');

    const json = await runScript(['--query', '继续', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as { ok: boolean; hits: unknown[]; skipped: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.hits).toEqual([]);
    expect(parsed.skipped).toBe(true);
  });

  it('answers the hook stdin contract like memory-rag-hook.mjs', async () => {
    writeConfig({ enabled: true });
    const dbPath = path.join(configDir, 'rag', 'memory-rag.db');
    buildIndex(dbPath, [
      { root: path.join(configDir, 'memory'), rel: 'global/areas/hydrology.md', title: 'Hydrology', content: 'dam crest elevation notes' },
    ]);

    const { code, stdout } = await runScript(
      [],
      JSON.stringify({ session_id: 's', cwd: '/', hook_event_name: 'UserPromptSubmit', prompt: 'dam crest hydrology' }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { additionalContext: string };
    expect(parsed.additionalContext).toContain('Hydrology');
  });
});
