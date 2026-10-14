import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { workspacePublicSources } from './workspace-public-sources.mjs';

// ESM has no __dirname — derive the script directory from import.meta.url.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function buildElectron() {
  // Clean dist-electron/ before every build to prevent stale artifacts
  if (fs.existsSync('dist-electron')) {
    if (fs.realpathSync('dist-electron') !== path.resolve('dist-electron') || fs.lstatSync('dist-electron').isSymbolicLink()) {
      throw new Error('Refusing to clean redirected Electron output');
    }
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
      'fsevents',
      'node-pty',
      // nut.js + its native libnut binding - the JS is plain require()
      // but `bindings("libnut")` walks the call stack to locate the
      // .node file relative to the calling module. Bundling breaks
      // that lookup because the caller's __filename collapses into
      // dist-electron/main.js. Keep them external so require() lands
      // on the real package and bindings finds build/Release/libnut.node.
      '@nut-tree-fork/nut-js',
      '@nut-tree-fork/libnut',
      '@nut-tree-fork/libnut-win32',
      '@nut-tree-fork/libnut-linux',
      '@nut-tree-fork/libnut-darwin',
      // Playwright dynamic requires that esbuild cannot resolve
      'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
      'chromium-bidi/lib/cjs/cdp/CdpConnection',
    ],
    sourcemap: true,
    // Production bundle is minified for cold-start latency. Dev runs
    // (`npm run electron:dev`) skip this script entirely and run main.ts
    // via tsx, so the minified CJS here only affects the packaged app —
    // debug sessions still see unminified stack traces via the .map files.
    minify: true,
    treeShaking: true,
    plugins: [workspacePublicSources(path.resolve(scriptDir, '..'))],
    banner: { js: "var import_meta_url = typeof __filename === 'string' ? require('url').pathToFileURL(__filename).href : undefined;" },
    define: { 'import.meta.url': 'import_meta_url' },
    // The agent bundle (and WorkerPool.ts in packages/agent) reads
    // `import.meta.url` and falls back to `__dirname` when bundled as CJS
    // without the `import_meta_url` polyfill (this Electron bundle does
    // not inject it). The fallback is intentional, so silence the esbuild
    // `empty-import-meta` notice.
    logOverride: { 'empty-import-meta': 'silent' },
  };

  await build({
    ...shared,
    entryPoints: ['apps/desktop/src/main/index.ts'],
    outfile: 'dist-electron/main.js',
  });

  await build({
    ...shared,
    entryPoints: ['apps/desktop/src/preload/index.ts'],
    outfile: 'dist-electron/preload.js',
  });

  await build({
    ...shared,
    entryPoints: ['apps/desktop/src/main/agents/server/index.ts'],
    outfile: 'dist-electron/agent-server.js',
  });

  await build({
    ...shared,
    entryPoints: ['apps/desktop/src/main/project-database/worker.ts'],
    outfile: 'dist-electron/project-database-worker.js',
  });

  // Host worker and shell-child executables are emitted by build-agent-bundle.mjs.

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


}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
