/**
 * Network environment detection
 *
 * Determines whether the machine sits behind the mainland-China firewall
 * ('domestic') or has unrestricted global access ('overseas'). The result
 * drives deterministic search-engine selection for the `search` operation
 * and the engine guidance block in the browser tool prompt.
 *
 * Design:
 * - Probe endpoints return tiny/no bodies (generate_204, favicon) to keep cost low.
 * - Result is cached process-wide with a TTL; concurrent callers share one probe.
 * - Any ambiguity degrades conservatively to 'unknown' (engine chain falls back
 *   through every engine anyway).
 */

import axios from 'axios';
import type { NetworkEnvironment } from './types.js';

const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;

let cachedEnv: NetworkEnvironment | null = null;
let cachedAt = 0;
let inflight: Promise<NetworkEnvironment> | null = null;

async function probe(url: string): Promise<boolean> {
  try {
    await axios.get(url, {
      timeout: PROBE_TIMEOUT_MS,
      // 204 responses have no body; validateStatus accepts them plus normal 2xx/3xx/4xx
      // (a 4xx from the endpoint still proves the network path is open).
      validateStatus: status => status > 0 && status < 500,
      maxRedirects: 2,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; duya/1.0)' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the current network environment.
 * Idempotent and cached; safe to call before every search operation.
 */
export async function detectNetworkEnvironment(): Promise<NetworkEnvironment> {
  if (cachedEnv !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedEnv;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    // Google's connectivity-check endpoint: unreachable from mainland China.
    const googleReachable = await probe('https://www.google.com/generate_204');
    let env: NetworkEnvironment;
    if (googleReachable) {
      env = 'overseas';
    } else {
      const baiduReachable = await probe('https://www.baidu.com/');
      env = baiduReachable ? 'domestic' : 'unknown';
    }
    cachedEnv = env;
    cachedAt = Date.now();
    return env;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Test hook: reset the module-level cache. */
export function resetNetworkEnvironmentCache(): void {
  cachedEnv = null;
  cachedAt = 0;
  inflight = null;
}

/** Test hook: seed the cache. */
export function setNetworkEnvironmentForTest(env: NetworkEnvironment): void {
  cachedEnv = env;
  cachedAt = Date.now();
}
