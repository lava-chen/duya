import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { createDocumentCache, DocumentCache } from './cache';
import { createParseRequest, processSidecarData } from './protocol';
import { RequestQueue, type PendingRequest } from './concurrency';
import type {
  ParseResult,
  Capabilities,
  SidecarMessage,
  CapabilityMessage,
  JsonRpcDoneResponse,
  JsonRpcErrorResponse,
} from './types';
import { MAX_FILE_SIZE, PARSE_TIMEOUT, MAX_CONCURRENT, SUPPORTED_EXTENSIONS } from './types';

export type { ParseResult, Capabilities } from './types';

const CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 3;

export class DocumentParserService {
  private process: ChildProcess | null = null;
  private capabilities: Capabilities | null = null;
  private cache: DocumentCache;
  private queue: RequestQueue;
  private buffer = '';
  private stderrBuffer = '';
  private isShuttingDown = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private logger = getLogger();
  private pendingTimeouts = new Map<number, NodeJS.Timeout>();

  constructor() {
    this.cache = createDocumentCache();
    this.queue = new RequestQueue({
      execute: (req) => this.dispatchRequest(req),
    });
  }

  getCapabilities(): Capabilities | null {
    return this.capabilities;
  }

  isReady(): boolean {
    return this.process !== null && this.capabilities !== null;
  }

  async start(): Promise<void> {
    await this.spawnSidecar();
    this.startCacheCleanup();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const t of this.pendingTimeouts.values()) {
      clearTimeout(t);
    }
    this.pendingTimeouts.clear();
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.queue.rejectAll(new Error('Document parser service shutting down'));
  }

  async parse(
    filePath: string,
    sessionId: string,
    onProgress?: (progress: number) => void,
  ): Promise<ParseResult> {
    this.validateFile(filePath);

    const fileHash = this.computeFileHash(filePath);
    const cached = this.cache.get(fileHash);
    if (cached) return cached;

    if (!this.isReady()) {
      throw new Error('Document parser not ready');
    }

    return new Promise<ParseResult>((resolve, reject) => {
      this.queue.enqueue({
        filePath,
        sessionId,
        resolve: (result) => {
          this.cache.set(result.fileHash, result);
          resolve(result);
        },
        reject,
        onProgress,
      });
    });
  }

  private validateFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds size limit (50MB)');
    }
    if (stat.size === 0) {
      throw new Error('File is empty');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported format: ${ext}`);
    }
  }

  private dispatchRequest(request: PendingRequest): void {
    const timeout = setTimeout(() => {
      this.pendingTimeouts.delete(request.id);
      this.queue.onComplete(request.id);
      request.reject(new Error(`Parse timeout (${PARSE_TIMEOUT / 1000}s)`));
    }, PARSE_TIMEOUT);

    this.pendingTimeouts.set(request.id, timeout);
    const rpcRequest = createParseRequest(request.id, request.filePath);
    this.sendToSidecar(JSON.stringify(rpcRequest), timeout);
  }

  private processQueue(): void {
    // Handled by RequestQueue internally via onComplete -> processQueue
  }

  private sendToSidecar(line: string, timeout?: NodeJS.Timeout): void {
    if (!this.process || !this.process.stdin) {
      if (timeout) clearTimeout(timeout);
      return;
    }
    try {
      this.process.stdin.write(line + '\n');
    } catch (err) {
      this.logger.error('Failed to write to sidecar stdin', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.DocumentParser);
      if (timeout) clearTimeout(timeout);
    }
  }

  private async spawnSidecar(): Promise<void> {
    const { cmd, args } = this.getSidecarPath();

    // In dev mode, verify Python is available; in packaged mode the exe is self-contained
    if (!app.isPackaged) {
      const pythonFound = await this.detectPython();
      if (!pythonFound) {
        this.logger.error('Python not found for document parser sidecar', new Error('No Python runtime detected'), undefined, LogComponent.DocumentParser);
        return;
      }
    }

    this.logger.info(`Starting document parser sidecar: ${cmd} ${args.join(' ')}`, undefined, LogComponent.DocumentParser);

    this.process = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    this.buffer = '';
    this.stderrBuffer = '';

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer = processSidecarData(data.toString('utf-8'), this.buffer, {
        onCapability: (msg) => this.handleCapability(msg),
        onResponse: (msg) => this.handleResponse(msg),
        onParseError: (raw) => this.logger.warn(`Failed to parse sidecar message: ${raw}`, undefined, LogComponent.DocumentParser),
        onLog: (msg, level) => level === 'warn' ? this.logger.warn(msg, undefined, LogComponent.DocumentParser) : this.logger.error(msg, new Error(msg), undefined, LogComponent.DocumentParser),
      });
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.stderrBuffer += data.toString('utf-8');
      this.logger.warn(`Sidecar stderr: ${data.toString('utf-8').trim()}`, undefined, LogComponent.DocumentParser);
    });

    this.process.on('exit', (code, signal) => {
      this.logger.warn(`Sidecar exited (code: ${code}, signal: ${signal})`, undefined, LogComponent.DocumentParser);
      this.process = null;
      if (!this.isShuttingDown) {
        this.handleCrash();
      }
    });

    this.process.on('error', (err) => {
      this.logger.error('Sidecar process error', err, undefined, LogComponent.DocumentParser);
      this.process = null;
      if (!this.isShuttingDown) {
        this.handleCrash();
      }
    });
  }

  private handleCapability(msg: CapabilityMessage): void {
    this.capabilities = {
      parsers: msg.parsers,
      libreoffice_path: msg.libreoffice_path,
      version: msg.version,
    };
    this.restartAttempts = 0;
    this.logger.info('Sidecar capabilities received', { capabilities: this.capabilities }, LogComponent.DocumentParser);
  }

  private handleResponse(message: SidecarMessage): void {
    if (message.type === 'capabilities') {
      return;
    }

    const id = message.id;
    const timeout = this.pendingTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(id);
    }

    const request = this.queue.getPending().get(id);
    if (!request) return;

    if ('error' in message) {
      this.queue.onComplete(id);
      request.reject(new Error((message as JsonRpcErrorResponse).error.message));
      return;
    }

    const result = message.result;
    if (result.status === 'parsing') {
      request.onProgress?.(result.progress);
      return;
    }

    if (result.status === 'done') {
      this.queue.onComplete(id);
      const parseResult: ParseResult = {
        fileHash: this.computeFileHash(request.filePath),
        sessionId: request.sessionId,
        filename: path.basename(request.filePath),
        charCount: result.charCount,
        chunks: result.chunks,
        extractMethod: result.extractMethod as ParseResult['extractMethod'],
        parsedAt: Date.now(),
      };
      if (result.thumbnail) {
        parseResult.thumbnail = result.thumbnail as { base64: string; mediaType: string };
      }
      request.resolve(parseResult);
    }
  }

  private handleCrash(): void {
    const crashedRequests = this.queue.requeueAll();

    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.logger.error(`Sidecar failed after ${MAX_RESTART_ATTEMPTS} restart attempts`, new Error('Max restart attempts reached'), undefined, LogComponent.DocumentParser);
      for (const req of crashedRequests) {
        req.reject(new Error('Document parser unavailable after repeated crashes'));
      }
      return;
    }

    this.restartAttempts++;
    this.logger.warn(`Restarting sidecar in ${RESTART_DELAY_MS}ms (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`, undefined, LogComponent.DocumentParser);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnSidecar();
    }, RESTART_DELAY_MS);
  }

  private computeFileHash(filePath: string): string {
    const hash = crypto.createHash('sha256');
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      hash.update(buffer.subarray(0, bytesRead));
      fs.closeSync(fd);
    } catch { /* fallback */ }
    hash.update(path.basename(filePath));
    hash.update(fs.statSync(filePath).size.toString());
    return hash.digest('hex');
  }

  private getSidecarPath(): { cmd: string; args: string[] } {
    if (app.isPackaged) {
      // Packaged: use PyInstaller-bundled executable from resources
      const exePath = path.join(process.resourcesPath, 'document-parser');
      return { cmd: exePath, args: [] };
    }
    // Dev: use system Python to run main.py
    // __dirname = dist-electron/ (esbuild bundles into flat structure)
    const sidecarScript = path.join(__dirname, '..', 'electron', 'services', 'document-parser', 'sidecar', 'main.py');
    return { cmd: 'python', args: [sidecarScript] };
  }

  private async detectPython(): Promise<boolean> {
    const candidates = ['python', 'python3', 'py'];
    for (const cmd of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cmd, ['--version'], { stdio: 'pipe' });
          proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
          proc.on('error', reject);
        });
        this.logger.info(`Detected Python: ${cmd}`, undefined, LogComponent.DocumentParser);
        return true;
      } catch { continue; }
    }
    return false;
  }

  private startCacheCleanup(): void {
    setInterval(() => this.cache.clearExpired(CACHE_MAX_AGE_MS), 5 * 60 * 1000);
  }
}

let instance: DocumentParserService | null = null;

export function initDocumentParser(): DocumentParserService {
  if (!instance) instance = new DocumentParserService();
  return instance;
}

export function getDocumentParser(): DocumentParserService | null {
  return instance;
}