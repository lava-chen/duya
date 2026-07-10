/**
 * Cookie Writer — writes ElectronCookie[] to the persist:duya-local-browser partition.
 */

import { session } from 'electron';
import type { ElectronCookie } from './cookie-importer';

const PARTITION = 'persist:duya-local-browser';

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
