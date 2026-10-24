import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { PLUGIN_UI_RESOURCE_MAX_BYTES } from '@duya/plugin-core/apps/declarations';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

type PackageMount = { sessionId: string; kind: 'package'; root: string };
type DocumentMount = { sessionId: string; kind: 'document'; html: string; sizeBytes: number };
type Mount = PackageMount | DocumentMount;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Cache-Control': 'no-store' });
  response.end();
}

/** Serve installed App assets to opaque-origin iframes in dev and packaged renderers. */
export class PluginAppAssetServer {
  readonly #mounts = new Map<string, Mount>();
  #server: Server | null = null;
  #starting: Promise<string> | null = null;
  #origin = '';

  async open(sessionId: string, packagePath: string, entryPath: string): Promise<string> {
    const root = await realpath(packagePath);
    const entry = await realpath(entryPath);
    if (!isInside(root, entry) || !(await stat(entry)).isFile()) throw new Error('plugin_app_entry_unavailable');
    const origin = await this.#start();
    this.revoke(sessionId);
    const token = randomBytes(32).toString('base64url');
    this.#mounts.set(token, { sessionId, kind: 'package', root });
    const resource = path.relative(root, entry).split(path.sep).map(encodeURIComponent).join('/');
    return `${origin}/${token}/${resource}`;
  }

  async openDocument(sessionId: string, html: string): Promise<string> {
    const sizeBytes = Buffer.byteLength(html, 'utf8');
    if (sizeBytes === 0 || sizeBytes > PLUGIN_UI_RESOURCE_MAX_BYTES) throw new Error('plugin_app_resource_size_invalid');
    const origin = await this.#start();
    this.revoke(sessionId);
    const token = randomBytes(32).toString('base64url');
    this.#mounts.set(token, { sessionId, kind: 'document', html, sizeBytes });
    return `${origin}/${token}/index.html`;
  }

  revoke(sessionId: string): void {
    for (const [token, mount] of this.#mounts) if (mount.sessionId === sessionId) this.#mounts.delete(token);
  }

  async close(): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined);
    this.#mounts.clear();
    const server = this.#server;
    this.#server = null;
    this.#starting = null;
    this.#origin = '';
    if (server) await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  #start(): Promise<string> {
    if (this.#starting) return this.#starting;
    this.#starting = new Promise<string>((resolve, rejectStart) => {
      const server = createServer((request, response) => {
        if (request.headers.host !== this.#origin.slice('http://'.length)) { reject(response, 403); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') { reject(response, 405); return; }
        void this.#serve(request.url ?? '', request.method === 'HEAD', response).catch(() => {
          if (response.headersSent) response.destroy(); else reject(response, 404);
        });
      });
      server.once('error', (error) => { this.#starting = null; rejectStart(error); });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); rejectStart(new Error('plugin_app_assets_unavailable')); return; }
        this.#server = server;
        this.#origin = `http://127.0.0.1:${address.port}`;
        server.unref();
        resolve(this.#origin);
      });
    });
    return this.#starting;
  }

  async #serve(rawUrl: string, head: boolean, response: ServerResponse): Promise<void> {
    let resource: string;
    try { resource = decodeURIComponent(rawUrl.split('?', 1)[0]!); }
    catch { reject(response, 400); return; }
    const match = /^\/([A-Za-z0-9_-]+)\/(.+)$/.exec(resource);
    const mount = match ? this.#mounts.get(match[1]!) : undefined;
    if (!match || !mount || resource.includes('\0')) { reject(response, 404); return; }
    if (mount.kind === 'document') {
      if (match[2] !== 'index.html') { reject(response, 404); return; }
      if (this.#mounts.get(match[1]!) !== mount) { reject(response, 404); return; }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': mount.sizeBytes,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Access-Control-Allow-Origin': '*',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(head ? undefined : mount.html);
      return;
    }
    const file = await realpath(path.resolve(mount.root, match[2]!));
    if (!isInside(mount.root, file)) { reject(response, 404); return; }
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) { reject(response, 404); return; }
    // Re-check after asynchronous filesystem work: an update/close revokes
    // outstanding requests before any bytes are sent.
    if (this.#mounts.get(match[1]!) !== mount) { reject(response, 404); return; }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Module scripts, fonts and fetch from a sandboxed iframe have an
      // opaque Origin. The unguessable mount grants assets, never Host APIs.
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-downloads allow-popups; object-src 'none'; base-uri 'self'",
    });
    if (head) { response.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
}

export const pluginAppAssets = new PluginAppAssetServer();
