/**
 * electron/cli/handlers/hooks.test.ts
 *
 * Handler tests for `duya hook list / validate / add / remove`.
 * The config store is a real ConfigStore over a temp config.toml so
 * `getByPath` / `set` behave like production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.env.DUYA_CLI_USER_DATA_DIR ?? tmpdir(),
  },
}));

import { _setConfigStoreForTest } from '../../config/store-instance';
import { ConfigStore } from '../../config/store';
import {
  handleHookList,
  handleHookValidate,
  handleHookAdd,
  handleHookRemove,
  validateHookFile,
} from './hooks.js';

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

function validHookJson(): string {
  return JSON.stringify({
    description: 'test hooks',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: 'node', args: ['x.mjs'] }] }],
      PreToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo hi', async: true }] },
      ],
    },
  });
}

let tmpDir: string;
let configPath: string;
let secretsPath: string;
let realStore: ConfigStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hooks-handler-'));
  configPath = join(tmpDir, 'config.toml');
  secretsPath = join(tmpDir, 'secrets.json');
  realStore = new ConfigStore({ configPath, secretsPath });
  _setConfigStoreForTest(realStore);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateHookFile', () => {
  it('accepts a well-formed ecosystem-shape hook.json', () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, validHookJson(), 'utf-8');
    const status = validateHookFile(p);
    expect(status.ok).toBe(true);
    expect(status.events).toEqual(expect.arrayContaining(['UserPromptSubmit', 'PreToolUse']));
    expect(status.hookCount).toBe(2);
  });

  it('rejects missing files, bad JSON, and missing hooks object', () => {
    expect(validateHookFile(join(tmpDir, 'nope.json')).ok).toBe(false);
    const badJson = join(tmpDir, 'bad.json');
    writeFileSync(badJson, 'not json {{{', 'utf-8');
    expect(validateHookFile(badJson).ok).toBe(false);
    const noHooks = join(tmpDir, 'nohooks.json');
    writeFileSync(noHooks, '{"description":"x"}', 'utf-8');
    expect(validateHookFile(noHooks).ok).toBe(false);
    const emptyHooks = join(tmpDir, 'empty.json');
    writeFileSync(emptyHooks, '{"hooks":{}}', 'utf-8');
    expect(validateHookFile(emptyHooks).ok).toBe(true);
  });

  it('rejects malformed matcher groups', () => {
    const p = join(tmpDir, 'badgroup.json');
    writeFileSync(
      p,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 3, hooks: [] }] } }),
      'utf-8',
    );
    const status = validateHookFile(p);
    expect(status.ok).toBe(false);
    expect(status.error).toContain('matcher');
  });
});

describe('handleHookList', () => {
  it('returns the registered files with per-file status', async () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, validHookJson(), 'utf-8');
    realStore.set('hooks', { files: [p, join(tmpDir, 'missing.json')] });

    const { res, capture } = makeRes();
    handleHookList(makeReq({}), res);
    const body = capture.body as { ok: boolean; files: Array<{ ok: boolean; path: string }> };
    expect(capture.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(2);
    expect(body.files[0].ok).toBe(true);
    expect(body.files[1].ok).toBe(false);
  });
});

describe('handleHookValidate', () => {
  it('validates a good file with 200', async () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, validHookJson(), 'utf-8');
    const { res, capture } = makeRes();
    await handleHookValidate(makeReq({ path: p }), res);
    expect(capture.status).toBe(200);
    expect((capture.body as { ok: boolean }).ok).toBe(true);
  });

  it('rejects a bad file with 422', async () => {
    const p = join(tmpDir, 'bad.json');
    writeFileSync(p, 'nope', 'utf-8');
    const { res, capture } = makeRes();
    await handleHookValidate(makeReq({ path: p }), res);
    expect(capture.status).toBe(422);
    expect((capture.body as { ok: boolean }).ok).toBe(false);
  });

  it('requires a path', async () => {
    const { res, capture } = makeRes();
    await handleHookValidate(makeReq({}), res);
    expect(capture.status).toBe(400);
  });
});

describe('handleHookAdd / handleHookRemove', () => {
  it('adds a valid file to [hooks] files (deduped by resolved path)', async () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, validHookJson(), 'utf-8');
    const { res: res1, capture: cap1 } = makeRes();
    await handleHookAdd(makeReq({ path: p }), res1);
    expect(cap1.status).toBe(200);
    expect((cap1.body as { ok: boolean; files: string[] }).ok).toBe(true);
    expect((cap1.body as { files: string[] }).files).toEqual([p]);

    // Re-add the same file → already, no duplicate.
    const { res: res2, capture: cap2 } = makeRes();
    await handleHookAdd(makeReq({ path: p }), res2);
    expect((cap2.body as { already: boolean }).already).toBe(true);
    expect((cap2.body as { files: string[] }).files).toEqual([p]);

    // Persisted to config.toml.
    expect(realStore.getByPath('hooks')).toEqual({ files: [p] });
  });

  it('rejects adding an invalid file (422) and does not write', async () => {
    const { res, capture } = makeRes();
    await handleHookAdd(makeReq({ path: join(tmpDir, 'missing.json') }), res);
    expect(capture.status).toBe(422);
    // Nothing was persisted (schema default is an empty files array).
    expect(realStore.getByPath('hooks')).toEqual({ files: [] });
  });

  it('removes a registered file', async () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, validHookJson(), 'utf-8');
    realStore.set('hooks', { files: [p] });
    const { res, capture } = makeRes();
    await handleHookRemove(makeReq({ path: p }), res);
    expect(capture.status).toBe(200);
    expect((capture.body as { removed: boolean }).removed).toBe(true);
    expect((capture.body as { files: string[] }).files).toEqual([]);
  });

  it('reports removed=false for an unregistered path', async () => {
    const { res, capture } = makeRes();
    await handleHookRemove(makeReq({ path: join(tmpDir, 'never.json') }), res);
    expect((capture.body as { removed: boolean }).removed).toBe(false);
  });
});

describe('path resolution', () => {
  it('expands ~ and resolves relative paths against the config root', async () => {
    // ~ expansion (write into the real home dir under a unique name).
    const homeFile = join(homedir(), 'duya-hook-test-tilde.json');
    writeFileSync(homeFile, validHookJson(), 'utf-8');
    try {
      const status = validateHookFile('~/duya-hook-test-tilde.json');
      expect(status.ok).toBe(true);
      expect(status.resolved).toBe(homeFile);
    } finally {
      rmSync(homeFile, { force: true });
    }
  });
});
