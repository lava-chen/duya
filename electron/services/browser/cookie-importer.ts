/**
 * Cookie Importer — reads Chrome/Edge cookies, DPAPI-decrypts values,
 * returns ElectronCookie[] for writing to Electron session partition.
 *
 * Windows only (v1). macOS Keychain support deferred.
 */

import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { getLogger, LogComponent } from '../../logging/logger';

const execFileAsync = promisify(execFile);
const logger = getLogger();

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

export interface ElectronCookie {
  url: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
}

const SAME_SITE_MAP: Record<number, 'no_restriction' | 'lax' | 'strict'> = {
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};

// Chrome epoch: 1601-01-01 00:00:00 UTC in microseconds
// Unix epoch: 1970-01-01 00:00:00 UTC in seconds
// Offset: 11644473600 seconds = 11644473600000000 microseconds
const CHROME_TO_UNIX_OFFSET = 11644473600000000;

export function mapChromeCookieToElectron(row: ChromeCookieRow, decryptedValue: string): ElectronCookie {
  const secure = row.is_secure === 1;
  return {
    url: `${secure ? 'https' : 'http'}://${row.host_key}`,
    name: row.name,
    value: decryptedValue,
    domain: row.host_key,
    path: row.path,
    secure,
    httpOnly: row.is_httponly === 1,
    expirationDate: row.expires_utc > 0
      ? Math.floor((row.expires_utc - CHROME_TO_UNIX_OFFSET) / 1000000)
      : undefined,
    sameSite: SAME_SITE_MAP[row.samesite] ?? 'no_restriction',
  };
}

export function isCookieExpired(expiresUtc: number): boolean {
  if (expiresUtc === 0) return false; // session cookie
  const unixSeconds = Math.floor((expiresUtc - CHROME_TO_UNIX_OFFSET) / 1000000);
  return unixSeconds < Math.floor(Date.now() / 1000);
}

export function getChromeCookiePath(browser: 'chrome' | 'edge'): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const browserPath = browser === 'chrome'
    ? join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies')
    : join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies');

  return existsSync(browserPath) ? browserPath : null;
}

async function decryptCookieValue(encryptedValue: Buffer): Promise<string> {
  // v10 prefix = DPAPI encrypted
  if (encryptedValue.length < 3 || encryptedValue.toString('utf8', 0, 3) !== 'v10') {
    // Not encrypted (some cookies store value in plain text)
    return encryptedValue.toString('utf8');
  }

  const encryptedData = encryptedValue.subarray(3);

  // Use PowerShell to call DPAPI Unprotect (CurrentUser scope)
  const psScript = `
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String('${encryptedData.toString('base64')}')
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($decrypted)
  `;

  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
    timeout: 5000,
    windowsHide: true,
  });

  return Buffer.from(stdout.trim(), 'base64').toString('utf8');
}

export async function readBrowserCookies(browser: 'chrome' | 'edge'): Promise<{
  cookies: ElectronCookie[];
  failed: number;
}> {
  const cookiePath = getChromeCookiePath(browser);
  if (!cookiePath) {
    throw new Error(`Cookie file not found for ${browser}. Is it installed?`);
  }

  // Copy to temp file (browser locks the original)
  const tempPath = `${cookiePath}.duya-tmp`;
  copyFileSync(cookiePath, tempPath);

  try {
    const db = new Database(tempPath, { readonly: true });
    const rows = db.prepare(
      'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
    ).all() as ChromeCookieRow[];
    db.close();

    const cookies: ElectronCookie[] = [];
    let failed = 0;

    for (const row of rows) {
      if (isCookieExpired(row.expires_utc)) continue;

      try {
        const decryptedValue = await decryptCookieValue(row.encrypted_value);
        cookies.push(mapChromeCookieToElectron(row, decryptedValue));
      } catch (err) {
        failed++;
        logger.warn(
          `Cookie decrypt failed for ${row.host_key}/${row.name}: ${err instanceof Error ? err.message : err}`,
          {},
          LogComponent.BrowserDaemon,
        );
      }
    }

    logger.info(
      `Cookie import: ${cookies.length} imported, ${failed} failed from ${browser}`,
      {},
      LogComponent.BrowserDaemon,
    );
    return { cookies, failed };
  } finally {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
  }
}
