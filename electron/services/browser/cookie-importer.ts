/**
 * Imports Chrome/Edge cookies into the Electron browser partition.
 *
 * This supports Chromium's legacy DPAPI records and v10/v11 AES-GCM records.
 * v20 app-bound records deliberately remain unsupported: Chrome binds those
 * records to its installed application and bypassing that protection is not a
 * valid import strategy.
 */

import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
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

export interface LiveBrowserCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  expirationDate?: unknown;
  sameSite?: unknown;
}

export interface BrowserCookieSource {
  browser: 'chrome' | 'edge';
  profile: string;
  cookiePath: string;
  localStatePath: string;
}

export interface CookieImportResult {
  cookies: ElectronCookie[];
  failed: number;
  unsupported: number;
}

export class CookieDatabaseBusyError extends Error {
  readonly code = 'COOKIE_DATABASE_BUSY';

  constructor() {
    super('The browser cookie database is currently in use.');
    this.name = 'CookieDatabaseBusyError';
  }
}

const SAME_SITE_MAP: Record<number, 'no_restriction' | 'lax' | 'strict'> = {
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};
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

/**
 * Validate and map cookies returned by the verified browser extension. This
 * path is used only when Windows prevents a read-only SQLite snapshot of a
 * running Chromium profile; cookie values are never logged or written to disk.
 */
export function mapLiveBrowserCookies(cookies: unknown[]): ElectronCookie[] {
  const mapped: ElectronCookie[] = [];
  for (const rawCookie of cookies) {
    const cookie = rawCookie as LiveBrowserCookie;
    if (
      !cookie ||
      typeof cookie.name !== 'string' ||
      typeof cookie.value !== 'string' ||
      typeof cookie.domain !== 'string' ||
      !cookie.domain ||
      typeof cookie.path !== 'string'
    ) continue;

    const secure = cookie.secure === true;
    const sameSite = cookie.sameSite === 'lax' || cookie.sameSite === 'strict'
      ? cookie.sameSite
      : 'no_restriction';
    const expirationDate = typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
      ? cookie.expirationDate
      : undefined;
    if (expirationDate !== undefined && expirationDate < Date.now() / 1000) continue;

    mapped.push({
      url: `${secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure,
      httpOnly: cookie.httpOnly === true,
      expirationDate,
      sameSite,
    });
  }
  return mapped;
}

export function isCookieExpired(expiresUtc: number): boolean {
  if (expiresUtc === 0) return false;
  const unixSeconds = Math.floor((expiresUtc - CHROME_TO_UNIX_OFFSET) / 1000000);
  return unixSeconds < Math.floor(Date.now() / 1000);
}

function browserUserDataPath(browser: 'chrome' | 'edge'): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return browser === 'chrome'
    ? join(localAppData, 'Google', 'Chrome', 'User Data')
    : join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

function isSafeProfileName(profile: string): boolean {
  return profile === 'Default' || /^Profile \d+$/.test(profile) || profile === 'Guest Profile';
}

export function getBrowserCookieSource(
  browser: 'chrome' | 'edge',
  profile = 'Default',
): BrowserCookieSource | null {
  if (!isSafeProfileName(profile)) return null;
  const userDataPath = browserUserDataPath(browser);
  if (!userDataPath) return null;
  const cookiePath = join(userDataPath, profile, 'Network', 'Cookies');
  const localStatePath = join(userDataPath, 'Local State');
  if (!existsSync(cookiePath) || !existsSync(localStatePath)) return null;
  return { browser, profile, cookiePath, localStatePath };
}

async function unprotectDpapi(encryptedData: Buffer): Promise<Buffer> {
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
  return Buffer.from(stdout.trim(), 'base64');
}

async function getChromiumEncryptionKey(localStatePath: string): Promise<Buffer> {
  const localState = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encodedKey = localState.os_crypt?.encrypted_key;
  if (!encodedKey) throw new Error('Chrome profile has no os_crypt encrypted_key');
  const encryptedKey = Buffer.from(encodedKey, 'base64');
  const dpapiPrefix = Buffer.from('DPAPI');
  if (!encryptedKey.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) {
    throw new Error('Unsupported Chromium encryption-key format');
  }
  return unprotectDpapi(encryptedKey.subarray(dpapiPrefix.length));
}

export async function decryptCookieValue(encryptedValue: Buffer, encryptionKey: Buffer | null): Promise<string> {
  const version = encryptedValue.subarray(0, 3).toString('utf8');
  if (version === 'v20') throw new Error('APP_BOUND_ENCRYPTION');
  if (version === 'v10' || version === 'v11') {
    if (!encryptionKey) throw new Error('Missing Chromium AES encryption key');
    const nonceLength = 12;
    const tagLength = 16;
    if (encryptedValue.length <= 3 + nonceLength + tagLength) throw new Error('Malformed Chromium AES cookie');
    const nonceStart = 3;
    const ciphertextEnd = encryptedValue.length - tagLength;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      encryptedValue.subarray(nonceStart, nonceStart + nonceLength),
    );
    decipher.setAuthTag(encryptedValue.subarray(ciphertextEnd));
    return Buffer.concat([
      decipher.update(encryptedValue.subarray(nonceStart + nonceLength, ciphertextEnd)),
      decipher.final(),
    ]).toString('utf8');
  }
  return (await unprotectDpapi(encryptedValue)).toString('utf8');
}

function isCookieDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'SQLITE_BUSY' || code === 'SQLITE_CANTOPEN';
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function copyCookieFile(source: string, destination: string, optional = false): Promise<void> {
  const retryDelays = [0, 150, 350, 700];
  let lastError: unknown;

  for (const delay of retryDelays) {
    if (delay > 0) await waitFor(delay);
    try {
      await copyFile(source, destination);
      return;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      lastError = error;
      if (!isCookieDatabaseBusyError(error)) throw error;
    }
  }

  throw lastError;
}

async function copyCookieDatabase(cookiePath: string): Promise<{ tempPath: string; tempDirectory: string }> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'duya-cookie-import-'));
  const tempPath = join(tempDirectory, 'Cookies');
  try {
    await copyCookieFile(cookiePath, tempPath);
    for (const suffix of ['-wal', '-shm']) {
      await copyCookieFile(`${cookiePath}${suffix}`, `${tempPath}${suffix}`, true);
    }
    return { tempPath, tempDirectory };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readCookieRows(
  Database: typeof import('better-sqlite3').default,
  databasePath: string,
): ChromeCookieRow[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 2000 });
  try {
    return db.prepare(
      'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
    ).all() as ChromeCookieRow[];
  } finally {
    db.close();
  }
}

export async function readBrowserCookies(
  browser: 'chrome' | 'edge',
  profile = 'Default',
): Promise<CookieImportResult> {
  const source = getBrowserCookieSource(browser, profile);
  if (!source) throw new Error(`Cookie profile not found for ${browser}/${profile}.`);

  const { default: Database } = await import('better-sqlite3');
  let tempDirectory: string | null = null;
  try {
    let rows: ChromeCookieRow[];
    try {
      // SQLite can often take a read snapshot while Chromium is running. This
      // avoids a file copy and is the fastest, most reliable import path.
      rows = readCookieRows(Database, source.cookiePath);
    } catch (directReadError) {
      try {
        const snapshot = await copyCookieDatabase(source.cookiePath);
        tempDirectory = snapshot.tempDirectory;
        rows = readCookieRows(Database, snapshot.tempPath);
      } catch (snapshotError) {
        if (isCookieDatabaseBusyError(directReadError) || isCookieDatabaseBusyError(snapshotError)) {
          throw new CookieDatabaseBusyError();
        }
        throw snapshotError;
      }
    }

    let encryptionKey: Buffer | null = null;
    try {
      encryptionKey = await getChromiumEncryptionKey(source.localStatePath);
    } catch (err) {
      logger.warn(`Cookie import could not read Chromium encryption key: ${err instanceof Error ? err.message : err}`, {}, LogComponent.BrowserDaemon);
    }

    const cookies: ElectronCookie[] = [];
    let failed = 0;
    let unsupported = 0;
    for (const row of rows) {
      if (isCookieExpired(row.expires_utc)) continue;
      try {
        const value = row.value || await decryptCookieValue(row.encrypted_value, encryptionKey);
        cookies.push(mapChromeCookieToElectron(row, value));
      } catch (err) {
        if (err instanceof Error && err.message === 'APP_BOUND_ENCRYPTION') {
          unsupported++;
          continue;
        }
        failed++;
        logger.warn(`Cookie decrypt failed for ${row.host_key}/${row.name}: ${err instanceof Error ? err.message : err}`, {}, LogComponent.BrowserDaemon);
      }
    }

    logger.info(`Cookie import: ${cookies.length} imported, ${failed} failed, ${unsupported} unsupported from ${browser}/${profile}`, {}, LogComponent.BrowserDaemon);
    return { cookies, failed, unsupported };
  } finally {
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch {
        // Temporary snapshot cleanup is best effort.
      }
    }
  }
}
