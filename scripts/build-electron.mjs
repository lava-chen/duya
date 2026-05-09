import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

async function buildElectron() {
  // Clean dist-electron/ before every build to prevent stale artifacts
  if (fs.existsSync('dist-electron')) {
    fs.rmSync('dist-electron', { recursive: true });
    console.log('Cleaned dist-electron/');
  }
  fs.mkdirSync('dist-electron', { recursive: true });

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: [
      'electron',
      'better-sqlite3',
      // Playwright dynamic requires that esbuild cannot resolve
      'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
      'chromium-bidi/lib/cjs/cdp/CdpConnection',
    ],
    sourcemap: true,
    minify: false,
  };

  await build({
    ...shared,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.js',
  });

  await build({
    ...shared,
    entryPoints: ['electron/preload.ts'],
    outfile: 'dist-electron/preload.js',
  });

  // Agent runs as ChildProcess via agent-process-entry.ts
  // which is built separately by the agent package's own TypeScript build (npm run build:agent)
  // and is NOT part of the electron bundle.
  // AgentProcessPool spawns this process using its own dist/ path at runtime.

  console.log('Electron build complete');

  // Copy native modules needed by the app
  copyNativeModules();
}

// Copy better-sqlite3 native module to dist/ for production
function copyNativeModules() {
  const distNodeModules = 'dist/node_modules';
  const nativeModules = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

  for (const mod of nativeModules) {
    const sourceDir = path.join('node_modules', mod);
    const targetDir = path.join(distNodeModules, mod);

    if (fs.existsSync(sourceDir) && !fs.existsSync(targetDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(sourceDir, targetDir, { recursive: true });
      console.log(`Copied native module: ${mod} -> dist/node_modules/`);
    }
  }

  // Also check in packages/agent/node_modules for better-sqlite3
  const agentBetterSqlite3 = 'packages/agent/node_modules/better-sqlite3';
  const targetBetterSqlite3 = path.join(distNodeModules, 'better-sqlite3');
  if (fs.existsSync(agentBetterSqlite3) && !fs.existsSync(targetBetterSqlite3)) {
    fs.cpSync(agentBetterSqlite3, targetBetterSqlite3, { recursive: true });
    console.log(`Copied better-sqlite3 from packages/agent/node_modules/`);
  }
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
