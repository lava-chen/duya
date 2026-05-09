/**
 * Docker Sandbox Provider
 *
 * Executes commands inside a Docker container via the Docker HTTP API.
 * Uses Node.js built-in http module — zero external Docker client dependencies.
 *
 * Docker daemon socket:
 *   - Windows:  \\.\pipe\docker_engine (named pipe)
 *   - Linux:    /var/run/docker.sock (Unix socket)
 *   - macOS:    /var/run/docker.sock (Unix socket)
 */

import { request, RequestOptions } from 'http';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SandboxPolicy } from './types.js';

const SANDBOX_IMAGE = 'duya-sandbox:latest';

let dockerAvailable: boolean | null = null;

function getDockerSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\docker_engine';
  }
  return '/var/run/docker.sock';
}

function dockerRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socketPath = getDockerSocketPath();
    const postData = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (postData) {
      headers['Content-Length'] = String(Buffer.byteLength(postData));
    }

    const options: RequestOptions = { socketPath, path, method, headers };

    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Docker request timeout'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Check if Docker daemon is reachable.
 */
export async function checkDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    const res = await dockerRequest('GET', '/v1.47/_ping');
    dockerAvailable = res.statusCode === 200;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

export function resetDockerAvailability(): void {
  dockerAvailable = null;
}

const SANDBOX_DOCKERFILE = `FROM alpine:3.20
RUN apk add --no-cache bash git curl wget python3 py3-pip nodejs npm
WORKDIR /workspace
CMD ["sh"]
`;

type BuildProgressFn = (message: string) => void;

/**
 * Build the sandbox Docker image from embedded Dockerfile.
 * Writes Dockerfile to a temp directory and runs `docker build`.
 * Returns true if the build succeeded, false otherwise.
 *
 * Non-blocking: uses execFile so the agent event loop stays responsive.
 * Called during agent init; first build takes ~60s on a typical machine.
 * Subsequent calls detect existing image and return immediately.
 */
export async function buildSandboxImage(onProgress?: BuildProgressFn): Promise<boolean> {
  // Fast path: image already exists
  if (await imageExists(SANDBOX_IMAGE)) {
    onProgress?.('[Sandbox] Docker image already exists, skipping build');
    return true;
  }

  onProgress?.('[Sandbox] Building Docker sandbox image... (first time, ~60s)');

  // Write Dockerfile to a temp directory
  let buildDir: string | null = null;
  try {
    buildDir = mkdtempSync(join(tmpdir(), 'duya-sandbox-build-'));
    writeFileSync(join(buildDir, 'Dockerfile'), SANDBOX_DOCKERFILE);
  } catch {
    onProgress?.('[Sandbox] Failed to create build directory');
    return false;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = execFile('docker', ['build', '-t', SANDBOX_IMAGE, '.'], {
        cwd: buildDir!,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });

      proc.stdout?.on('data', (data: Buffer) => {
        onProgress?.(`[Sandbox] ${data.toString('utf-8').trim()}`);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        onProgress?.(`[Sandbox] ${data.toString('utf-8').trim()}`);
      });
    });

    onProgress?.('[Sandbox] Docker sandbox image built successfully');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.(`[Sandbox] Docker image build failed: ${message}`);
    return false;
  } finally {
    if (buildDir) {
      try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
}

async function imageExists(image: string): Promise<boolean> {
  try {
    const res = await dockerRequest('GET', `/v1.47/images/${encodeURIComponent(image)}/json`);
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

/**
 * Demultiplex Docker container log frames.
 * Docker multiplexes stdout/stderr with 8-byte headers:
 *   byte 0: stream type (1=stdout, 2=stderr)
 *   bytes 1-3: reserved
 *   bytes 4-7: frame size (big-endian uint32)
 */
function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  let offset = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const frameSize = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + frameSize > buffer.length || frameSize <= 0) break;

    const frame = buffer.subarray(offset, offset + frameSize);
    offset += frameSize;

    if (streamType === 1) {
      stdoutChunks.push(frame);
    } else if (streamType === 2) {
      stderrChunks.push(frame);
    }
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
  };
}

interface ExecuteOptions {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
  signal?: AbortSignal;
}

interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command inside a Docker container with sandbox isolation.
 */
export async function executeInDocker(options: ExecuteOptions): Promise<ExecuteResult> {
  const { command, cwd, policy, signal } = options;

  const binds: string[] = [
    `${cwd}:/workspace`,
  ];

  if (policy.filesystem.allowWrite.length > 0) {
    for (const dir of policy.filesystem.allowWrite) {
      if (dir && dir !== cwd) {
        binds.push(`${dir}:${dir}`);
      }
    }
  }

  // Create container
  const createPayload = {
    Image: SANDBOX_IMAGE,
    Cmd: ['sh', '-c', command],
    WorkingDir: '/workspace',
    HostConfig: {
      Binds: binds,
      Memory: policy.memoryLimitMb * 1024 * 1024,
      NetworkMode: policy.network === 'none' ? 'none' : 'bridge',
      AutoRemove: false,
    },
    Env: [
      'HOME=/workspace',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ],
  };

  const createRes = await dockerRequest('POST', '/v1.47/containers/create', createPayload);

  if (createRes.statusCode !== 201) {
    const errBody = safeJsonParse(createRes.body.toString('utf-8'));
    throw new Error(`Docker create container failed: ${errBody?.message ?? createRes.body.toString('utf-8')}`);
  }

  const createData = JSON.parse(createRes.body.toString('utf-8'));
  const containerId: string = createData.Id;

  let aborted = false;
  if (signal) {
    const abortHandler = () => {
      aborted = true;
      dockerRequest('DELETE', `/v1.47/containers/${containerId}?force=true`)
        .catch(() => {});
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    if (aborted) {
      return { stdout: '', stderr: '', exitCode: -1 };
    }

    // Start container
    const startRes = await dockerRequest('POST', `/v1.47/containers/${containerId}/start`);
    if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
      throw new Error(`Docker start failed: ${startRes.body.toString('utf-8')}`);
    }

    // Wait for container to finish
    const waitRes = await dockerRequest('POST', `/v1.47/containers/${containerId}/wait`);
    const waitData = JSON.parse(waitRes.body.toString('utf-8'));
    const exitCode = typeof waitData.StatusCode === 'number' ? waitData.StatusCode : -1;

    // Get logs (multiplexed stdout+stderr)
    const logsRes = await dockerRequest(
      'GET',
      `/v1.47/containers/${containerId}/logs?stdout=1&stderr=1`,
    );

    const { stdout, stderr } = demuxDockerLogs(logsRes.body);

    return { stdout, stderr, exitCode };
  } finally {
    try {
      await dockerRequest('DELETE', `/v1.47/containers/${containerId}?force=true&v=true`);
    } catch {
      // Container may already be removed
    }
  }
}

/**
 * Ensure the sandbox image is available.
 * Builds it automatically if needed (embedded Dockerfile).
 * No Docker Hub account required.
 *
 * @deprecated Use buildSandboxImage() for progress reporting
 */
export async function ensureSandboxImage(): Promise<void> {
  await buildSandboxImage();
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}