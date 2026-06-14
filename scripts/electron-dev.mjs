import net from 'net';
import path from 'path';
import { spawn } from 'child_process';

const rootDir = process.cwd();
const nodeBinDir = path.dirname(process.execPath);
const env = {
  ...process.env,
  PATH: `${nodeBinDir}:${process.env.PATH || ''}`,
};

const BIN = (name) => path.join(rootDir, 'node_modules', '.bin', name);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${path.basename(command)} exited with code ${code ?? signal}`));
    });
  });
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
    ...options,
  });
  return child;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');

    const close = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(500);
    socket.once('connect', () => close(true));
    socket.once('timeout', () => close(false));
    socket.once('error', () => close(false));
  });
}

let viteProcess = null;

async function main() {
  await run(BIN('tsc'), ['-p', 'packages/cli/tsconfig.json']);
  await run('node', ['scripts/build-agent-bundle.mjs']);
  await run('node', ['scripts/build-electron.mjs']);

  const reuseExistingDevServer = await isPortOpen(3000);
  if (!reuseExistingDevServer) {
    viteProcess = spawnProcess(BIN('vite'), ['--port', '3000', '--strictPort']);
    await run(BIN('wait-on'), ['http://localhost:3000']);
  } else {
    console.log('[electron:dev] Reusing existing dev server on http://localhost:3000');
  }

  process.env.VITE_DEV_SERVER_URL = 'http://localhost:3000';
  const electronProcess = spawnProcess(BIN('electron'), ['.']);

  const shutdown = (signal) => {
    if (viteProcess && !viteProcess.killed) {
      viteProcess.kill(signal);
    }
    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill(signal);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve) => {
    electronProcess.on('exit', (code, signal) => {
      if (viteProcess && !viteProcess.killed) {
        viteProcess.kill('SIGTERM');
      }
      if (code !== 0) {
        process.exitCode = code ?? 1;
      } else if (signal) {
        process.exitCode = 1;
      }
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error);
  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill('SIGTERM');
  }
  process.exit(1);
});
