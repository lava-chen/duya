/**
 * Cloud STT engine — OpenAI-compatible `/v1/audio/transcriptions`.
 *
 * Optional track, aligned with grok's dual-track STT but NOT tied to any
 * xAI-specific API. Uses the provider config convergence: base_url + api key
 * come from the configured provider (single data source).
 */
import type { PcmChunk, SttResult, SttEngine } from '../types';
import { encodeWav } from './local';

export interface CloudSttEngineOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Minimum PCM samples before the first interim request. */
  interimMinSamples?: number;
  /** New PCM samples required between interim requests (default 1.5 s). */
  interimIntervalSamples?: number;
  /** Request timeout in ms (default 30 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

class CodedError extends Error {
  code?: string;
}

/** Minimal fetch wrapper so the engine works in both Node and the worker. */
function fetchLike(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export class CloudSttEngine implements SttEngine {
  readonly kind = 'cloud' as const;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private lastInterimSamples = 0;
  private readonly opts: CloudSttEngineOptions;
  private _ready = false;

  constructor(opts: CloudSttEngineOptions = {}) {
    this.opts = opts;
    this._ready = !!(opts.baseUrl && opts.apiKey);
  }

  get ready(): boolean {
    return this._ready;
  }

  async push(chunk: PcmChunk): Promise<SttResult | null> {
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
    const interimMin = this.opts.interimMinSamples ?? 16000;
    if (this.totalSamples < interimMin) return null;
    // Throttle: interim requests re-POST the whole buffer, so space them out.
    const interval = this.opts.interimIntervalSamples ?? 24000; // 1.5s
    if (this.lastInterimSamples > 0 && this.totalSamples - this.lastInterimSamples < interval) {
      return null;
    }
    return this.transcribe(false);
  }

  async finalize(): Promise<SttResult> {
    if (this.totalSamples === 0) return { done: true, text: '' };
    const result = await this.transcribe(true);
    this.reset();
    return result;
  }

  reset(): void {
    this.chunks = [];
    this.totalSamples = 0;
    this.lastInterimSamples = 0;
  }

  private async transcribe(final: boolean): Promise<SttResult> {
    if (!this._ready) {
      throw new Error('Cloud STT engine is not ready (base_url/api_key missing)');
    }
    const wav = encodeWav(this.chunks);
    const json = await postTranscription({
      baseUrl: this.opts.baseUrl!,
      apiKey: this.opts.apiKey!,
      model: this.opts.model ?? 'whisper-1',
      wav,
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.lastInterimSamples = this.totalSamples;
    const text = json.text ?? '';
    if (final) return { done: true, text: text.trim() };
    return { done: false, text: text.trim(), isFinal: false };
  }
}

/** POST a WAV buffer to an OpenAI-compatible transcriptions endpoint. */
async function postTranscription(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  wav: Buffer;
  timeoutMs: number;
  language?: string;
}): Promise<{ text?: string }> {
  const form = new FormData();
  form.append('file', new Blob([opts.wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', opts.model);
  if (opts.language) form.append('language', opts.language);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetchLike(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const failure = new CodedError(
      err instanceof Error && err.name === 'TimeoutError'
        ? `Cloud STT request timed out (${opts.timeoutMs}ms)`
        : `Cloud STT request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    failure.code = 'network';
    throw failure;
  }
  if (!res.ok) {
    const failure = new CodedError(await describeHttpFailure(res));
    if (res.status === 401 || res.status === 403) failure.code = 'permission_denied';
    else failure.code = 'network';
    throw failure;
  }
  return (await res.json()) as { text?: string };
}

async function describeHttpFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? '';
  } catch {
    /* non-JSON error body */
  }
  return `Cloud STT request failed (${res.status})${detail ? `: ${detail}` : ''}`;
}

export interface CloudTestResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

/**
 * Connectivity probe: transcribe 0.2 s of silence so users can verify the
 * provider / model / key combination from Settings before dictating.
 */
export async function testCloudTranscription(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<CloudTestResult> {
  const started = Date.now();
  const silence = new Int16Array(3200); // 0.2 s @ 16 kHz
  try {
    await postTranscription({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      wav: encodeWav([silence]),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
