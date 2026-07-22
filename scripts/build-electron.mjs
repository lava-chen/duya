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
      'node-pty',
      // Playwright dynamic requires that esbuild cannot resolve
      'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
      'chromium-bidi/lib/cjs/cdp/CdpConnection',
    ],
    sourcemap: true,
    minify: false,
    // packages/agent/src/plugins/builtin/_registry.ts reads
    // `import.meta.url` and falls back to `__dirname` when bundled
    // as CJS without the `import_meta_url` polyfill (the agent and
    // CLI bundles do inject that polyfill; this Electron bundle
    // does not). The fallback is intentional and documented in the
    // file, so silence the corresponding esbuild notice.
    logOverride: { 'empty-import-meta': 'silent' },
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

  await build({
    ...shared,
    entryPoints: ['electron/agents/server/index.ts'],
    outfile: 'dist-electron/agent-server.js',
  });

  await build({
    ...shared,
    entryPoints: ['electron/project-database/worker.ts'],
    outfile: 'dist-electron/project-database-worker.js',
  });

  // Agent runs as ChildProcess via agent-process-entry.ts
  // which is built separately by the agent package's own TypeScript build (npm run build:agent)
  // and is NOT part of the electron bundle.
  // AgentProcessPool spawns this process using its own dist/ path at runtime.

  console.log('Electron build complete');

  // Copy native modules needed by the app
  copyNativeModules();
}

// Copy native modules to dist/ for production.
function copyNativeModules() {
  const distNodeModules = 'dist/node_modules';
  const nativeModules = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty'];

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
