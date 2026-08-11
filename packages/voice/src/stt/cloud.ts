/**
 * Cloud STT engine — OpenAI-compatible `/v1/audio/transcriptions`.
 *
 * Optional track, aligned with grok's dual-track STT but NOT tied to any
 * xAI-specific API. Uses the provider config convergence: base_url + api key
 * come from the configured provider (single data source).
 */
import type { PcmChunk, SttResult, SttEngine } from '../types';

export interface CloudSttEngineOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Minimum PCM samples before running an interim request. */
  interimMinSamples?: number;
}

/** Minimal fetch wrapper so the engine works in both Node and the worker. */
function fetchLike(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export class CloudSttEngine implements SttEngine {
  readonly kind = 'cloud' as const;
  private buffer: number[] = [];
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
    this.buffer.push(...chunk);
    const interimMin = this.opts.interimMinSamples ?? 16000;
    if (this.buffer.length < interimMin) return null;
    return this.transcribe(false);
  }

  async finalize(): Promise<SttResult> {
    if (this.buffer.length === 0) return { done: true, text: '' };
    const result = await this.transcribe(true);
    this.reset();
    return result;
  }

  reset(): void {
    this.buffer = [];
  }

  private async transcribe(final: boolean): Promise<SttResult> {
    if (!this._ready) {
      throw new Error('Cloud STT engine is not ready (base_url/api_key missing)');
    }
    const wav = encodeWavBlock(this.buffer);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.opts.model ?? 'whisper-1');
    const url = `${this.opts.baseUrl!.replace(/\/$/, '')}/audio/transcriptions`;
    const res = await fetchLike(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`Cloud STT auth failed (${res.status})`) as Error & { code?: string };
        err.code = 'permission_denied';
        throw err;
      }
      throw new Error(`Cloud STT request failed (${res.status})`);
    }
    const json = (await res.json()) as { text?: string };
    const text = json.text ?? '';
    if (final) return { done: true, text: text.trim() };
    return { done: false, text: text.trim(), isFinal: false };
  }
}

/** Encode an Int16 PCM block as a WAV buffer (16 kHz mono). */
function encodeWavBlock(samples: number[]): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 16000 * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, samples[i])), true);
  }
  return buf;
}