/** A real Host and Git repository behind the shared renderer control, with no mocked mutations. */
import { build } from 'esbuild';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { workspacePublicSources } from './workspace-public-sources.mjs';

const root = process.cwd();
const cache = path.join(root, '.cache', 'worktree-browser');
mkdirSync(cache, { recursive: true });
const artifact = path.join(cache, 'host.cjs');
await build({ entryPoints: ['packages/host/tests/workspace/browser-host.ts'],
  outfile: artifact, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [workspacePublicSources()],
  external: ['better-sqlite3', 'fsevents', 'esbuild', 'playwright'],
  banner: { js: "var import_meta_url = require('url').pathToFileURL(__filename).href;" }, define: { 'import.meta.url': 'import_meta_url' } });
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'duya-worktree-browser-data-'));
process.env.DUYA_DATA_ROOT = dataRoot;
process.env.DUYA_APP_DATA_PATH = dataRoot;
const { startLocalHost, HostSessionHttpClient } = (await import(pathToFileURL(artifact).href)).default;
const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'duya-worktree-browser-repo-')));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@duya.local'); git('config', 'user.name', 'Duya browser test');
writeFileSync(path.join(repo, 'README.md'), 'committed\n'); git('add', '.'); git('commit', '-qm', 'initial');
writeFileSync(path.join(repo, 'README.md'), 'source dirty\n');
const token = 'local-worktree-browser-fixture';
const host = await startLocalHost({ dataRoot, port: 0, token, ephemeral: true });
const client = new HostSessionHttpClient(host.origin, token);
const workspace = await client.registerLocalDirectory(repo);
const session = await client.create({ workspaceId: workspace.workspaceId, workspaceRootId: workspace.rootId, workspaceRelativePath: workspace.relativePath });
writeFileSync(path.join(cache, 'index.html'), `<!doctype html><html><body><main id="root"></main><script type="module" src="/@fs/${path.join(root, 'packages/ui/src/components/workspace/__tests__/browser-entry.tsx')}"></script></body></html>`);
const server = await createServer({ configFile: false, root: cache, plugins: [react(), {
  name: 'real-checkout-host-fixture', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/fixture') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ repo, sessionId: session.id })); return; }
      if (req.url === '/entry.tsx') { req.url = `/@fs/${path.join(root, 'packages/ui/src/components/workspace/__tests__/browser-entry.tsx')}`; next(); return; }
      if (req.url !== '/control') { next(); return; }
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await fetch(`${host.origin}/v1/checkouts/control`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
        res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.end(await response.text());
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
  },
}], resolve: { alias: { '@': path.join(root, 'packages/ui/src') }, dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 3199, strictPort: true, fs: { allow: [root, realpathSync(path.join(root, 'node_modules')), cache] } },
  optimizeDeps: { include: ['react', 'react-dom/client'] }, esbuild: { jsx: 'automatic' } });
await server.listen();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); await host.close(); process.exit(0); });
