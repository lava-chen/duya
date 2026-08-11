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
  /** Minimum PCM samples before running an interim transcribe (8 kHz-ish). */
  interimMinSamples?: number;
}

const WAV_HEADER_BYTES = 44;

export class LocalWhisperEngine implements SttEngine {
  readonly kind = 'local' as const;
  private buffer: number[] = [];
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
    this.buffer.push(...chunk);
    const interimMin = this.opts.interimMinSamples ?? 16000; // 1s
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
      throw new Error('Local whisper engine is not ready (binary/model missing)');
    }
    const wavPath = this.writeWav(this.buffer);
    try {
      const text = await this.runWhisper(wavPath);
      if (final) return { done: true, text: text.trim() };
      return { done: false, text: text.trim(), isFinal: false };
    } finally {
      try {
        unlinkSync(wavPath);
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }

  private writeWav(samples: number[]): string {
    const path = join(tmpdir(), `duya-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(path, encodeWav(samples));
    return path;
  }

  private runWhisper(wavPath: string): Promise<string> {
    const bin = this.opts.binaryPath!;
    const args = ['-m', this.opts.modelPath!, '-f', wavPath, '-otxt', '-np', '-nt'];
    if (this.opts.language) args.push('-l', this.opts.language);
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

/** Encode mono 16-bit 16 kHz PCM samples as a WAV file buffer. */
export function encodeWav(samples: number[]): Buffer {
  const n = samples.length;
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
  for (let i = 0; i < n; i++) {
    const s = Math.max(-32768, Math.min(32767, samples[i]));
    buf.writeInt16LE(s, WAV_HEADER_BYTES + i * 2);
  }
  return buf;
}