/**
 * Cookie Writer — writes ElectronCookie[] to the built-in browser partition
 * (BROWSER_PARTITION, defined once in webview-memory.ts).
 */

import { session, type DownloadItem, type Event } from 'electron';
import * as path from 'path';
import { getSetting } from '../../db/queries/settings';
// Single definition of the partition string: cookie writes and the webview
// cache clear must address the SAME partition, so renaming one copy can
// never split them. `webview-memory.ts` owns it and imports nothing from
// this file, so this introduces no import cycle.
import { BROWSER_PARTITION } from './webview-memory';
import type { ElectronCookie } from './cookie-importer';

const PARTITION = BROWSER_PARTITION;

function getConfiguredDownloadPath(): string | undefined {
  const raw = getSetting('browserDownloadPath');
  return raw?.trim() || undefined;
}

export function attachBrowserDownloadHandler(): void {
  const ses = session.fromPartition(PARTITION);
  ses.on('will-download', (event: Event, item: DownloadItem) => {
    const configuredPath = getConfiguredDownloadPath();
    if (configuredPath) {
      const fileName = item.getFilename();
      item.setSavePath(path.join(configuredPath, fileName));
    }
  });
}

export async function writeCookiesToPartition(cookies: ElectronCookie[]): Promise<number> {
  const ses = session.fromPartition(PARTITION);
  let written = 0;

  for (const cookie of cookies) {
    try {
      await ses.cookies.set({
        url: cookie.url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite,
      });
      written++;
    } catch {
      // Skip cookies that fail to set (e.g. invalid domain)
    }
  }

  return written;
}

export async function clearPartitionData(): Promise<void> {
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'],
  });
}
