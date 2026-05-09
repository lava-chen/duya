/**
 * Proxy-aware fetch for Gateway with Fallback IP support for Telegram
 *
 * Features:
 * 1. Explicitly configured proxy URL (from Gateway init config)
 * 2. Environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY)
 * 3. Windows system proxy via registry query
 * 4. Fallback IP transport for api.telegram.org when DNS is blocked/unreachable
 *
 * Uses https-proxy-agent for HTTP/HTTPS proxy support.
 */

import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { execSync } from 'child_process';

let proxyAgent: HttpsProxyAgent<string> | undefined;
let proxyDetected = false;
let configuredProxyUrl: string | undefined;

// Issue #9: Fallback IP transport
const FALLBACK_IPS = ['149.154.167.220', '149.154.167.221'];
const TELEGRAM_API_HOST = 'api.telegram.org';
let stickyFallbackIp: string | undefined;

/**
 * Detect Windows system proxy via registry query
 */
function detectWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const enableOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x1|1)/);
    if (!enableMatch) {
      return undefined;
    }

    const serverOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const serverMatch = serverOutput.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!serverMatch) {
      return undefined;
    }

    const proxyServer = serverMatch[1];
    const httpsMatch = proxyServer.match(/https=([^;]+)/);
    if (httpsMatch) {
      return `http://${httpsMatch[1]}`;
    }
    const httpMatch = proxyServer.match(/http=([^;]+)/);
    if (httpMatch) {
      return `http://${httpMatch[1]}`;
    }
    if (proxyServer.includes(':')) {
      return `http://${proxyServer}`;
    }
  } catch {
    // Registry query failed, ignore
  }
  return undefined;
}

/**
 * Get proxy URL from environment or system settings
 */
function detectProxy(): string | undefined {
  if (configuredProxyUrl) {
    return configuredProxyUrl;
  }

  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) {
    return envProxy;
  }
  return detectWindowsSystemProxy();
}

/**
 * Set proxy URL from configuration (called by GatewayManager.init)
 */
export function setProxyUrl(url: string | undefined): void {
  configuredProxyUrl = url;
  proxyDetected = false;
  proxyAgent = undefined;
}

/**
 * Initialize proxy agent if proxy is configured
 */
export function initProxy(): void {
  if (proxyDetected) return;
  proxyDetected = true;

  const proxyUrl = detectProxy();
  if (proxyUrl) {
    proxyAgent = new HttpsProxyAgent(proxyUrl);
    console.log(`[Proxy] Using proxy: ${proxyUrl}`);
  } else {
    console.log('[Proxy] No proxy detected');
  }
}

/**
 * Get the currently effective proxy URL (configured, env, or system)
 * Returns undefined if no proxy is configured
 */
export function getEffectiveProxyUrl(): string | undefined {
  return detectProxy();
}

/**
 * Get detailed proxy status for UI display
 */
export function getProxyStatus(): {
  configured: string | undefined;
  env: string | undefined;
  system: string | undefined;
  effective: string | undefined;
} {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;

  const systemProxy = detectWindowsSystemProxy();

  return {
    configured: configuredProxyUrl,
    env: envProxy,
    system: systemProxy,
    effective: detectProxy(),
  };
}

/**
 * Issue #9: Determine which IP to connect to for api.telegram.org
 * Uses sticky fallback IP once one is found to work.
 */
function resolveTelegramHost(targetUrl: string): { host: string; ip?: string } {
  if (!targetUrl.includes(TELEGRAM_API_HOST)) {
    return { host: TELEGRAM_API_HOST };
  }

  if (stickyFallbackIp) {
    return { host: stickyFallbackIp, ip: stickyFallbackIp };
  }

  return { host: TELEGRAM_API_HOST };
}

/**
 * Issue #9: Handle connection errors with fallback IP retry for Telegram API
 */
function isTelegramApiUrl(url: string): boolean {
  return url.includes(TELEGRAM_API_HOST);
}

function handleFallbackIp(
  err: Error,
  url: string,
): Promise<{ host: string; ip?: string }> | null {
  if (!isTelegramApiUrl(url)) return null;

  const isConnectErr = (
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('ENOTFOUND') ||
    err.message.includes('getaddrinfo') ||
    err.message.includes('fetch failed') ||
    err.message.includes('socket hang up')
  );

  if (!isConnectErr) return null;

  // Try fallback IPs
  for (const ip of FALLBACK_IPS) {
    if (ip === stickyFallbackIp) continue;
    console.log(`[Proxy] Telegram API unreachable, trying fallback IP: ${ip}`);
    stickyFallbackIp = ip;
    return Promise.resolve({ host: ip, ip });
  }

  return null;
}

/**
 * Issue #16: Batch rapid outbound sends to avoid rate limits
 * Tracks pending batches per chat
 */
interface PendingBatch {
  sessionId: string;
  chatId: string;
  timer: ReturnType<typeof setTimeout>;
  texts: string[];
  resolvers: Array<(text: string) => void>;
}

const BATCH_DELAY_MS = 600; // Wait 600ms for rapid consecutive messages
const pendingBatches = new Map<string, PendingBatch>();

/**
 * Queue a text for batched sending.
 * Returns the merged text after the batch delay.
 */
export function batchSend(
  sessionId: string,
  chatId: string,
  text: string,
): Promise<string> {
  const key = `${sessionId}:${chatId}`;
  const existing = pendingBatches.get(key);

  if (existing) {
    existing.texts.push(text);
    return new Promise((resolve) => {
      existing.resolvers.push((merged: string) => resolve(merged));
    });
  }

  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      const batch = pendingBatches.get(key);
      pendingBatches.delete(key);
      const merged = batch?.texts.join('\n') ?? text;
      batch?.resolvers.forEach((r) => r(merged));
      resolve(merged);
    }, BATCH_DELAY_MS);

    pendingBatches.set(key, {
      sessionId,
      chatId,
      timer,
      texts: [text],
      resolvers: [resolve],
    });
  });
}

/**
 * Cancel a pending batch (e.g., when stream is interrupted)
 */
export function cancelBatch(sessionId: string, chatId: string): void {
  const key = `${sessionId}:${chatId}`;
  const batch = pendingBatches.get(key);
  if (batch) {
    clearTimeout(batch.timer);
    pendingBatches.delete(key);
    batch.resolvers.forEach((r) => r(''));
  }
}

/**
 * Proxy-aware fetch wrapper using https-proxy-agent
 * Issue #9: Falls back to alternative IPs when Telegram API is unreachable
 * Issue #16: Supports batched sends for rate limit management
 */
export async function proxyFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (!proxyAgent) {
    initProxy();
  }

  // Resolve Telegram API host (may return fallback IP)
  const { host: resolvedHost, ip } = resolveTelegramHost(url);
  const isTelegram = isTelegramApiUrl(url);

  if (proxyAgent) {
    return proxyFetchWithAgent(url, resolvedHost, ip, proxyAgent, init, isTelegram);
  }

  return proxyFetchDirect(url, resolvedHost, ip, init, isTelegram);
}

async function proxyFetchWithAgent(
  url: string,
  resolvedHost: string,
  ip: string | undefined,
  agent: HttpsProxyAgent<string>,
  init?: RequestInit,
  isTelegram = false,
): Promise<Response> {
  const urlObj = new URL(url);
  const targetHost = resolvedHost;

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      method: init?.method || 'GET',
      headers: init?.headers as Record<string, string>,
      agent,
      hostname: targetHost,
      // Issue #9: Preserve SNI when using fallback IP
      ...(ip ? { servername: TELEGRAM_API_HOST } : {}),
    };

    const req = https.request(urlObj, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            value.forEach(v => headers.append(key, v));
          } else if (value !== undefined) {
            headers.set(key, String(value));
          }
        }
        if (!headers.has('content-type') && data.startsWith('{')) {
          headers.set('content-type', 'application/json');
        }
        resolve(new Response(data, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || 'OK',
          headers,
        }));
      });
    });

    req.on('error', async (err) => {
      // Issue #9: Try fallback IP on connection failure
      if (isTelegram && ip) {
        const fallback = handleFallbackIp(err as Error, url);
        if (fallback) {
          try {
            const result = await fallback;
            return resolve(proxyFetchDirect(url, result.host, result.ip, init, true));
          } catch { /* fall through to reject */ }
        }
      }
      reject(err);
    });

    if (init?.body) req.write(String(init.body));
    req.end();
  });
}

async function proxyFetchDirect(
  url: string,
  resolvedHost: string,
  ip: string | undefined,
  init?: RequestInit,
  isTelegram = false,
): Promise<Response> {
  const urlObj = new URL(url);

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      method: init?.method || 'GET',
      headers: init?.headers as Record<string, string>,
      hostname: resolvedHost,
      // Issue #9: When using fallback IP, set Host header to api.telegram.org for SNI
      ...(ip ? {
        servername: TELEGRAM_API_HOST,
        headers: {
          ...(init?.headers as Record<string, string>),
          'Host': TELEGRAM_API_HOST,
        },
      } : {}),
    };

    const req = https.request(urlObj, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            value.forEach(v => headers.append(key, v));
          } else if (value !== undefined) {
            headers.set(key, String(value));
          }
        }
        if (!headers.has('content-type') && data.startsWith('{')) {
          headers.set('content-type', 'application/json');
        }
        resolve(new Response(data, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || 'OK',
          headers,
        }));
      });
    });

    req.on('error', async (err) => {
      // Issue #9: Try fallback IPs on connection failure
      if (isTelegram && !ip) {
        for (const fallbackIp of FALLBACK_IPS) {
          console.log(`[Proxy] Telegram API connection failed, trying fallback IP: ${fallbackIp}`);
          stickyFallbackIp = fallbackIp;
          try {
            return resolve(proxyFetchDirect(url, fallbackIp, fallbackIp, init, true));
          } catch { /* try next */ }
        }
      }
      reject(err);
    });

    if (init?.body) req.write(String(init.body));
    req.end();
  });
}
