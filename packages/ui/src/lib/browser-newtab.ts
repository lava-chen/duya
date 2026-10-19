/**
 * Renderer-side store for the built-in browser's new-tab page:
 * a favorites bar and recent-history cards (plan 573 Phase 2b).
 *
 * Persisted in localStorage on purpose — the core-db history table
 * (plan 573 Phase 3) will migrate this data later; until then the
 * new-tab page must work without a schema migration or IPC surface.
 * The shapes below are the migration contract.
 */

export interface BrowserVisit {
  url: string;
  title: string;
  favicon?: string;
  ts: number;
}

const HISTORY_KEY = 'duya.browser.history.v1';
const FAVORITES_KEY = 'duya.browser.favorites.v1';
export const HISTORY_LIMIT = 60;
export const FAVORITES_LIMIT = 20;

/** Only real page navigations belong in history/favorites. */
export function isRecordableUrl(url: string): boolean {
  if (!url) return false;
  if (url === 'about:blank') return false;
  return /^(https?|file):\/\//i.test(url);
}

function readList(key: string): BrowserVisit[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BrowserVisit =>
        !!item &&
        typeof (item as BrowserVisit).url === 'string' &&
        typeof (item as BrowserVisit).title === 'string' &&
        typeof (item as BrowserVisit).ts === 'number',
    );
  } catch {
    return [];
  }
}

function writeList(key: string, list: BrowserVisit[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage may be unavailable (private mode / quota) — the page
    // degrades to an empty state rather than crashing the panel.
  }
}

export function listHistory(): BrowserVisit[] {
  return readList(HISTORY_KEY);
}

export function listFavorites(): BrowserVisit[] {
  return readList(FAVORITES_KEY);
}

/** Record one page visit: dedupe by URL (newest wins), cap the list. */
export function recordVisit(visit: Omit<BrowserVisit, 'ts'>): BrowserVisit[] {
  if (!isRecordableUrl(visit.url)) return listHistory();
  const rest = listHistory().filter((item) => item.url !== visit.url);
  const next = [{ ...visit, ts: Date.now() }, ...rest].slice(0, HISTORY_LIMIT);
  writeList(HISTORY_KEY, next);
  return next;
}

export function isFavorited(url: string): boolean {
  return listFavorites().some((item) => item.url === url);
}

/** Toggle a favorite; returns the new list and whether it is now favorited. */
export function toggleFavorite(visit: Omit<BrowserVisit, 'ts'>): { favorites: BrowserVisit[]; favorited: boolean } {
  const current = listFavorites();
  const existing = current.find((item) => item.url === visit.url);
  if (existing) {
    const next = current.filter((item) => item.url !== visit.url);
    writeList(FAVORITES_KEY, next);
    return { favorites: next, favorited: false };
  }
  const next = [{ ...visit, ts: Date.now() }, ...current].slice(0, FAVORITES_LIMIT);
  writeList(FAVORITES_KEY, next);
  return { favorites: next, favorited: true };
}

export function removeFavorite(url: string): BrowserVisit[] {
  const next = listFavorites().filter((item) => item.url !== url);
  writeList(FAVORITES_KEY, next);
  return next;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // same degradation as writeList
  }
}
