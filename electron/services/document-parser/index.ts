import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logger';
import { createDocumentCache, DocumentCache } from './cache';
import type {
  ParseResult,
  ParseRequest,
  Capabilities,
  SidecarMessage,
  CapabilityMessage,
  JsonRpcDoneResponse,
  JsonRpcErrorResponse,
} from './types';
import { MAX_FILE_SIZE, PARSE_TIMEOUT, MAX_CONCURRENT, SUPPORTED_EXTENSIONS } from './types';

export type { ParseResult, Capabilities } from './types';

const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 3;

export class DocumentParserService {
  private process: ChildProcess | null = null;
  private capabilities: Capabilities | null = null;
  private cache: DocumentCache;
  private pendingRequests = new Map<number, ParseRequest>();
  private activeCount = 0;
  private requestQueue: ParseRequest[] = [];
  private nextId = 1;
  private buffer = '';
  private stderrBuffer = '';
  private isShuttingDown = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private logger = getLogger();

  constructor() {
    this.cache = createDocumentCache();
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
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.rejectAllPending(new Error('Document parser service shutting down'));
  }

  async parse(
    filePath: string,
    sessionId: string,
    onProgress?: (progress: number) => void,
  ): Promise<ParseResult> {
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

    const fileHash = this.computeFileHash(filePath, stat.size);

    const cached = this.cache.get(fileHash);
    if (cached) {
      return cached;
    }

    if (!this.isReady()) {
      throw new Error('Document parser not ready');
    }

    return new Promise<ParseResult>((resolve, reject) => {
      const id = this.nextId++;
      const request: ParseRequest = {
        id,
        filePath,
        sessionId,
        resolve: (result) => {
          this.activeCount--;
          this.processQueue();
          resolve(result);
        },
        reject: (error) => {
          this.activeCount--;
          this.processQueue();
          reject(error);
        },
        onProgress,
      };

      if (this.activeCount < MAX_CONCURRENT) {
        this.activeCount++;
        this.sendRequest(request);
      } else {
        this.requestQueue.push(request);
      }
    });
  }

  private sendRequest(request: ParseRequest): void {
    this.pendingRequests.set(request.id, request);

    const timeout = setTimeout(() => {
      this.pendingRequests.delete(request.id);
      request.reject(new Error(`Parse timeout (${PARSE_TIMEOUT / 1000}s)`));
    }, PARSE_TIMEOUT);

    const rpcRequest = {
      jsonrpc: '2.0' as const,
      id: request.id,
      method: 'parse',
      params: { path: request.filePath },
    };

    this.sendToSidecar(JSON.stringify(rpcRequest), timeout);
  }

  private processQueue(): void {
    while (this.activeCount < MAX_CONCURRENT && this.requestQueue.length > 0) {
      const next = this.requestQueue.shift();
      if (next) {
        this.activeCount++;
        this.sendRequest(next);
      }
    }
  }

  private sendToSidecar(line: string, timeout?: NodeJS.Timeout): void {
    if (!this.process || !this.process.stdin) {
      if (timeout) clearTimeout(timeout);
      return;
    }
    try {
      this.process.stdin.write(line + '\n');
    } catch (err) {
      this.logger.error(
        'Failed to write to sidecar stdin',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        LogComponent.DocumentParser,
      );
      if (timeout) clearTimeout(timeout);
    }
  }

  private async spawnSidecar(): Promise<void> {
    const sidecarPath = this.getSidecarPath();
    const pythonCommand = await this.detectPython();

    if (!pythonCommand) {
      this.logger.error(
        'Python not found for document parser sidecar',
        new Error('No Python runtime detected'),
        undefined,
        LogComponent.DocumentParser,
      );
      return;
    }

    this.logger.info(
      `Starting document parser sidecar: ${pythonCommand} ${sidecarPath}`,
      undefined,
      LogComponent.DocumentParser,
    );

    this.process = spawn(pythonCommand, [sidecarPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    this.buffer = '';
    this.stderrBuffer = '';

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.stderrBuffer += text;
      this.logger.warn(
        `Sidecar stderr: ${text.trim()}`,
        undefined,
        LogComponent.DocumentParser,
      );
    });

    this.process.on('exit', (code, signal) => {
      const stderr = this.stderrBuffer.trim();
      this.logger.warn(
        `Sidecar exited (code: ${code}, signal: ${signal})${stderr ? `\nStderr: ${stderr.substring(0, 2000)}` : ''}`,
        undefined,
        LogComponent.DocumentParser,
      );
      this.process = null;

      if (!this.isShuttingDown) {
        this.handleCrash();
      }
    });

    this.process.on('error', (err) => {
      this.logger.error(
        'Sidecar process error',
        err,
        undefined,
        LogComponent.DocumentParser,
      );
      this.process = null;

      if (!this.isShuttingDown) {
        this.handleCrash();
      }
    });
  }

  private handleStdout(data: Buffer): void {
    this.buffer += data.toString('utf-8');

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: SidecarMessage = JSON.parse(trimmed);

        if ('type' in message && message.type === 'capabilities') {
          const capMsg = message as CapabilityMessage;
          this.capabilities = {
            parsers: capMsg.parsers,
            libreoffice_path: capMsg.libreoffice_path,
            version: capMsg.version,
          };
          this.restartAttempts = 0;
          this.logger.info(
            'Sidecar capabilities received',
            capMsg,
            LogComponent.DocumentParser,
          );
          continue;
        }

        if ('id' in message) {
          this.handleResponse(message);
        }
      } catch {
        this.logger.warn(
          `Failed to parse sidecar message: ${trimmed.substring(0, 200)}`,
          undefined,
          LogComponent.DocumentParser,
        );
      }
    }
  }

  private handleResponse(message: SidecarMessage): void {
    const id = message.id as number;
    const request = this.pendingRequests.get(id);
    if (!request) return;

    if ('error' in message) {
      const errMsg = message as JsonRpcErrorResponse;
      this.pendingRequests.delete(id);
      request.reject(new Error(errMsg.error.message));
      return;
    }

    const result = (message as JsonRpcDoneResponse).result;
    if (result.status === 'parsing') {
      request.onProgress?.(result.progress);
      return;
    }

    if (result.status === 'done') {
      this.pendingRequests.delete(id);

      const parseResult: ParseResult = {
        fileHash: this.computeFileHash(
          request.filePath,
          fs.existsSync(request.filePath) ? fs.statSync(request.filePath).size : 0,
        ),
        sessionId: request.sessionId,
        filename: path.basename(request.filePath),
        charCount: result.charCount,
        chunks: result.chunks,
        extractMethod: result.extractMethod as ParseResult['extractMethod'],
        parsedAt: Date.now(),
      };

      this.cache.set(parseResult.fileHash, parseResult);
      request.resolve(parseResult);
    }
  }

  private handleCrash(): void {
    const activeRequests = Array.from(this.pendingRequests.values());
    for (const [id, request] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      this.requestQueue.unshift(request);
    }
    this.activeCount = 0;

    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.logger.error(
        `Sidecar failed after ${MAX_RESTART_ATTEMPTS} restart attempts, giving up`,
        new Error('Max restart attempts reached'),
        undefined,
        LogComponent.DocumentParser,
      );
      for (const req of this.requestQueue) {
        req.reject(new Error('Document parser unavailable after repeated crashes'));
      }
      this.requestQueue = [];
      return;
    }

    this.restartAttempts++;
    this.logger.warn(
      `Restarting sidecar in ${RESTART_DELAY_MS}ms (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
      undefined,
      LogComponent.DocumentParser,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnSidecar().then(() => {
        this.processQueue();
      });
    }, RESTART_DELAY_MS);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, request] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      request.reject(error);
    }
    for (const request of this.requestQueue) {
      request.reject(error);
    }
    this.requestQueue = [];
    this.activeCount = 0;
  }

  private computeFileHash(filePath: string, fileSize: number): string {
    const hash = crypto.createHash('sha256');

    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(65536); // 64KB
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      hash.update(buffer.subarray(0, bytesRead));
      fs.closeSync(fd);
    } catch {
      // If file can't be read, use path + size as fallback
    }

    hash.update(path.basename(filePath));
    hash.update(fileSize.toString());
    return hash.digest('hex');
  }

  private getSidecarPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'sidecar', 'main.py');
    }
    return path.join(__dirname, '..', 'electron', 'services', 'document-parser', 'sidecar', 'main.py');
  }

  private async detectPython(): Promise<string | null> {
    const candidates = ['python', 'python3', 'py'];

    for (const cmd of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cmd, ['--version'], { stdio: 'pipe' });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code ${code}`));
          });
          proc.on('error', reject);
        });
        this.logger.info(`Detected Python: ${cmd}`, undefined, LogComponent.DocumentParser);
        return cmd;
      } catch {
        continue;
      }
    }

    this.logger.error(
      'No Python runtime found',
      new Error('Tried: python, python3, py — none worked'),
      undefined,
      LogComponent.DocumentParser,
    );
    return null;
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      this.cache.clearExpired(CACHE_MAX_AGE_MS);
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}

let instance: DocumentParserService | null = null;

export function initDocumentParser(): DocumentParserService {
  if (!instance) {
    instance = new DocumentParserService();
  }
  return instance;
}

export function getDocumentParser(): DocumentParserService | null {
  return instance;
}