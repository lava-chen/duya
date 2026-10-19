import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import { createWebBff, type WebBffHandle } from '../../src/server/web-bff.js';

// The Host bearer must never reach the browser through any served byte.
const HOST_TOKEN = 'static-serving-host-token';

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><title>Duya</title>',
  '<link rel="stylesheet" href="/assets/app.css">',
  '</head>',
  '<body><div id="root"></div>',
  '<script type="module" src="/assets/app.js"></script>',
  '</body>',
  '</html>',
  '',
].join('\n');
const APP_JS = 'export const boot = "duya-web-static";\n';
const APP_CSS = ':root { --duya-web: 1; }\n';
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n';
const NESTED_JS = 'export const nested = 1;\n';
const UNKNOWN_EXT = 'extension the MIME table does not know\n';
const ROBOTS_TXT = 'User-agent: *\nDisallow:\n';
// A test sentinel lives one level ABOVE the served build root, so a
// traversal that reached the filesystem would return this exact content.
const SECRET = 'DUYA-STATIC-SECRET-OUTSIDE-BUILD-ROOT\n';

const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const bffs: WebBffHandle[] = [];
const links: Array<{ path: string; kind: 'file' | 'junction' }> = [];

describe('direct document navigation', () => {
  it('allows browser address-bar navigation while retaining the API fetch-site boundary', async () => {
    const fixture = await createBuildFixture();
    const bff = await startBff(fixture.staticRoot);
    const navigation = {
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    // Node fetch rewrites Sec-Fetch-Mode to cors; preserve browser navigation headers.
    expect((await rawRequest(bff, '/', { headers: navigation })).status).toBe(200);
    expect((await rawRequest(bff, '/api/bootstrap', { headers: navigation })).status).toBe(403);
    expect((await rawRequest(bff, '/assets/app.js', {
      headers: { 'sec-fetch-site': 'none' },
    })).status).toBe(403);
    expect((await rawRequest(bff, '/', {
      headers: { ...navigation, origin: 'https://foreign.example' },
    })).status).toBe(403);
  });
});

afterEach(async () => {
  for (const bff of bffs.splice(0)) await bff.close();
  for (const host of hosts.splice(0)) await host.close();
  // Detach every link before recursive fixture cleanup; never traverse a junction.
  for (const link of links.splice(0)) {
    if (!(await fs.lstat(link.path)).isSymbolicLink()) throw new Error('fixture link changed');
    if (link.kind === 'junction') await fs.rmdir(link.path);
    else await fs.unlink(link.path);
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface BuildFixture {
  readonly container: string;
  readonly staticRoot: string;
  readonly secretPath: string;
}

/**
 * Lays out a container that mirrors a packaged build:
 *   <container>/build/index.html        served root
 *   <container>/build/assets/...        served assets
 *   <container>/secret.txt              one level above, must never be served
 */
async function createBuildFixture(): Promise<BuildFixture> {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-static-'));
  roots.push(container);
  const staticRoot = path.join(container, 'build');
  await fs.mkdir(path.join(staticRoot, 'assets', 'nested'), { recursive: true });
  await fs.mkdir(path.join(staticRoot, 'assets', 'plain-dir'), { recursive: true });
  await fs.writeFile(path.join(staticRoot, 'index.html'), INDEX_HTML);
  await fs.writeFile(path.join(staticRoot, 'assets', 'app.js'), APP_JS);
  await fs.writeFile(path.join(staticRoot, 'assets', 'app.css'), APP_CSS);
  await fs.writeFile(path.join(staticRoot, 'assets', 'logo.svg'), LOGO_SVG);
  await fs.writeFile(path.join(staticRoot, 'assets', 'notes.xyz'), UNKNOWN_EXT);
  await fs.writeFile(path.join(staticRoot, 'robots.txt'), ROBOTS_TXT);
  await fs.writeFile(path.join(staticRoot, 'assets', 'nested', 'chunk.js'), NESTED_JS);
  const secretPath = path.join(container, 'secret.txt');
  await fs.writeFile(secretPath, SECRET);
  return { container, staticRoot, secretPath };
}

/**
 * Creates a link whose canonical target escapes the build root.
 * Windows denies unprivileged file symlinks, so fall back to a directory
 * junction, which resolves the same way through realpath.
 */
async function createEscapingLink(
  staticRoot: string,
  secretPath: string,
): Promise<{ readonly kind: 'file' | 'junction'; readonly requestPath: string }> {
  const fileLink = path.join(staticRoot, 'assets', 'escape.js');
  try {
    await fs.symlink(secretPath, fileLink, 'file');
    links.push({ path: fileLink, kind: 'file' });
    return { kind: 'file', requestPath: '/assets/escape.js' };
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) ||
      (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error;
    const junctionLink = path.join(staticRoot, 'assets', 'escaped');
    await fs.symlink(path.dirname(secretPath), junctionLink, 'junction');
    links.push({ path: junctionLink, kind: 'junction' });
    return { kind: 'junction', requestPath: '/assets/escaped/secret.txt' };
  }
}

async function startBff(staticRoot?: string, host?: LocalHostHandle): Promise<WebBffHandle> {
  const bff = await createWebBff({
    hostOrigin: host?.origin ?? 'http://127.0.0.1:1',
    hostToken: HOST_TOKEN,
    ...(staticRoot === undefined ? {} : { staticRoot }),
  });
  bffs.push(bff);
  return bff;
}

async function startTestHost(): Promise<LocalHostHandle> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-static-host-'));
  roots.push(dataRoot);
  const host = await startLocalHost({
    dataRoot,
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: HOST_TOKEN,
    ephemeral: true,
  });
  hosts.push(host);
  return host;
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Issues a request whose target is sent verbatim on the wire. fetch() collapses
 * dot segments before transmitting, so traversal payloads must bypass it.
 */
function rawRequest(
  bff: WebBffHandle,
  requestPath: string,
  options: { readonly method?: string; readonly headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(new URL(bff.origin), {
      method: options.method ?? 'GET',
      path: requestPath,
      headers: options.headers ?? {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('same-origin static build serving', () => {
  it('serves the built index document at / and /index.html under a self-only CSP', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const atRoot = await rawRequest(bff, '/');
    const atIndex = await rawRequest(bff, '/index.html');
    const csp = String(atRoot.headers['content-security-policy']);

    expect(atRoot.status).toBe(200);
    expect(atRoot.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(atRoot.headers['x-content-type-options']).toBe('nosniff');
    expect(atRoot.body).toBe(INDEX_HTML);
    expect(atIndex.status).toBe(200);
    expect(atIndex.body).toBe(INDEX_HTML);
    // A Vite build loads its script and stylesheet as external same-origin
    // files, so the policy may allow self but must not need inline or eval.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
  });

  it('serves built assets under /assets with type-appropriate MIME', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const js = await rawRequest(bff, '/assets/app.js');
    const css = await rawRequest(bff, '/assets/app.css');
    const svg = await rawRequest(bff, '/assets/logo.svg');
    const nested = await rawRequest(bff, '/assets/nested/chunk.js');
    const unknown = await rawRequest(bff, '/assets/notes.xyz');
    const versioned = await rawRequest(bff, '/assets/app.js?v=1');

    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toBe(APP_JS);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toBe(APP_CSS);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(svg.body).toBe(LOGO_SVG);
    expect(nested.status).toBe(200);
    expect(nested.body).toBe(NESTED_JS);
    // An extension outside the MIME table is refused rather than sniffed.
    expect(unknown.status).toBe(404);
    expect(unknown.body).not.toContain('extension the MIME table');
    expect(versioned.status).toBe(200);
    expect(versioned.body).toBe(APP_JS);
  });

  it('answers HEAD with the same headers and no body', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const headIndex = await rawRequest(bff, '/', { method: 'HEAD' });
    const headAsset = await rawRequest(bff, '/assets/app.js', { method: 'HEAD' });
    const getAsset = await rawRequest(bff, '/assets/app.js');

    expect(headIndex.status).toBe(200);
    expect(headIndex.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headIndex.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(headIndex.headers['content-security-policy']).toBeTruthy();
    expect(headIndex.body).toBe('');
    expect(headAsset.status).toBe(200);
    expect(headAsset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(headAsset.headers['content-length']).toBe(String(Buffer.byteLength(APP_JS)));
    expect(headAsset.body).toBe('');
    expect(getAsset.headers['content-length']).toBe(headAsset.headers['content-length']);
  });

  it('rejects traversal, encoded traversal, backslash and NUL payloads without touching disk', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const payloads = [
      '/assets/../../secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/assets/%2e%2e%5c%2e%2e%5csecret.txt',
      '/assets/..\\..\\secret.txt',
      '/assets/app.js%00.txt',
      '/assets/%00app.js',
      '/assets/....//secret.txt',
      '/assets/nested/../../secret.txt',
      '/../secret.txt',
      '/assets//../secret.txt',
    ];

    for (const payload of payloads) {
      const response = await rawRequest(bff, payload);
      expect([400, 404], payload).toContain(response.status);
      expect(response.body, payload).not.toContain('DUYA-STATIC-SECRET');
      expect(response.body, payload).not.toContain(staticRoot);
      expect(response.body, payload).not.toContain('trace');
    }
  });

  it('refuses a link whose canonical target escapes the build root', async () => {
    const { staticRoot, secretPath } = await createBuildFixture();
    const link = await createEscapingLink(staticRoot, secretPath);
    const bff = await startBff(staticRoot);

    const response = await rawRequest(bff, link.requestPath);

    // Guard against a vacuous pass: the escape target really is on disk, so a
    // server that followed the link would have returned its content.
    await expect(fs.readFile(secretPath, 'utf8')).resolves.toContain('DUYA-STATIC-SECRET');
    expect(['file', 'junction']).toContain(link.kind);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('DUYA-STATIC-SECRET');
    expect(response.body).not.toContain(secretPath);
  });

  it('refuses directories and never lists a directory index', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const responses = await Promise.all([
      rawRequest(bff, '/assets/'),
      rawRequest(bff, '/assets'),
      rawRequest(bff, '/assets/plain-dir'),
      rawRequest(bff, '/assets/plain-dir/'),
      rawRequest(bff, '/assets/nested'),
      rawRequest(bff, '/index.html/'),
      rawRequest(bff, '/index.html/extra'),
    ]);

    for (const response of responses) expect(response.status).toBe(404);
    expect(responses[0]?.body).not.toContain('app.js');
  });

  it('serves only the build index and /assets, not arbitrary files in the build root', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const responses = await Promise.all([
      rawRequest(bff, '/robots.txt'),
      rawRequest(bff, '/assets/../robots.txt'),
      rawRequest(bff, '/index.html.bak'),
      rawRequest(bff, '/src/server/web-bff.ts'),
      rawRequest(bff, '/apps/web/src/server/main.ts'),
      rawRequest(bff, '/package.json'),
      rawRequest(bff, '/assetsx/app.js'),
      // Deep links are a miss, not an SPA fallback onto the document.
      rawRequest(bff, '/session/session-123'),
      rawRequest(bff, '/run/run-1/approvals'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('User-agent');
    }
  });

  it('applies the Host, Origin and Sec-Fetch-Site checks to static routes too', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);
    const port = new URL(bff.origin).port;

    const foreignOrigin = await rawRequest(bff, '/', { headers: { origin: 'https://attacker.invalid' } });
    const foreignAssetOrigin = await rawRequest(bff, '/assets/app.js', { headers: { origin: 'https://attacker.invalid' } });
    const crossSite = await rawRequest(bff, '/assets/app.js', { headers: { 'sec-fetch-site': 'cross-site' } });
    const crossSiteIndex = await rawRequest(bff, '/', { headers: { 'sec-fetch-site': 'cross-site' } });
    const sameSite = await rawRequest(bff, '/assets/app.js', { headers: { 'sec-fetch-site': 'same-origin' } });
    const mismatchedHost = await rawRequest(bff, '/', { headers: { host: `attacker.invalid:${port}` } });
    const postWithoutOrigin = await rawRequest(bff, '/', { method: 'POST' });
    const postSameOrigin = await rawRequest(bff, '/', { method: 'POST', headers: { origin: bff.origin } });
    const sameOriginGet = await rawRequest(bff, '/', { headers: { origin: bff.origin } });

    expect(foreignOrigin.status).toBe(403);
    expect(foreignAssetOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(crossSiteIndex.status).toBe(403);
    expect(mismatchedHost.status).toBe(403);
    expect(postWithoutOrigin.status).toBe(403);
    expect(postSameOrigin.status).toBe(405);
    // Same-origin and header-less reads still work: that is the normal page load.
    expect(sameSite.status).toBe(200);
    expect(sameOriginGet.status).toBe(200);
    expect(sameOriginGet.body).toBe(INDEX_HTML);
    for (const response of [foreignOrigin, crossSite, mismatchedHost]) {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('never exposes the Host bearer through served pages, assets or bootstrap', async () => {
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot);

    const index = await rawRequest(bff, '/');
    const asset = await rawRequest(bff, '/assets/app.js');
    const bootstrap = await rawRequest(bff, '/api/bootstrap');
    const bootstrapBody = JSON.parse(bootstrap.body) as Record<string, unknown>;

    expect(index.body).not.toContain(HOST_TOKEN);
    expect(asset.body).not.toContain(HOST_TOKEN);
    expect(bootstrap.body).not.toContain(HOST_TOKEN);
    expect(Object.keys(bootstrapBody).sort()).toEqual(['apiVersion', 'csrfToken']);
    expect(JSON.stringify(index.headers)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(asset.headers)).not.toContain(HOST_TOKEN);
    expect(index.headers['set-cookie']).toBeUndefined();
    expect(bootstrap.headers['set-cookie']).toBeUndefined();
  });

  it('keeps the finite API surface working on the same listener as the static build', async () => {
    const host = await startTestHost();
    const hostClient = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const session = await hostClient.create({ title: 'Static + API', mode: 'code' });
    const { staticRoot } = await createBuildFixture();
    const bff = await startBff(staticRoot, host);

    const bootstrap = await rawRequest(bff, '/api/bootstrap');
    const sessions = await rawRequest(bff, '/api/sessions');
    const index = await rawRequest(bff, '/');
    const mutationWithoutCsrf = await rawRequest(bff, '/api/runs/start', {
      method: 'POST',
      headers: { origin: bff.origin, 'content-type': 'application/json' },
    });
    const csrfToken = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
    const sessionBody = JSON.parse(sessions.body) as { sessions: readonly { session: { id: string } }[] };

    expect(bootstrap.status).toBe(200);
    expect(sessions.status).toBe(200);
    expect(sessionBody.sessions.some((item) => item.session.id === session.id)).toBe(true);
    expect(index.status).toBe(200);
    expect(index.body).toBe(INDEX_HTML);
    expect(mutationWithoutCsrf.status).toBe(403);
  });

  it('stays API-only and unchanged when no staticRoot is supplied', async () => {
    const host = await startTestHost();
    const bff = await startBff(undefined, host);

    const rootPath = await rawRequest(bff, '/');
    const asset = await rawRequest(bff, '/assets/app.js');
    const bootstrap = await rawRequest(bff, '/api/bootstrap');

    expect(rootPath.status).toBe(404);
    expect(JSON.parse(rootPath.body)).toEqual({ error: { code: 'not_found' } });
    expect(asset.status).toBe(404);
    expect(bootstrap.status).toBe(200);
  });

  it('keeps serving the API when the configured staticRoot does not exist', async () => {
    const host = await startTestHost();
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-static-'));
    roots.push(container);
    const bff = await startBff(path.join(container, 'never-built'), host);

    const rootPath = await rawRequest(bff, '/');
    const asset = await rawRequest(bff, '/assets/app.js');
    const bootstrap = await rawRequest(bff, '/api/bootstrap');

    expect(rootPath.status).toBe(404);
    expect(asset.status).toBe(404);
    expect(bootstrap.status).toBe(200);
  });
});
