/**
 * Model manager — download, verify (SHA256), cache, and version ggml models
 * into `~/.duya/voice/models/`.
 *
 * Catalog covers the full whisper.cpp ggml lineup (multilingual + English
 *-only + large + turbo + q5 quantized). Downloads default to the canonical
 * ggerganov/whisper.cpp HF source and accept a mirror base URL for
 * restricted networks (e.g. https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
  statSync,
  renameSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { ModelStatusDTO } from './types';

/** Canonical model source (ggerganov/whisper.cpp, HF). */
export const DEFAULT_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Known model files (approx MB) for display, in picker order. */
export const MODEL_CATALOG: Array<{ model: string; sizeMb: number; note?: string }> = [
  { model: 'ggml-tiny.bin', sizeMb: 75, note: '最快' },
  { model: 'ggml-tiny.en.bin', sizeMb: 75, note: '英文' },
  { model: 'ggml-base.bin', sizeMb: 142, note: '默认' },
  { model: 'ggml-base.en.bin', sizeMb: 142, note: '英文' },
  { model: 'ggml-small.bin', sizeMb: 466, note: '更准' },
  { model: 'ggml-small.en.bin', sizeMb: 466, note: '英文' },
  { model: 'ggml-medium.bin', sizeMb: 1536 },
  { model: 'ggml-medium.en.bin', sizeMb: 1536, note: '英文' },
  { model: 'ggml-large-v2.bin', sizeMb: 2930 },
  { model: 'ggml-large-v3.bin', sizeMb: 2930 },
  { model: 'ggml-large-v3-turbo.bin', sizeMb: 1536, note: '推荐：大模型速度' },
  { model: 'ggml-large-v3-turbo-q5_0.bin', sizeMb: 574, note: '推荐：量化' },
];

const MODEL_SIZES_MB: Record<string, number> = Object.fromEntries(
  MODEL_CATALOG.map((m) => [m.model, m.sizeMb]),
);

export interface ModelManagerOptions {
  /** Root directory for models (default `<userData>/voice/models`). */
  rootDir: string;
  /** Optional pre-seeded model file copied into the root on first use. */
  bundledModelPath?: string;
  /** Mirror / custom download base URL. */
  baseUrl?: string;
}

export interface ModelDownloadProgress {
  model: string;
  receivedBytes: number;
  totalBytes: number;
}

export class ModelManager {
  private readonly rootDir: string;
  private readonly bundledModelPath?: string;
  private readonly baseUrl: string;

  constructor(opts: ModelManagerOptions) {
    this.rootDir = opts.rootDir;
    this.bundledModelPath = opts.bundledModelPath;
    this.baseUrl = opts.baseUrl?.trim() || DEFAULT_MODEL_BASE_URL;
    mkdirSync(this.rootDir, { recursive: true });
  }

  private pathFor(model: string): string {
    return join(this.rootDir, model);
  }

  /** Verify a model is present and ready. Seeds the bundled base if available. */
  status(model: string): ModelStatusDTO {
    const p = this.pathFor(model);
    if (!existsSync(p)) {
      this.seedBundled(p);
    }
    if (!existsSync(p)) {
      return { model, ready: false, sizeMb: MODEL_SIZES_MB[model] ?? 0, path: p };
    }
    return { model, ready: true, sizeMb: this.sizeMb(p), path: p };
  }

  /** List the known model sizes with their local readiness/size. */
  listModels(): ModelStatusDTO[] {
    return MODEL_CATALOG.map((m) => this.status(m.model));
  }

  /** Download a model from the canonical source with optional SHA256 verification. */
  async ensure(
    model: string,
    sha256?: string,
    onProgress?: (p: ModelDownloadProgress) => void,
  ): Promise<ModelStatusDTO> {
    const target = this.pathFor(model);
    if (existsSync(target)) {
      return { model, ready: true, sizeMb: this.sizeMb(target), path: target };
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/${model}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000), redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`Model download failed (${res.status}) for ${model}`);
    }
    const part = `${target}.part`;
    const total = Number(res.headers.get('content-length') ?? 0);
    const body = Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
    let received = 0;
    let lastReport = 0;
    body.on('data', (c: Buffer) => {
      received += c.length;
      if (received - lastReport >= 512 * 1024) {
        lastReport = received;
        onProgress?.({ model, receivedBytes: received, totalBytes: total });
      }
    });
    await pipeline(body, createWriteStream(part));
    onProgress?.({ model, receivedBytes: received, totalBytes: total });
    if (sha256) {
      await this.verifySha256(part, sha256);
    }
    renameSync(part, target);
    return { model, ready: true, sizeMb: this.sizeMb(target), path: target };
  }

  /** Remove a downloaded model (best-effort). */
  remove(model: string): void {
    rmSync(this.pathFor(model), { force: true });
    rmSync(`${this.pathFor(model)}.part`, { force: true });
  }

  private seedBundled(target: string): void {
    if (!this.bundledModelPath || !existsSync(this.bundledModelPath)) return;
    copyFileSync(this.bundledModelPath, target);
  }

  private verifySha256(path: string, expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => {
        if (hash.digest('hex') === expected) resolve();
        else reject(new Error(`SHA256 mismatch for ${path}`));
      });
      stream.on('error', reject);
    });
  }

  private sizeMb(p: string): number {
    try {
      return Math.round(statSync(p).size / 1024 / 1024);
    } catch {
      return MODEL_SIZES_MB[p.split(/[\\/]/).pop() ?? ''] ?? 0;
    }
  }
}
