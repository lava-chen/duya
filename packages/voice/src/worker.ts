/**
 * STT worker subprocess entry.
 *
 * Spawned by the Electron Main process via `node` to isolate whisper.cpp's
 * native ABI from Electron (avoiding the better-sqlite3 NODE_MODULE_VERSION
 * conflict). Communicates with Main over stdio JSON lines.
 */
import { createSttEngine } from './stt/engine';
import type { SttEngine } from './types';

interface WorkerRequest {
  type: 'init' | 'push' | 'finalize' | 'reset' | 'dispose';
  payload?: {
    kind?: 'local' | 'cloud';
    binaryPath?: string;
    modelPath?: string;
    language?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    chunk?: { buffer: ArrayBuffer };
  };
}

type WorkerResponse =
  | { ok: true; kind: 'ready' }
  | { ok: true; kind: 'init_result'; ready: boolean }
  | { ok: true; kind: 'interim' | 'final'; text: string }
  | { ok: true; kind: 'resumed' }
  | { ok: true; kind: 'disposed' }
  | { ok: false; kind: 'error'; message: string; code?: string };

let engine: SttEngine | null = null;

const stdoutWrite = (msg: WorkerResponse) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function handle(raw: string): void {
  let req: WorkerRequest;
  try {
    req = JSON.parse(raw) as WorkerRequest;
  } catch {
    stdoutWrite({ ok: false, kind: 'error', message: 'malformed request' });
    return;
  }

  switch (req.type) {
    case 'init': {
      const p = req.payload ?? {};
      try {
        engine = createSttEngine({
          kind: p.kind ?? 'local',
          local: { binaryPath: p.binaryPath, modelPath: p.modelPath, language: p.language },
          cloud: { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model },
        });
        stdoutWrite({ ok: true, kind: 'init_result', ready: engine.ready });
      } catch (err) {
        stdoutWrite({ ok: false, kind: 'error', message: errMessage(err) });
      }
      break;
    }
    case 'push': {
      const eng = engine;
      if (!eng) return;
      const chunk = new Int16Array(req.payload?.chunk?.buffer ?? new ArrayBuffer(0));
      eng.push(chunk)
        .then((r) => {
          if (r && !r.done) stdoutWrite({ ok: true, kind: 'interim', text: r.text });
        })
        .catch((err) => stdoutWrite({ ok: false, kind: 'error', message: errMessage(err) }));
      break;
    }
    case 'finalize': {
      const eng = engine;
      if (!eng) return;
      eng.finalize()
        .then((r) => {
          if (r.done) stdoutWrite({ ok: true, kind: 'final', text: r.text });
        })
        .catch((err) => stdoutWrite({ ok: false, kind: 'error', message: errMessage(err) }));
      break;
    }
    case 'reset': {
      engine?.reset();
      stdoutWrite({ ok: true, kind: 'resumed' });
      break;
    }
    case 'dispose': {
      engine = null;
      stdoutWrite({ ok: true, kind: 'disposed' });
      process.exit(0);
      break;
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk: string) => {
  pending += chunk;
  let idx: number;
  while ((idx = pending.indexOf('\n')) >= 0) {
    handle(pending.slice(0, idx));
    pending = pending.slice(idx + 1);
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});