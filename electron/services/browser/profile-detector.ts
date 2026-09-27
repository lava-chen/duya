/**
 * Enumerates Chromium browser profiles usable as cookie-import sources.
 *
 * Display names come from the `profile.info_cache` map in the browser's
 * Local State; directories without a readable cookie database are still
 * listed (the UI can show why they cannot be imported) but flagged, so the
 * importer itself stays the single source of truth for feasibility.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  browserUserDataPath,
  isSafeProfileName,
  resolveCookieFilePath,
} from './cookie-importer';

export type CookieSourceBrowser = 'chrome' | 'edge';

export interface DetectedBrowserProfile {
  browser: CookieSourceBrowser;
  /** Profile directory name, e.g. 'Default' or 'Profile 1' — the importer key. */
  dir: string;
  /** Human-readable profile name from info_cache, falling back to the dir. */
  name: string;
  cookieDbExists: boolean;
}

interface LocalStateProfileInfo {
  name?: unknown;
  gaia_name?: unknown;
  user_name?: unknown;
}

function profileDisplayName(info: LocalStateProfileInfo | undefined, dir: string): string {
  for (const value of [info?.name, info?.gaia_name, info?.user_name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return dir;
}

/** 'Default' sorts before 'Profile 1', 'Profile 2', ... */
function profileSortKey(dir: string): number {
  const match = /^Profile (\d+)$/.exec(dir);
  return match ? parseInt(match[1], 10) : -1;
}

export function detectCookieProfiles(browser: CookieSourceBrowser): DetectedBrowserProfile[] {
  const userDataPath = browserUserDataPath(browser);
  if (!userDataPath) return [];

  const profiles: DetectedBrowserProfile[] = [];
  const seen = new Set<string>();
  const pushProfile = (dir: string, name: string) => {
    if (seen.has(dir) || !isSafeProfileName(dir)) return;
    seen.add(dir);
    profiles.push({
      browser,
      dir,
      name,
      cookieDbExists: resolveCookieFilePath(join(userDataPath, dir)) !== null,
    });
  };

  try {
    const localState = JSON.parse(readFileSync(join(userDataPath, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, LocalStateProfileInfo> };
    };
    for (const [dir, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      pushProfile(dir, profileDisplayName(info, dir));
    }
  } catch {
    // Local State missing or unreadable — fall back to the Default profile
    // so at least one actionable choice is offered.
  }

  // Fallback when Local State is unreadable or lists no Default profile:
  // offer Default only if the directory actually exists on disk, so a
  // browser without a Default profile does not get a ghost entry.
  if (!seen.has('Default') && existsSync(join(userDataPath, 'Default'))) {
    pushProfile('Default', 'Default');
  }

  return profiles.sort((a, b) => profileSortKey(a.dir) - profileSortKey(b.dir));
}
