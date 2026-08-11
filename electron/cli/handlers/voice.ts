/**
 * electron/cli/handlers/voice.ts
 *
 * CLI API handlers for `duya voice doctor` / `duya voice setup`.
 *
 * - `doctor` (read-only): reports the local whisper.cpp environment and
 *   the configured model's cache status without writing anything.
 * - `setup` (write): guides first-use configuration by ensuring the
 *   configured whisper model is downloaded + verified, and reports the
 *   whisper binary readiness so the user can finish provisioning.
 *
 * Both delegate to the @duya/voice package primitives (ModelManager,
 * collectEnvReport, resolveVoiceConfig) — no business logic is
 * implemented here.
 */

import * as http from 'http';
import {
  collectEnvReport,
  ModelManager,
  resolveVoiceConfig,
  modelRoot,
} from '@duya/voice';
import { getConfigStore } from '../../config/store-instance';
import { resolveConfigRoot } from '../../config/compass';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read and parse a JSON object request body. */
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
    req.on('error', reject);
  });
}

/** Resolve the resolved voice config + the model cache root. */
function resolveVoiceContext(): { model: string; root: string } {
  const cfg = resolveVoiceConfig(
    getConfigStore().getByPath('voice') as Parameters<typeof resolveVoiceConfig>[0],
  );
  const root = modelRoot(resolveConfigRoot());
  return { model: cfg.model, root };
}

/** GET /v1/voice/env — read-only whisper environment + model status. */
export function handleVoiceEnvDoctor(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const { model, root } = resolveVoiceContext();
    const mgr = new ModelManager({ rootDir: root });
    const modelStatus = mgr.status(model);
    const env = collectEnvReport();
    sendJson(res, 200, {
      ok: true,
      platform: env.platform,
      binaryFound: env.binaryFound,
      binaryPath: env.binaryPath,
      model,
      modelReady: modelStatus.ready,
      modelSizeMb: modelStatus.sizeMb,
      installSteps: env.installSteps,
      summary: env.summary,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /v1/voice/setup — ensure the configured model is downloaded + verified. */
export async function handleVoiceSetup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const { model, root } = resolveVoiceContext();
    const mgr = new ModelManager({ rootDir: root });
    const status = await mgr.ensure(model);
    const env = collectEnvReport();
    sendJson(res, 200, {
      ok: true,
      model: status.model,
      ready: true,
      sizeMb: status.sizeMb,
      binaryFound: env.binaryFound,
      binaryPath: env.binaryPath,
      installSteps: env.installSteps,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /v1/voice/config — write a value under the `[voice]` config section. */
export async function handleVoiceConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) {
      sendJson(res, 400, { ok: false, error: 'path is required (e.g. stt.engine)' });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
      sendJson(res, 400, { ok: false, error: 'value is required' });
      return;
    }
    getConfigStore().set(`voice.${path}`, body.value);
    sendJson(res, 200, { ok: true, path, value: body.value });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}