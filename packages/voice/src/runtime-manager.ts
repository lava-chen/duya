/**
 * RuntimeManager — one-click provisioning of the local whisper.cpp runtime.
 *
 * Downloads the prebuilt whisper.cpp CLI from the project's GitHub releases
 * (`releases/latest/download/<asset>` needs no API call) into
 * `<userData>/voice/bin/`, extracts it (zip via extract-zip, tar.gz via a
 * minimal built-in untar), locates the CLI binary, and records a manifest so
 * environment detection resolves it without PATH. A custom `baseUrl`
 * supports mirrors for restricted networks. All work is pure Node — no
 * shell, no child processes.
 */
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Writable, Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_RUNTIME_BASE =
  'https://github.com/ggml-org/whisper.cpp/releases/latest/download';

/** Binary names recognized as a whisper.cpp CLI, in preference order. */
export const WHISPER_BINARY_NAMES = [
  'whisper-cli',
  'whisper-cli.exe',
  'whisper',
  'whisper.exe',
  'main',
  'main.exe',
];

export interface RuntimeAsset {
  name: string;
  url: string;
  format: 'zip' | 'tar.gz';
}

/** Resolve the prebuilt asset for the current platform, or null when the
 * upstream project ships no standalone CLI (e.g. macOS: use Homebrew). */
export function runtimeAssetForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  baseUrl: string = DEFAULT_RUNTIME_BASE,
): RuntimeAsset | null {
  const base = baseUrl.replace(/\/+$/, '');
  if (platform === 'win32' && arch === 'x64') {
    return { name: 'whisper-bin-x64.zip', url: `${base}/whisper-bin-x64.zip`, format: 'zip' };
  }
  if (platform === 'linux') {
    if (arch === 'x64') {
      return { name: 'whisper-bin-ubuntu-x64.tar.gz', url: `${base}/whisper-bin-ubuntu-x64.tar.gz`, format: 'tar.gz' };
    }
    if (arch === 'arm64') {
      return { name: 'whisper-bin-ubuntu-arm64.tar.gz', url: `${base}/whisper-bin-ubuntu-arm64.tar.gz`, format: 'tar.gz' };
    }
  }
  return null;
}

export interface RuntimeProgress {
  phase: 'downloading' | 'extracting' | 'locating' | 'done';
  receivedBytes?: number;
  totalBytes?: number;
}

export interface RuntimeStatus {
  /** A managed binary is installed and present on disk. */
  ready: boolean;
  /** Absolute path to the managed CLI binary, when ready. */
  path?: string;
  /** One-click install is supported on this platform. */
  installable: boolean;
  /** Guidance when not installable (macOS → Homebrew). */
  message?: string;
}

interface RuntimeManifest {
  binaryPath: string; // relative to binDir
  asset: string;
  installedAt: string;
}

export interface RuntimeManagerOptions {
  /** Target directory, e.g. `<userData>/voice/bin`. */
  binDir: string;
  /** Optional mirror / custom release-download base URL. */
  baseUrl?: string;
}

export class RuntimeManager {
  private readonly binDir: string;
  private readonly baseUrl: string;

  constructor(opts: RuntimeManagerOptions) {
    this.binDir = opts.binDir;
    this.baseUrl = opts.baseUrl?.trim() || DEFAULT_RUNTIME_BASE;
  }

  get manifestPath(): string {
    return join(this.binDir, 'runtime.json');
  }

  /** Current managed-runtime status (manifest first, then directory scan). */
  status(): RuntimeStatus {
    const asset = runtimeAssetForPlatform(process.platform, process.arch, this.baseUrl);
    const installable = asset !== null;
    const manifest = this.readManifest();
    if (manifest) {
      const p = join(this.binDir, manifest.binaryPath);
      if (existsSync(p)) {
        return { ready: true, path: p, installable };
      }
    }
    // Fallback: a binary placed manually in the managed dir.
    const found = this.scanForBinary(this.binDir, 1);
    if (found) return { ready: true, path: found, installable };
    return {
      ready: false,
      installable,
      message: installable
        ? undefined
        : 'macOS 无预编译包，请执行 brew install whisper-cpp，或在设置中配置二进制路径',
    };
  }

  /** Download + extract the prebuilt runtime. Progress is reported live. */
  async install(onProgress?: (p: RuntimeProgress) => void): Promise<RuntimeStatus> {
    const current = this.status();
    if (current.ready) return current;

    const asset = runtimeAssetForPlatform(process.platform, process.arch, this.baseUrl);
    if (!asset) {
      return {
        ready: false,
        installable: false,
        message: '当前平台不支持一键下载：macOS 请执行 brew install whisper-cpp，或手动配置二进制路径',
      };
    }

    const workDir = join(this.binDir, '.download');
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const archivePath = join(workDir, asset.name);
    const extractDir = join(workDir, 'extracted');
    try {
      onProgress?.({ phase: 'downloading', receivedBytes: 0, totalBytes: 0 });
      await this.download(asset.url, archivePath, onProgress);

      onProgress?.({ phase: 'extracting' });
      mkdirSync(extractDir, { recursive: true });
      if (asset.format === 'zip') {
        const { default: extractZip } = await import('extract-zip');
        await extractZip(archivePath, { dir: extractDir });
      } else {
        await extractTarGz(archivePath, extractDir);
      }

      onProgress?.({ phase: 'locating' });
      const binary = this.scanForBinary(extractDir, 4);
      if (!binary) {
        return {
          ready: false,
          installable: true,
          message: '下载包中未找到 whisper-cli 可执行文件',
        };
      }
      const rel = relative(this.binDir, binary);
      const manifest: RuntimeManifest = {
        binaryPath: rel,
        asset: asset.name,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      if (process.platform !== 'win32') {
        try {
          chmodSync(binary, 0o755);
        } catch {
          // Permissions are best-effort; some filesystems reject chmod.
        }
      }
      onProgress?.({ phase: 'done' });
      return { ready: true, path: binary, installable: true };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private readManifest(): RuntimeManifest | null {
    try {
      const raw = readFileSync(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as RuntimeManifest;
      if (parsed && typeof parsed.binaryPath === 'string') return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** Find a known CLI binary name under `dir` (bounded depth). */
  private scanForBinary(dir: string, maxDepth: number): string | undefined {
    if (!existsSync(dir) || maxDepth < 0) return undefined;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    // Prefer exact name order at this level before descending.
    for (const name of WHISPER_BINARY_NAMES) {
      const p = join(dir, name);
      if (this.isFile(p)) return p;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const p = join(dir, entry);
      if (this.isDirectory(p)) {
        const found = this.scanForBinary(p, maxDepth - 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  private isFile(p: string): boolean {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  }

  private isDirectory(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private async download(
    url: string,
    target: string,
    onProgress?: (p: RuntimeProgress) => void,
  ): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`Runtime download failed (${res.status})`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    const body = Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
    let received = 0;
    let lastReport = 0;
    body.on('data', (c: Buffer) => {
      received += c.length;
      if (received - lastReport >= 256 * 1024) {
        lastReport = received;
        onProgress?.({ phase: 'downloading', receivedBytes: received, totalBytes: total });
      }
    });
    await pipeline(body, createWriteStream(target));
    onProgress?.({ phase: 'downloading', receivedBytes: received, totalBytes: total });
  }
}

/**
 * Minimal tar extractor for the ubuntu prebuilt tarballs. Handles regular
 * files, directories, and relative symlinks (vendored .so link chains);
 * ignores everything else (hardlinks, pax headers, etc.).
 */
export async function extractTarGz(archivePath: string, outDir: string): Promise<void> {
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    new TarExtractor(outDir),
  );
}

const BLOCK = 512;

class TarExtractor extends Writable {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly outDir: string) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
      cb();
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < BLOCK) return;
      const header = this.buffer.subarray(0, BLOCK);
      const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*| /g, ''), 8) || 0;
      const type = String.fromCharCode(header[156]);
      const name = header.toString('utf8', 0, 100).replace(/\0+$/, '');
      const linkname = header.toString('utf8', 157, 257).replace(/\0+$/, '');
      const contentBlocks = Math.ceil(size / BLOCK);
      const totalLen = BLOCK + contentBlocks * BLOCK;
      if (type === '\0' && name === '') return; // end-of-archive marker
      if (this.buffer.length < totalLen) return; // wait for full entry

      const content = this.buffer.subarray(BLOCK, BLOCK + size);
      this.buffer = this.buffer.subarray(totalLen);
      if (!name || name === './') continue;
      const target = join(this.outDir, name.replace(/^\.\//, ''));
      if (type === '5') {
        mkdirSync(target, { recursive: true });
      } else if (type === '2') {
        try {
          symlinkSync(linkname, target);
        } catch {
          // Symlinks may be unsupported (e.g. Windows without privileges).
        }
      } else if (type === '0' || type === '\0') {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      // Other entry types (pax 'x', hardlink '1', …) are skipped.
    }
  }
}
