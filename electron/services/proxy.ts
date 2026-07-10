import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getDatabase } from '../ipc/db-handlers';

export function detectWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const { execSync } = require('child_process');
    const enableOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/);
    if (!enableMatch) return undefined;

    const serverOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const serverMatch = serverOutput.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!serverMatch) return undefined;

    const proxyServer = serverMatch[1];
    const httpsMatch = proxyServer.match(/https=([^;]+)/);
    if (httpsMatch) return `http://${httpsMatch[1]}`;
    const httpMatch = proxyServer.match(/http=([^;]+)/);
    if (httpMatch) return `http://${httpMatch[1]}`;
    if (proxyServer.includes(':')) return `http://${proxyServer}`;
  } catch {
    // Ignore registry query errors
  }
  return undefined;
}

/**
 * Detect the system proxy configured in macOS System Settings
 * (Network > Proxies). Uses `scutil --proxy`, the documented way to read
 * the resolved system proxy configuration on macOS. Returns an
 * `http://host:port` URL when an HTTP/HTTPS proxy is enabled, otherwise
 * undefined.
 */
export function detectMacOSSystemProxy(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    const { execSync } = require('child_process');
    const output = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 });

    // scutil --proxy emits a dictionary like:
    //   HTTPEnable : 1
    //   HTTPPort : 8080
    //   HTTPProxy : 127.0.0.1
    //   HTTPSEnable : 1
    //   HTTPSPort : 8080
    //   HTTPSProxy : 127.0.0.1
    // Prefer the HTTPS proxy when enabled, then fall back to HTTP.
    const get = (key: string): string | undefined => {
      const m = output.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
      return m ? m[1] : undefined;
    };
    const httpsEnabled = get('HTTPSEnable') === '1';
    if (httpsEnabled) {
      const host = get('HTTPSProxy');
      const port = get('HTTPSPort');
      if (host) return `http://${host}${port ? ':' + port : ''}`;
    }
    const httpEnabled = get('HTTPEnable') === '1';
    if (httpEnabled) {
      const host = get('HTTPProxy');
      const port = get('HTTPPort');
      if (host) return `http://${host}${port ? ':' + port : ''}`;
    }
  } catch {
    // Ignore scutil errors (e.g. non-interactive session without config)
  }
  return undefined;
}

export function detectProxy(): string | undefined {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return envProxy;

  try {
    const db = getDatabase();
    if (db) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_proxy_url'").get() as { value: string } | undefined;
      if (row?.value) return row.value;
    }
  } catch {
    // Database not available, ignore
  }

  return detectWindowsSystemProxy() || detectMacOSSystemProxy();
}

export function proxyRequest(
  url: string,
  options: https.RequestOptions & { body?: string }
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const proxyUrl = detectProxy();
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const req = https.request(url, { ...options, agent }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}