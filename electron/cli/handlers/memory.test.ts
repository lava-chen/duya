/**
 * electron/cli/handlers/memory.test.ts
 *
 * Handler tests for `duya memory doctor / setup / status / config`.
 * The provider store and electron app are mocked; the config store is a
 * real ConfigStore over a temp config.toml so `getByPath` / `set` behave
 * like production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.env.DUYA_CLI_USER_DATA_DIR ?? tmpdir(),
  },
}));

const mocks = vi.hoisted(() => ({
  store: {
    getMemoryLlmProvider: vi.fn(),
    getLlmProvider: vi.fn(),
    getMemoryModel: vi.fn(),
  },
}));

// Point os.homedir() at a temp dir so the rebuild path (memory root + RAG
// index under ~/.duya) never touches the real home directory.
const mockHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => mockHome.dir };
});

vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => mocks.store,
}));

import { _setConfigStoreForTest } from '../../config/store-instance';
import { ConfigStore } from '../../config/store';
import {
  handleMemoryDoctor,
  handleMemorySetup,
  handleMemoryStatus,
  handleMemoryConfig,
  handleMemoryRebuild,
  handleMemorySearch,
  recommendEmbedding,
  evaluateMachine,
} from './memory.js';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeRes(): { res: ServerResponse; capture: CapturedResponse } {
  const capture: CapturedResponse = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      capture.status = status;
    },
    end(payload?: string | unknown) {
      if (typeof payload === 'string') {
        try {
          capture.body = JSON.parse(payload);
        } catch {
          capture.body = payload;
        }
      } else {
        capture.body = payload;
      }
    },
  } as unknown as ServerResponse;
  return { res, capture };
}

function makeReq(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
}

let tmpDir: string;
let configPath: string;
let secretsPath: string;
let realStore: ConfigStore;
let prevLogRoot: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memory-handler-'));
  configPath = join(tmpDir, 'config.toml');
  secretsPath = join(tmpDir, 'secrets.json');
  realStore = new ConfigStore({ configPath, secretsPath });
  _setConfigStoreForTest(realStore);
  mocks.store.getMemoryLlmProvider.mockReset();
  mocks.store.getLlmProvider.mockReset();
  mocks.store.getMemoryModel.mockReset();
  mockHome.dir = join(tmpDir, 'home');
  // Keep system-log writes (rag_index_rebuilt_manual) inside tmpDir.
  prevLogRoot = process.env.DUYA_MEMORY_LOG_ROOT;
  process.env.DUYA_MEMORY_LOG_ROOT = tmpDir;
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  if (prevLogRoot === undefined) delete process.env.DUYA_MEMORY_LOG_ROOT;
  else process.env.DUYA_MEMORY_LOG_ROOT = prevLogRoot;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('evaluateMachine', () => {
  it('reports cpu/ram/disk/low-power shape', () => {
    const m = evaluateMachine();
    expect(m.cpuCores).toBeGreaterThan(0);
    expect(m.ramGb).toBeGreaterThan(0);
    expect(['low', 'mid', 'high']).toContain(m.ramTier);
    expect(typeof m.diskFreeGb).toBe('number');
    expect(typeof m.lowPower).toBe('boolean');
  });
});

describe('recommendEmbedding', () => {
  it('keeps an explicit [memory.rag] provider/model', () => {
    realStore.set('memory.rag', {
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: true,
      embedding_provider: 'ollama',
      embedding_model: 'bge-m3',
    });
    const rec = recommendEmbedding(mocks.store as never);
    expect(rec.provider).toBe('ollama');
    expect(rec.model).toBe('bge-m3');
  });

  it('reuses the memory provider when it is not anthropic', () => {
    mocks.store.getMemoryLlmProvider.mockReturnValue({ id: 'deepseek', apiFormat: 'openai-chat' });
    const rec = recommendEmbedding(mocks.store as never);
    expect(rec.provider).toBe('deepseek');
    expect(rec.model).toBe('');
  });

  it('recommends local ollama when the memory provider is anthropic (no embeddings API)', () => {
    mocks.store.getMemoryLlmProvider.mockReturnValue({ id: 'anthropic', apiFormat: 'anthropic' });
    const rec = recommendEmbedding(mocks.store as never);
    expect(rec.provider).toBe('ollama');
    expect(['bge-m3', 'nomic-embed-text']).toContain(rec.model);
  });
});

describe('handleMemoryDoctor', () => {
  it('returns machine + current config + recommendation', () => {
    const { res, capture } = makeRes();
    handleMemoryDoctor(makeReq({}) as IncomingMessage, res);
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; machine: unknown; current: unknown; recommendation: unknown };
    expect(body.ok).toBe(true);
    expect(body.machine).toBeTruthy();
    expect(body.current).toBeTruthy();
    expect(body.recommendation).toBeTruthy();
  });
});

describe('handleMemorySetup', () => {
  it('applies explicit provider + model and enables rag', async () => {
    mocks.store.getLlmProvider.mockReturnValue({ id: 'ollama', apiFormat: 'ollama' });
    const { res, capture } = makeRes();
    await handleMemorySetup(
      makeReq({ provider: 'ollama', model: 'bge-m3' }) as IncomingMessage,
      res,
    );
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; provider: string; model: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('ollama');
    const saved = realStore.getByPath('memory.rag') as { enabled: boolean; embedding_provider: string; embedding_model: string };
    expect(saved.enabled).toBe(true);
    expect(saved.embedding_provider).toBe('ollama');
    expect(saved.embedding_model).toBe('bge-m3');
  });

  it('uses the backend recommendation with auto: true', async () => {
    mocks.store.getMemoryLlmProvider.mockReturnValue({ id: 'anthropic', apiFormat: 'anthropic' });
    mocks.store.getLlmProvider.mockReturnValue({ id: 'ollama', apiFormat: 'ollama' });
    const { res, capture } = makeRes();
    await handleMemorySetup(makeReq({ auto: true }) as IncomingMessage, res);
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; provider: string };
    expect(body.provider).toBe('ollama');
  });

  it('rejects an unknown provider', async () => {
    mocks.store.getLlmProvider.mockReturnValue(undefined);
    const { res, capture } = makeRes();
    await handleMemorySetup(makeReq({ provider: 'nope' }) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    expect((capture.body as { error: string }).error).toContain('not found');
  });

  it('rejects an anthropic provider', async () => {
    mocks.store.getLlmProvider.mockReturnValue({ id: 'anthropic', apiFormat: 'anthropic' });
    const { res, capture } = makeRes();
    await handleMemorySetup(makeReq({ provider: 'anthropic' }) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    expect((capture.body as { error: string }).error).toContain('no embeddings API');
  });
});

describe('handleMemoryConfig', () => {
  it('writes an allowed key under memory.rag', async () => {
    const { res, capture } = makeRes();
    await handleMemoryConfig(
      makeReq({ path: 'scan_paths', value: ['~/notes', 'E:/docs'] }) as IncomingMessage,
      res,
    );
    expect(capture.status).toBe(200);
    const saved = realStore.getByPath('memory.rag.scan_paths') as string[];
    expect(saved).toEqual(['~/notes', 'E:/docs']);
  });

  it('normalizes a JSON-array string scan_paths value (bug 2026-08-19 #5)', async () => {
    const { res, capture } = makeRes();
    await handleMemoryConfig(
      makeReq({ path: 'scan_paths', value: '["~/notes","E:/docs"]' }) as IncomingMessage,
      res,
    );
    expect(capture.status).toBe(200);
    const saved = realStore.getByPath('memory.rag.scan_paths') as string[];
    expect(saved).toEqual(['~/notes', 'E:/docs']);
  });

  it('treats a bare scan_paths string as a single-element array', async () => {
    const { res, capture } = makeRes();
    await handleMemoryConfig(
      makeReq({ path: 'scan_paths', value: 'E:/docs' }) as IncomingMessage,
      res,
    );
    expect(capture.status).toBe(200);
    const saved = realStore.getByPath('memory.rag.scan_paths') as string[];
    expect(saved).toEqual(['E:/docs']);
  });

  it('rejects an invalid scan_paths JSON value', async () => {
    const { res, capture } = makeRes();
    await handleMemoryConfig(
      makeReq({ path: 'scan_paths', value: '["unterminated' }) as IncomingMessage,
      res,
    );
    expect(capture.status).toBe(400);
  });

  it('rejects an unknown key', async () => {
    const { res, capture } = makeRes();
    await handleMemoryConfig(makeReq({ path: 'evil', value: 1 }) as IncomingMessage, res);
    expect(capture.status).toBe(400);
  });
});

describe('handleMemoryStatus', () => {
  it('reports config + index state (missing index → exists false)', () => {
    const { res, capture } = makeRes();
    handleMemoryStatus(makeReq({}) as IncomingMessage, res);
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; enabled: boolean; indexExists: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.indexExists).toBe(false);
  });
});

describe('handleMemoryRebuild', () => {
  it('rebuilds the index when rag is enabled and records the manual event', async () => {
    // Enable [memory.rag] and drop one memory file into the (fake) memory root.
    realStore.set('memory.rag', {
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: false,
      embedding_provider: '',
      embedding_model: '',
    });
    const memoryDir = join(mockHome.dir, '.duya', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'hydrology.md'), '# Hydrology\nDam crest elevation notes.\n', 'utf8');

    const { res, capture } = makeRes();
    await handleMemoryRebuild(makeReq({}) as IncomingMessage, res);

    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; documents: number };
    expect(body.ok).toBe(true);
    expect(body.documents).toBeGreaterThanOrEqual(1);

    // The manual rebuild landed in the memory system log.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const logFile = join(
      tmpDir,
      'memory-system-log',
      String(d.getFullYear()),
      pad(d.getMonth() + 1),
      `${pad(d.getDate())}.jsonl`,
    );
    const events = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e.event_type === 'rag_index_rebuilt_manual')).toBeDefined();
  });

  it('includes configured [memory.rag].scan_paths in the rebuild (bug 2026-08-19 #5)', async () => {
    realStore.set('memory.rag', {
      enabled: true,
      index_path: '',
      scan_paths: [join(mockHome.dir, 'notes')],
      embedding_enabled: false,
      embedding_provider: '',
      embedding_model: '',
    });
    const memoryDir = join(mockHome.dir, '.duya', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'hydrology.md'), '# Hydrology\nDam crest elevation notes.\n', 'utf8');
    const notesDir = join(mockHome.dir, 'notes');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, 'notes.md'), '# Notes\nMeeting minutes.\n', 'utf8');

    const { res, capture } = makeRes();
    await handleMemoryRebuild(makeReq({}) as IncomingMessage, res);

    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; documents: number; scanRoots: string[] };
    expect(body.ok).toBe(true);
    expect(body.documents).toBe(2);
    expect(body.scanRoots).toEqual([
      join(mockHome.dir, '.duya', 'memory'),
      join(mockHome.dir, 'notes'),
    ]);
  });

  it('rejects with 400 when rag is not enabled', async () => {
    const { res, capture } = makeRes();
    await handleMemoryRebuild(makeReq({}) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    const body = capture.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not enabled');
  });
});

describe('handleMemorySearch', () => {
  /** Enable rag and build an index over one memory file (shared setup). */
  async function seedIndex(): Promise<void> {
    realStore.set('memory.rag', {
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: false,
      embedding_provider: '',
      embedding_model: '',
    });
    const memoryDir = join(mockHome.dir, '.duya', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'hydrology.md'), '# Hydrology\nDam crest elevation notes.\n', 'utf8');
    const { res, capture } = makeRes();
    await handleMemoryRebuild(makeReq({}) as IncomingMessage, res);
    expect(capture.status).toBe(200);
  }

  it('returns keyword hits from the index', async () => {
    await seedIndex();

    const { res, capture } = makeRes();
    await handleMemorySearch(makeReq({ query: 'dam crest elevation' }) as IncomingMessage, res);
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; mode: string; hits: Array<{ title: string; path: string; snippet: string }> };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('keyword');
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits[0].title).toBe('Hydrology');
    expect(body.hits[0].path).toContain('hydrology.md');
    expect(body.hits[0].snippet.toLowerCase()).toContain('dam crest elevation');
  });

  it('skips queries shorter than the minimum length', async () => {
    await seedIndex();

    const { res, capture } = makeRes();
    await handleMemorySearch(makeReq({ query: '继续' }) as IncomingMessage, res);
    expect(capture.status).toBe(200);
    const body = capture.body as { ok: boolean; skipped: boolean; hits: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.hits).toEqual([]);
  });

  it('rejects with 400 when rag is not enabled', async () => {
    const { res, capture } = makeRes();
    await handleMemorySearch(makeReq({ query: 'dam crest elevation' }) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    const body = capture.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not enabled');
  });

  it('rejects with 400 when the query is missing', async () => {
    await seedIndex();

    const { res, capture } = makeRes();
    await handleMemorySearch(makeReq({}) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    const body = capture.body as { ok: boolean; error: string };
    expect(body.error).toContain('query is required');
  });

  it('rejects with 400 when the index is missing', async () => {
    realStore.set('memory.rag', {
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: false,
      embedding_provider: '',
      embedding_model: '',
    });

    const { res, capture } = makeRes();
    await handleMemorySearch(makeReq({ query: 'dam crest elevation' }) as IncomingMessage, res);
    expect(capture.status).toBe(400);
    const body = capture.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('index');
  });
});
