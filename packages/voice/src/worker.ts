/**
 * STT worker subprocess entry.
 *
 * Spawned by the Electron Main process via `fork` to isolate whisper.cpp's
 * native ABI from Electron (avoiding the better-sqlite3 NODE_MODULE_VERSION
 * conflict). Communicates with Main over the fork IPC channel
 * (`process.on('message')` / `process.send`) with v8 advanced serialization,
 * so PCM chunks (Int16Array) are transferred natively — never through JSON,
 * which silently drops binary payloads. stdout/stderr remain available for
 * diagnostics logging.
 */
import { createSttEngine } from './stt/engine';
import type { SttEngine } from './types';

export interface WorkerInitPayload {
  kind?: 'local' | 'cloud';
  binaryPath?: string;
  modelPath?: string;
  language?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type WorkerRequest =
  | { type: 'init'; payload?: WorkerInitPayload }
  | { type: 'push'; payload?: { chunk?: Int16Array } }
  | { type: 'finalize' }
  | { type: 'reset' }
  | { type: 'dispose' };

export type WorkerResponse =
  | { ok: true; kind: 'init_result'; ready: boolean }
  | { ok: true; kind: 'interim' | 'final'; text: string }
  | { ok: true; kind: 'resumed' }
  | { ok: true; kind: 'disposed' }
  | { ok: false; kind: 'error'; message: string; code?: string };

let engine: SttEngine | null = null;

/**
 * Refusal for a `push` / `finalize` that arrives with no engine.
 *
 * `model_not_ready` is one of the codes the host's `normalizeErrorCode` keeps
 * (`no_speech`, `permission_denied`, `model_not_ready`, `network`, `internal`),
 * so the refusal survives normalization instead of degrading to `internal`.
 */
const NO_ENGINE_CODE = 'model_not_ready';
const NO_ENGINE_MESSAGE = 'STT worker received audio before init completed, or after dispose';

const reply = (msg: WorkerResponse): void => {
  if (!process.send) return;
  process.send(msg);
};

function handle(req: WorkerRequest): void {
  switch (req.type) {
    case 'init': {
      const p = req.payload ?? {};
      try {
        engine = createSttEngine({
          kind: p.kind ?? 'local',
          local: { binaryPath: p.binaryPath, modelPath: p.modelPath, language: p.language },
          cloud: { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model },
        });
        reply({ ok: true, kind: 'init_result', ready: engine.ready });
      } catch (err) {
        reply({ ok: false, kind: 'error', message: errMessage(err) });
      }
      break;
    }
    case 'push': {
      const eng = engine;
      if (!eng) {
        // Answered, not swallowed. A silent return here told the parent
        // nothing, so the audio was dropped with no trace of it anywhere.
        reply({ ok: false, kind: 'error', message: NO_ENGINE_MESSAGE, code: NO_ENGINE_CODE });
        return;
      }
      const chunk = req.payload?.chunk;
      if (!chunk || chunk.length === 0) return;
      eng.push(chunk)
        .then((r) => {
          if (r && !r.done) reply({ ok: true, kind: 'interim', text: r.text });
        })
        .catch((err) => reply({ ok: false, kind: 'error', message: errMessage(err), code: errCode(err) }));
      break;
    }
    case 'finalize': {
      const eng = engine;
      if (!eng) {
        // This is the branch that hung the recorder. `finalize` is the request
        // the host is waiting on for `voice:final`, and a silent return meant
        // neither `final` nor `error` ever came back, so the pending
        // transcription never settled. An explicit refusal reaches the parent's
        // `!resp.ok` path and surfaces as `voice:error`.
        reply({ ok: false, kind: 'error', message: NO_ENGINE_MESSAGE, code: NO_ENGINE_CODE });
        return;
      }
      eng.finalize()
        .then((r) => {
          if (r.done) reply({ ok: true, kind: 'final', text: r.text });
        })
        .catch((err) => reply({ ok: false, kind: 'error', message: errMessage(err), code: errCode(err) }));
      break;
    }
    case 'reset': {
      engine?.reset();
      reply({ ok: true, kind: 'resumed' });
      break;
    }
    case 'dispose': {
      engine = null;
      reply({ ok: true, kind: 'disposed' });
      process.exit(0);
      break;
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

process.on('message', (req: WorkerRequest) => {
  if (!req || typeof req !== 'object' || typeof req.type !== 'string') return;
  handle(req);
});

// Parent closed the IPC channel — exit promptly.
process.on('disconnect', () => {
  process.exit(0);
});
