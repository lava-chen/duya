/**
 * Shared helper for platform extractors that source data from public HTTP APIs
 * (Wikipedia REST, Hacker News Firebase, PubMed E-utilities, …).
 *
 * Uses Node-side `fetch` directly instead of the in-page context, so these
 * extractors are not subject to the page's CORS policy / CSP.
 */

export interface PublicFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function publicFetchJson<T>(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<PublicFetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'duya-agent/1.0',
        Accept: 'application/json',
      },
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!text) {
      return { ok: res.ok, status: res.status, data: null };
    }
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, status: res.status, data: null, error: 'Invalid JSON response' };
    }
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}