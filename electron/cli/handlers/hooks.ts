/**
 * electron/cli/handlers/hooks.ts
 *
 * CLI API handlers for `duya hook list / validate / add / remove` —
 * managing the `[hooks] files` array of `~/.duya/config.toml` without
 * hand-editing the config.
 *
 * The config only records hook.json paths; the hook content lives in the
 * JSON files (ecosystem shape shared with Claude Code / ZCode — a top-level
 * `hooks` object mapping event → matcher groups → hook commands).
 *
 * - `list`    (read-only): the configured files + per-file parse status.
 * - `validate` (read-only): check one hook.json path is readable and has a
 *   well-formed `hooks` object (strict schema validation stays in the
 *   agent process — `HooksSettingsSchema`).
 * - `add`     (write): validate + append the path to `[hooks] files`
 *   (deduped by resolved path).
 * - `remove`  (write): drop the path from `[hooks] files`.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfigStore } from '../../config/store-instance';
import { resolveConfigTomlPath } from '../../config';

// ---------------------------------------------------------------------------
// JSON helpers (mirror voice.ts / config.ts conventions)
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          resolve(obj as Record<string, unknown>);
        } else {
          reject(new Error('request body must be a JSON object'));
        }
      } catch (err) {
        reject(new Error(`malformed JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Hook file resolution + validation
// ---------------------------------------------------------------------------

export interface HookFileStatus {
  /** Path exactly as recorded in `[hooks] files`. */
  path: string;
  /** Resolved absolute path (`~` expanded, relative → config root). */
  resolved: string;
  ok: boolean;
  error?: string;
  /** Events declared in the file (when parseable). */
  events?: string[];
  /** Total hook count across all matchers (when parseable). */
  hookCount?: number;
}

/**
 * Expand `~` and resolve a hook.json path the same way the agent does
 * (config.ts resolveHookFilePath): relative paths anchor at the config
 * root (`~/.duya`).
 */
export function resolveHookFilePath(rawPath: string, baseDir: string): string {
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

function configRootDir(): string {
  return path.dirname(resolveConfigTomlPath());
}

/**
 * Validate one hook.json file: exists, parses as JSON, and has a
 * well-formed `hooks` object (event → array of matcher groups, each with a
 * `hooks` array of command objects). Lightweight shape check only — the
 * strict schema validation lives in the agent (`HooksSettingsSchema`).
 */
export function validateHookFile(rawPath: string): HookFileStatus {
  const resolved = resolveHookFilePath(rawPath, configRootDir());
  const status: HookFileStatus = { path: rawPath, resolved, ok: false };
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch {
    status.error = `file not readable: ${resolved}`;
    return status;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    status.error = `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    return status;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    status.error = 'must be a JSON object';
    return status;
  }
  const hooks = (doc as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    status.error = 'missing "hooks" object (expect { "hooks": { Event: [{ matcher?, hooks: [...] }] } })';
    return status;
  }
  const events: string[] = [];
  let hookCount = 0;
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) {
      status.error = `event "${event}" must be an array of matcher groups`;
      return status;
    }
    for (const matcherRaw of matchers) {
      if (matcherRaw === null || typeof matcherRaw !== 'object' || Array.isArray(matcherRaw)) {
        status.error = `event "${event}": matcher group must be an object`;
        return status;
      }
      const matcher = matcherRaw as { matcher?: unknown; hooks?: unknown };
      if (matcher.matcher !== undefined && typeof matcher.matcher !== 'string') {
        status.error = `event "${event}": matcher must be a string`;
        return status;
      }
      if (!Array.isArray(matcher.hooks)) {
        status.error = `event "${event}": matcher group must have a "hooks" array`;
        return status;
      }
      for (const hook of matcher.hooks) {
        if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) {
          status.error = `event "${event}": hook must be an object`;
          return status;
        }
        hookCount++;
      }
    }
    events.push(event);
  }
  status.ok = true;
  status.events = events;
  status.hookCount = hookCount;
  return status;
}

// ---------------------------------------------------------------------------
// Config store helpers
// ---------------------------------------------------------------------------

/**
 * Current `[hooks]` section from the config snapshot — `files` plus any
 * `disabled` id list written by the Settings → Hooks toggles.
 */
function currentHooksSection(): { files: string[]; disabled: string[] } {
  const hooks = getConfigStore().getByPath('hooks') as
    | { files?: unknown; disabled?: unknown }
    | null
    | undefined;
  const files = Array.isArray(hooks?.files)
    ? (hooks.files as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  const disabled = Array.isArray(hooks?.disabled)
    ? (hooks.disabled as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  return { files, disabled };
}

function currentHookFiles(): string[] {
  return currentHooksSection().files;
}

/** Persist `files` while preserving the `disabled` id list. */
function persistHookFiles(files: string[]): void {
  const { disabled } = currentHooksSection();
  getConfigStore().set('hooks', { files, disabled });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /v1/hooks/list — configured hook files + per-file parse status. */
export function handleHookList(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const files = currentHookFiles().map((f) => validateHookFile(f));
    sendJson(res, 200, {
      ok: true,
      configPath: resolveConfigTomlPath(),
      files,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /v1/hooks/validate — check one hook.json without writing. */
export async function handleHookValidate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      sendJson(res, 400, { ok: false, error: 'path is required' });
      return;
    }
    const status = validateHookFile(rawPath);
    sendJson(res, status.ok ? 200 : 422, { ok: status.ok, ...status });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /v1/hooks/add — validate and append a hook.json path. */
export async function handleHookAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      sendJson(res, 400, { ok: false, error: 'path is required' });
      return;
    }
    const status = validateHookFile(rawPath);
    if (!status.ok) {
      sendJson(res, 422, { ok: false, error: status.error ?? 'invalid hook file' });
      return;
    }
    const files = currentHookFiles();
    const already = files.some((f) => resolveHookFilePath(f, configRootDir()) === status.resolved);
    if (already) {
      sendJson(res, 200, { ok: true, already: true, files, added: rawPath });
      return;
    }
    const next = [...files, rawPath];
    persistHookFiles(next);
    sendJson(res, 200, { ok: true, already: false, files: next, added: rawPath });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /v1/hooks/remove — drop a hook.json path from `[hooks] files`. */
export async function handleHookRemove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      sendJson(res, 400, { ok: false, error: 'path is required' });
      return;
    }
    const files = currentHookFiles();
    const resolvedTarget = resolveHookFilePath(rawPath, configRootDir());
    const next = files.filter((f) => resolveHookFilePath(f, configRootDir()) !== resolvedTarget);
    if (next.length === files.length) {
      sendJson(res, 200, { ok: true, removed: false, files });
      return;
    }
    persistHookFiles(next);
    sendJson(res, 200, { ok: true, removed: true, files: next });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
