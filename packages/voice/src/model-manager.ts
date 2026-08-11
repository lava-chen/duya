/**
 * Model manager — download, verify (SHA256), cache, and version ggml models
 * into `~/.duya/voice/models/`.
 *
 * The `base` model may ship bundled with the package; `small+` are downloaded
 * on demand from the canonical whisper.cpp model source.
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
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ModelStatusDTO } from './types';

/** Canonical model source (ggerganov/whisper.cpp, HF mirror). */
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Known model sizes (approx MB) for display. */
const MODEL_SIZES_MB: Record<string, number> = {
  'ggml-tiny.bin': 75,
  'ggml-base.bin': 142,
  'ggml-small.bin': 466,
  'ggml-medium.bin': 1536,
};

export interface ModelManagerOptions {
  /** Root directory for models (default `<userData>/voice/models`). */
  rootDir: string;
  /** Optional pre-seeded model file copied into the root on first use. */
  bundledModelPath?: string;
}

export class ModelManager {
  private readonly rootDir: string;
  private readonly bundledModelPath?: string;

  constructor(opts: ModelManagerOptions) {
    this.rootDir = opts.rootDir;
    this.bundledModelPath = opts.bundledModelPath;
    mkdirSync(this.rootDir, { recursive: true });
  }

  private pathFor(model: string): string {
    return join(this.rootDir, model);
  }

  /** Verify a model is present and ready. Seeds the bundled base if available. */
  status(model: string): ModelStatusDTO {
    const p = this.pathFor(model);
    if (!existsSync(p)) {
      this.seedBundled(p, model);
    }
    if (!existsSync(p)) {
      return { model, ready: false, sizeMb: MODEL_SIZES_MB[model] ?? 0, path: p };
    }
    return { model, ready: true, sizeMb: this.sizeMb(p), path: p };
  }

  /** Download a model from the canonical source with optional SHA256 verification. */
  async ensure(model: string, sha256?: string): Promise<ModelStatusDTO> {
    const target = this.pathFor(model);
    if (existsSync(target)) {
      return { model, ready: true, sizeMb: this.sizeMb(target), path: target };
    }
    const url = `${MODEL_BASE_URL}/${model}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Model download failed (${res.status}) for ${model}`);
    }
    const part = `${target}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    if (sha256) {
      await this.verifySha256(part, sha256);
    }
    renameSync(part, target);
    return { model, ready: true, sizeMb: this.sizeMb(target), path: target };
  }

  private seedBundled(target: string, model: string): void {
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