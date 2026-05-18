import https from 'https';
import HttpsProxyAgent = require('https-proxy-agent');
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

  return detectWindowsSystemProxy();
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