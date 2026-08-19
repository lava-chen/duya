// Shared favicon resolution for external links (markdown links, browser
// tool rows, …). Resolves through the main-process `duya:link-preview` IPC
// (origin-cached there) and keeps a per-origin renderer cache on top so
// repeated links to the same site don't re-invoke the bridge.
//
// `null` means "no icon resolved" and is cached too (negative caching).
// Components decide what to render when the favicon is unavailable —
// callers keep their fallback icon.

import { useEffect, useState } from 'react';

const faviconCache = new Map<string, string | null>();

interface DuyaGlobal {
  getLinkFavicon?: (url: string) => Promise<string | null>;
}

/**
 * Resolve the favicon URL for a page, or `null` while resolving / when
 * none could be found. Per-origin cached; failures are cached as `null`.
 */
export function useLinkFavicon(url: string): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const cached = faviconCache.get(origin);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    const duya = (window as Window & { duya?: DuyaGlobal }).duya;
    duya
      ?.getLinkFavicon?.(url)
      .then((f) => {
        if (cancelled) return;
        faviconCache.set(origin, f);
        setSrc(f);
      })
      .catch(() => {
        if (cancelled) return;
        faviconCache.set(origin, null);
        setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}
