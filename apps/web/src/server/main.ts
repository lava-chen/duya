import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLocalHostRuntime } from '@duya/host/local-host';
import { createWebBff } from './web-bff.js';

interface HostConnection {
  readonly origin: string;
  readonly token: string;
}

/** Resolve the same Host runtime descriptor used by the standalone CLI. */
export async function resolveHostConnection(env: NodeJS.ProcessEnv = process.env): Promise<HostConnection> {
  const configuredOrigin = env.DUYA_HOST_ORIGIN?.trim();
  if (configuredOrigin) {
    const token = env.DUYA_HOST_TOKEN?.trim();
    if (!token) throw new Error('DUYA_HOST_TOKEN is required with DUYA_HOST_ORIGIN');
    return { origin: configuredOrigin.replace(/\/+$/, ''), token };
  }

  const dataRoot = env.DUYA_DATA_ROOT?.trim() || path.join(os.homedir(), '.duya');
  let runtime: Awaited<ReturnType<typeof readLocalHostRuntime>>;
  try {
    runtime = await readLocalHostRuntime(dataRoot);
  } catch {
    throw new Error('Duya Host runtime descriptor is invalid or unreadable');
  }
  if (runtime === null) {
    throw new Error('No live local Duya Host found; start one or configure DUYA_HOST_ORIGIN and DUYA_HOST_TOKEN');
  }
  return {
    origin: `http://${runtime.host}:${runtime.port}`,
    token: runtime.token,
  };
}

function resolveWebPort(env: NodeJS.ProcessEnv): number | undefined {
  const configured = env.DUYA_WEB_PORT?.trim();
  if (!configured) return undefined;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('DUYA_WEB_PORT must be an integer from 0 to 65535');
  }
  return port;
}

export async function main(): Promise<void> {
  const connection = await resolveHostConnection();
  const port = resolveWebPort(process.env);
  const bff = await createWebBff({
    hostOrigin: connection.origin,
    hostToken: connection.token,
    staticRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client'),
    ...(port === undefined ? {} : { port }),
  });
  process.stdout.write(`Duya web BFF listening at ${bff.origin}\n`);

  let closing: Promise<void> | undefined;
  const close = (): void => {
    closing ??= bff.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await new Promise<void>((resolve) => {
    if (closing) resolve();
    else process.once('beforeExit', resolve);
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Web BFF startup failed';
    process.stderr.write(`Unable to start Duya web BFF: ${message}\n`);
    process.exitCode = 1;
  });
}
