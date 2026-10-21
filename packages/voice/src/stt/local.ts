/**
 * Local whisper.cpp engine — manages the machine's whisper environment and
 * runs streaming transcription over a PCM buffer.
 *
 * Whisper is a whole-utterance model, so "streaming" here follows grok's
 * approach: accumulate incoming 16 kHz mono PCM into a buffer, and on each
 * push run a transcribe over the current window to yield an interim result;
 * `finalize()` runs a final transcribe over the full buffer.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PcmChunk, SttResult, SttEngine } from '../types';

export interface LocalWhisperEngineOptions {
  /** Path to the whisper-cli binary (auto-detected if empty). */
  binaryPath?: string;
  /** Path to the ggml model file. */
  modelPath?: string;
  language?: string;
  /** Minimum PCM samples before running the first interim transcribe. */
  interimMinSamples?: number;
  /** New PCM samples required between interim transcribes (default 1.5 s). */
  interimIntervalSamples?: number;
}

const WAV_HEADER_BYTES = 44;

export class LocalWhisperEngine implements SttEngine {
  readonly kind = 'local' as const;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private lastInterimSamples = 0;
  private inFlight = false;
  /** Serializes whisper-cli runs (interims never overlap the finalize pass). */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly opts: LocalWhisperEngineOptions;
  private _ready = false;

  constructor(opts: LocalWhisperEngineOptions = {}) {
    this.opts = opts;
    this._ready = !!opts.binaryPath && !!opts.modelPath;
  }

  get ready(): boolean {
    return this._ready;
  }

  async push(chunk: PcmChunk): Promise<SttResult | null> {
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
    const interimMin = this.opts.interimMinSamples ?? 16000; // 1s
    if (this.totalSamples < interimMin) return null;
    // Throttle: only re-transcribe after enough NEW audio arrived, and never
    // stack on a running whisper-cli process.
    const interval = this.opts.interimIntervalSamples ?? 24000; // 1.5s
    if (this.lastInterimSamples > 0 && this.totalSamples - this.lastInterimSamples < interval) {
      return null;
    }
    if (this.inFlight) return null;
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

  private transcribe(final: boolean): Promise<SttResult> {
    const run = this.chain.then(() => this.doTranscribe(final));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doTranscribe(final: boolean): Promise<SttResult> {
    if (!this._ready) {
      throw new Error('Local whisper engine is not ready (binary/model missing)');
    }
    this.inFlight = true;
    try {
      const wavPath = this.writeWav();
      try {
        const text = await this.runWhisper(wavPath);
        this.lastInterimSamples = this.totalSamples;
        if (final) return { done: true, text: text.trim() };
        return { done: false, text: text.trim(), isFinal: false };
      } finally {
        try {
          unlinkSync(wavPath);
        } catch {
          /* temp cleanup best-effort */
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private writeWav(): string {
    const path = join(tmpdir(), `duya-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(path, encodeWav(this.chunks));
    return path;
  }

  private runWhisper(wavPath: string): Promise<string> {
    const bin = this.opts.binaryPath!;
    // No -otxt: the transcript goes to stdout and temp .txt files are not
    // orphaned next to the wav.
    const args = ['-m', this.opts.modelPath!, '-f', wavPath, '-np', '-nt'];
    const lang = this.opts.language?.trim();
    if (lang) args.push('-l', lang);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

/** Encode mono 16-bit 16 kHz PCM sample chunks as a WAV file buffer. */
export function encodeWav(chunks: Int16Array[]): Buffer {
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + n * 2);
  const sampleRate = 16000;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let off = WAV_HEADER_BYTES;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-32768, Math.min(32767, c[i]));
      buf.writeInt16LE(s, off);
      off += 2;
    }
  }
  return buf;
}