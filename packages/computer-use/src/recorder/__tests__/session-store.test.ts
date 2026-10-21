/**
 * session-store.test.ts — plan 556 Phase 0 Gate: disk persistence
 * + crash-tolerant reads.
 *
 * Coverage:
 *   - start() creates the directory + writes session.json with zero
 *     events.
 *   - append() serializes through the internal queue and writes
 *     lines in arrival order to events.jsonl.
 *   - append() redacts password fields before they hit disk
 *     (defence-in-depth with the privacy module).
 *   - end() stamps endedAt and reflects the final event count.
 *   - loadSession() returns metadata + events in file order, and
 *     surfaces dropped lines instead of throwing on a truncated
 *     final line.
 *   - listSessions() enumerates newest-first; deleteSession() wipes
 *     the directory.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SessionStore,
  deleteSession,
  getDefaultRecorderRootDir,
  listSessions,
  loadSession,
} from '../session-store.js';
import type { RecorderEvent } from '../events.js';

const APP = { name: 'Google Chrome', title: 'Example', processName: 'chrome', pid: 1 };
const NOTEPAD = { name: '记事本', title: 'Untitled', processName: 'notepad', pid: 2 };

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-recorder-'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function clickOver(target: AppRef | typeof APP, x = 10, y = 20): RecorderEvent {
  return {
    type: 'click',
    ts: 1000,
    app: target,
    click: { x, y, button: 'left', count: 1 },
    element: { source: 'uia-probe', controlType: 'Button', name: '提交' },
  };
}

describe('SessionStore — write path', () => {
  it('creates the session directory and writes session.json on start', async () => {
    const store = new SessionStore(rootDir, 'abc-123', 1700000000000);
    await store.start();
    const sessionFile = path.join(rootDir, 'sessions', 'abc-123', 'session.json');
    const raw = await fs.readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.sessionId).toBe('abc-123');
    expect(parsed.startedAt).toBe(1700000000000);
    expect(parsed.eventCount).toBe(0);
    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.apps).toEqual([]);
  });

  it('appends events in arrival order', async () => {
    const store = new SessionStore(rootDir, 'order');
    await store.start();
    await store.append({ type: 'app_focus', ts: 1, app: APP });
    await store.append(clickOver(NOTEPAD));
    await store.append({ type: 'key', ts: 3, app: NOTEPAD, key: 'enter', modifiers: [] });

    const raw = await fs.readFile(
      path.join(rootDir, 'sessions', 'order', 'events.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const types = lines.map((l) => (JSON.parse(l) as RecorderEvent).type);
    expect(types).toEqual(['app_focus', 'click', 'key']);
  });

  it('redacts password fields before they hit disk', async () => {
    const store = new SessionStore(rootDir, 'redact');
    await store.start();
    await store.append({
      type: 'type',
      ts: 1,
      app: APP,
      text: 'supersecretvalue',
      element: { source: 'uia-probe', controlType: 'Edit', isPassword: true },
    });
    const raw = await fs.readFile(
      path.join(rootDir, 'sessions', 'redact', 'events.jsonl'),
      'utf8',
    );
    expect(raw).toContain('<redacted>');
    expect(raw).not.toContain('supersecretvalue');
  });

  it('updates session.json eventCount + appSummary as events flow', async () => {
    const store = new SessionStore(rootDir, 'counts');
    await store.start();
    await store.append({ type: 'app_focus', ts: 1, app: APP });
    await store.append(clickOver(APP));
    await store.append(clickOver(NOTEPAD));
    const summary = await store.end();
    expect(summary.endedAt).toBeTypeOf('number');
    expect(summary.eventCount).toBe(3);
    // Two distinct apps, with hit counts.
    const apps = Object.fromEntries(summary.apps.map((a) => [a.processName, a.hits]));
    expect(apps.chrome).toBe(2);
    expect(apps.notepad).toBe(1);
  });

  it('rejects append after end()', async () => {
    const store = new SessionStore(rootDir, 'closed');
    await store.start();
    await store.end();
    await expect(store.append(clickOver(APP))).rejects.toThrow(/closed/);
  });
});

describe('SessionStore — read path', () => {
  it('round-trips metadata + events through loadSession', async () => {
    const store = new SessionStore(rootDir, 'rt');
    await store.start();
    await store.append({ type: 'app_focus', ts: 1, app: APP });
    await store.append(clickOver(NOTEPAD, 50, 60));
    await store.end();

    const loaded = await loadSession(rootDir, 'rt');
    expect(loaded.summary.sessionId).toBe('rt');
    expect(loaded.summary.eventCount).toBe(2);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.events).toHaveLength(2);
    expect(loaded.events[1].type).toBe('click');
    if (loaded.events[1].type === 'click') {
      expect(loaded.events[1].click.x).toBe(50);
      expect(loaded.events[1].click.y).toBe(60);
    }
  });

  it('drops a truncated final line without throwing', async () => {
    const sessionDir = path.join(rootDir, 'sessions', 'trunc');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({
        sessionId: 'trunc',
        startedAt: 1,
        eventCount: 2,
        apps: [{ processName: 'chrome', name: 'Google Chrome', hits: 2 }],
      }),
      'utf8',
    );
    const good = JSON.stringify({
      type: 'click',
      ts: 1,
      app: APP,
      click: { x: 0, y: 0, button: 'left', count: 1 },
      element: { source: 'none' },
    });
    // Two valid lines + a half-written third (typical kill -9 victim).
    const payload = `${good}\n${good}\n{"type":"click","ts":2,"app":{"name":"x","ti`;
    await fs.writeFile(path.join(sessionDir, 'events.jsonl'), payload, 'utf8');

    const loaded = await loadSession(rootDir, 'trunc');
    expect(loaded.events).toHaveLength(2);
    expect(loaded.dropped).toHaveLength(1);
    expect(loaded.dropped[0].line).toBe(3);
    expect(loaded.dropped[0].reason).toMatch(/^json:/);
  });

  it('returns empty events when events.jsonl is missing but session.json exists', async () => {
    const sessionDir = path.join(rootDir, 'sessions', 'no-events');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ sessionId: 'no-events', startedAt: 1, eventCount: 0, apps: [] }),
      'utf8',
    );
    const loaded = await loadSession(rootDir, 'no-events');
    expect(loaded.events).toEqual([]);
    expect(loaded.dropped).toEqual([]);
  });
});

describe('listSessions / deleteSession', () => {
  it('lists every session, newest first', async () => {
    const older = new SessionStore(rootDir, 'older', 1000);
    await older.start();
    await older.end();
    const newer = new SessionStore(rootDir, 'newer', 2000);
    await newer.start();
    await newer.end();

    const sessions = await listSessions(rootDir);
    expect(sessions.map((s) => s.sessionId)).toEqual(['newer', 'older']);
  });

  it('returns an empty list when the root does not exist', async () => {
    const empty = await listSessions(path.join(rootDir, 'never-created'));
    expect(empty).toEqual([]);
  });

  it('deleteSession removes the directory', async () => {
    const store = new SessionStore(rootDir, 'gone');
    await store.start();
    await store.end();
    await deleteSession(rootDir, 'gone');
    const after = await listSessions(rootDir);
    expect(after).toEqual([]);
  });
});

describe('getDefaultRecorderRootDir', () => {
  it('returns ~/.duya/recorder', () => {
    const dir = getDefaultRecorderRootDir();
    expect(dir).toBe(path.join(os.homedir(), '.duya', 'recorder'));
  });
});