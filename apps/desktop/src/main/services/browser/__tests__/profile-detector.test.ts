import { describe, it, expect, vi, beforeEach } from 'vitest';

// profile-detector reads profile metadata from the browser's Local State and
// probes cookie-db paths. Both file operations are mocked so the detection
// logic can be exercised on any host.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// cookie-importer (re-exported path helpers) calls getLogger() at module load.
vi.mock('../../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import { existsSync, readFileSync } from 'node:fs';
import { detectCookieProfiles } from '../profile-detector';

const mockedExists = vi.mocked(existsSync);
const mockedRead = vi.mocked(readFileSync);

/** Simulate a profile dir whose Network/Cookies database exists. */
/**
 * Make only `dir`'s profile look like it has a cookie database.
 *
 * The old matcher was `String(path).includes('/Default/')`, which only
 * holds for POSIX separators. `resolveCookieFilePath` builds its
 * candidates with `path.join`, so on Windows the real argument is
 * `...\Default\Network\Cookies` and the substring never matched -- the
 * case failed on windows-latest even though the code was right. Match on
 * path segments instead so the helper is separator-agnostic.
 */
function withCookieDb(dir: string) {
  const target = new RegExp(`(^|[\\\\/])${dir}([\\\\/]|$)`);
  mockedExists.mockImplementation((path) => target.test(String(path)));
}

beforeEach(() => {
  mockedExists.mockReset().mockReturnValue(true);
  mockedRead.mockReset();
});

describe('detectCookieProfiles', () => {
  it('maps info_cache display names and orders Default before Profile N', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      profile: {
        info_cache: {
          'Profile 2': { name: 'work' },
          'Profile 1': { name: 'lava' },
          'Default': { name: 'rain' },
        },
      },
    }));

    const profiles = detectCookieProfiles('chrome');
    expect(profiles.map((p) => `${p.dir}:${p.name}`)).toEqual([
      'Default:rain',
      'Profile 1:lava',
      'Profile 2:work',
    ]);
    expect(profiles.every((p) => p.cookieDbExists)).toBe(true);
  });

  it('falls back to the directory name when info_cache has no names', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      profile: { info_cache: { 'Profile 1': { gaia_name: '', user_name: null } } },
    }));
    // Only Profile 1 exists on disk, so no ghost Default entry is appended.
    withCookieDb('Profile 1');

    expect(detectCookieProfiles('chrome')).toEqual([
      expect.objectContaining({ dir: 'Profile 1', name: 'Profile 1' }),
    ]);
  });

  it('flags profiles whose cookie database is missing', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      profile: { info_cache: { 'Default': { name: 'rain' }, 'Profile 1': { name: 'empty' } } },
    }));
    withCookieDb('Default');

    const profiles = detectCookieProfiles('chrome');
    expect(profiles.find((p) => p.dir === 'Default')?.cookieDbExists).toBe(true);
    expect(profiles.find((p) => p.dir === 'Profile 1')?.cookieDbExists).toBe(false);
  });

  it('offers only the Default profile when Local State is unreadable', () => {
    mockedRead.mockImplementation(() => {
      throw new Error('denied');
    });

    const profiles = detectCookieProfiles('chrome');
    expect(profiles).toEqual([
      expect.objectContaining({ dir: 'Default', name: 'Default', cookieDbExists: true }),
    ]);
  });

  it('skips unsafe directory names that the importer would reject', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      profile: {
        info_cache: {
          'System Profile': { name: 'system' },
          '../evil': { name: 'evil' },
          'Default': { name: 'rain' },
        },
      },
    }));

    expect(detectCookieProfiles('chrome').map((p) => p.dir)).toEqual(['Default']);
  });

  it('works for the edge browser source as well', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      profile: { info_cache: { 'Default': { name: 'main' } } },
    }));

    expect(detectCookieProfiles('edge')).toEqual([
      expect.objectContaining({ browser: 'edge', dir: 'Default', name: 'main' }),
    ]);
  });
});
