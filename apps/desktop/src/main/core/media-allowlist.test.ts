// Unit tests for the `duya-file://` media allowlist (plan 583, ISS-02).
//
// The regression this locks down: the protocol handler used to `readFile`
// any absolute path with no root allowlist and an
// `application/octet-stream` fallback, so model-authored markdown could
// pull `config.toml`, `secrets.json` or an SSH key out of the renderer.
//
// Both gates are asserted independently — extension and root — because
// either one alone is insufficient: `attachments` lives *under* the duya
// config root, so a blanket "deny the config root" rule would not have
// stopped a `.png`-suffixed path traversal.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  attachmentsRoot: '',
  rolloutRoot: '',
  userDataRoot: '',
  appPath: '',
  isPackaged: false,
  resourcesPath: '',
  tmpRoot: '',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'userData') return mocks.userDataRoot;
      throw new Error(`unexpected getPath(${name})`);
    },
    getAppPath: () => mocks.appPath,
  },
}));

vi.mock('../config/boot-config', () => ({
  resolveAttachmentsRoot: () => mocks.attachmentsRoot,
  resolveRolloutRoot: () => mocks.rolloutRoot,
}));

// `os.tmpdir()` is one of the allowed roots, so the fake app roots must live
// OUTSIDE it or the escape assertions below would be vacuous. Mock it to a
// dedicated directory and build the app roots from the real temp location.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const tmpdir = () => mocks.tmpRoot;
  return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

// Imported after the mocks so the module picks up the stubbed roots.
import { checkMediaPath, getMediaRoots } from './media-allowlist';

const realTemp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(realTemp, 'duya-media-allowlist-'));
  mocks.tmpRoot = path.join(tmpBase, 'os-tmp');
  mocks.attachmentsRoot = path.join(tmpBase, 'attachments');
  mocks.rolloutRoot = path.join(tmpBase, 'rollout');
  mocks.userDataRoot = path.join(tmpBase, 'userData');
  mocks.appPath = path.join(tmpBase, 'appPath');
  mocks.isPackaged = false;
  mocks.resourcesPath = path.join(tmpBase, 'resources');
  for (const dir of [
    mocks.tmpRoot,
    mocks.attachmentsRoot,
    mocks.rolloutRoot,
    mocks.userDataRoot,
    mocks.appPath,
    mocks.resourcesPath,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** Create a real file so realpath-based containment can be exercised. */
function seed(root: string, rel: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  return full;
}

describe('getMediaRoots', () => {
  it('includes attachments, rollout and userData', () => {
    const roots = getMediaRoots();
    expect(roots).toContain(mocks.attachmentsRoot);
    expect(roots).toContain(mocks.rolloutRoot);
    expect(roots).toContain(mocks.userDataRoot);
  });

  it('includes the OS temp dir so tool scratch output still renders', () => {
    expect(getMediaRoots()).toContain(mocks.tmpRoot);
  });

  it('allows a screenshot written to the OS temp dir', () => {
    // This is the real motivating case: markdownComponents.tsx documents a
    // `C:/Users/<u>/AppData/Local/Temp/blender_screenshot_v1.png` ref.
    const shot = seed(mocks.tmpRoot, 'blender_screenshot_v1.png');
    expect(checkMediaPath(shot)).toEqual({ allowed: true, mimeType: 'image/png' });
  });
});

describe('checkMediaPath — the P0 regression', () => {
  it('refuses config.toml even though it sits beside the allowed roots', () => {
    // The duya config root is the PARENT of attachments, so this file is
    // only stopped by the extension gate.
    const configPath = seed(tmpBase, 'config.toml');
    const decision = checkMediaPath(configPath);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('bad-extension');
  });

  it('refuses secrets.json', () => {
    const secrets = seed(mocks.attachmentsRoot, '..' + path.sep + 'secrets.json');
    const decision = checkMediaPath(secrets);
    expect(decision.allowed).toBe(false);
  });

  it('refuses a private SSH key outside every root', () => {
    const key = seed(path.join(tmpBase, 'ssh'), 'id_rsa');
    const decision = checkMediaPath(key);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('bad-extension');
  });

  it('refuses a media-named file that escapes the roots via ..', () => {
    const escape = path.join(mocks.attachmentsRoot, '..', '..', 'escaped.png');
    fs.mkdirSync(path.dirname(escape), { recursive: true });
    fs.writeFileSync(escape, 'x');
    const decision = checkMediaPath(escape);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('outside-roots');
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    // `<attachments>-evil` must not pass a naive startsWith check.
    const sibling = path.join(tmpBase, 'attachments-evil');
    fs.mkdirSync(sibling, { recursive: true });
    const png = path.join(sibling, 'shot.png');
    fs.writeFileSync(png, 'x');
    const decision = checkMediaPath(png);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('outside-roots');
  });
});

describe('checkMediaPath — legitimate media still works', () => {
  it('allows a .png under the attachments root', () => {
    const png = seed(mocks.attachmentsRoot, 'shot.png');
    expect(checkMediaPath(png)).toEqual({ allowed: true, mimeType: 'image/png' });
  });

  it('allows .jpg / .jpeg and reports the right mime', () => {
    const jpg = seed(mocks.attachmentsRoot, 'a.jpg');
    expect(checkMediaPath(jpg)).toEqual({ allowed: true, mimeType: 'image/jpeg' });
    const jpeg = seed(mocks.attachmentsRoot, 'b.jpeg');
    expect(checkMediaPath(jpeg)).toEqual({ allowed: true, mimeType: 'image/jpeg' });
  });

  it('allows video under the rollout root (markdown inline <video>)', () => {
    const mp4 = seed(mocks.rolloutRoot, 'clip.mp4');
    expect(checkMediaPath(mp4)).toEqual({ allowed: true, mimeType: 'video/mp4' });
  });

  it('allows a .pdf under the attachments root', () => {
    const pdf = seed(mocks.attachmentsRoot, 'doc.pdf');
    expect(checkMediaPath(pdf)).toEqual({ allowed: true, mimeType: 'application/pdf' });
  });

  it('is case-insensitive about the extension', () => {
    const upper = seed(mocks.attachmentsRoot, 'SHOT.PNG');
    expect(checkMediaPath(upper)).toEqual({ allowed: true, mimeType: 'image/png' });
  });

  it('drops the removed .txt / .md passthrough types', () => {
    // These were served as text/plain and text/markdown before ISS-02; they
    // are how a config file could be read straight out of a markdown ref.
    const txt = seed(mocks.attachmentsRoot, 'notes.txt');
    expect(checkMediaPath(txt).allowed).toBe(false);
    const md = seed(mocks.attachmentsRoot, 'readme.md');
    expect(checkMediaPath(md).allowed).toBe(false);
  });
});

describe('checkMediaPath — real in-app consumers keep working', () => {
  // These exist because the first version of this allowlist only listed the
  // user-data roots and would have 404'd the app icon, plugin icons and
  // conductor assets. A test that exercises the allowlist in isolation
  // cannot catch that; these pin the actual call sites that build
  // `duya-file://` URLs.
  it('allows the bundled splash icon resolved by app:get-asset-url', () => {
    // system-handlers.ts:483 -> path.join(app.getAppPath(), 'public', 'icon.png')
    const icon = seed(mocks.appPath, 'public/icon.png');
    expect(checkMediaPath(icon)).toEqual({ allowed: true, mimeType: 'image/png' });
  });

  it('allows a plugin icon resolved from the installed plugin tree', () => {
    // catalog.ts:69 resolves `interface.icon` (e.g. ./assets/icon.svg) out
    // of userData/plugins/installed or plugins/cache.
    const icon = seed(mocks.userDataRoot, 'plugins/installed/acme/assets/icon.svg');
    expect(checkMediaPath(icon)).toEqual({ allowed: true, mimeType: 'image/svg+xml' });
  });

  it('allows a plugin icon resolved from the marketplace cache', () => {
    const icon = seed(mocks.userDataRoot, 'plugins/cache/community/acme/0.1.0/icon.png');
    expect(checkMediaPath(icon)).toEqual({ allowed: true, mimeType: 'image/png' });
  });

  it('allows a conductor asset served from the app directory', () => {
    // conductor/asset-service.ts:52-55 builds a duya-file URL for a path the
    // caller resolved inside the app's own assets.
    const asset = seed(mocks.appPath, 'conductor-assets/board.png');
    expect(checkMediaPath(asset)).toEqual({ allowed: true, mimeType: 'image/png' });
  });

  it('still refuses a non-media file inside the app directory', () => {
    // The app root is allowed, but the extension gate is the primary control
    // — in dev app.getAppPath() is the repo root, so only media is reachable.
    const source = seed(mocks.appPath, 'electron/main.ts');
    expect(checkMediaPath(source).allowed).toBe(false);
  });
});

describe('checkMediaPath — input hardening', () => {
  it('refuses a relative path', () => {
    const decision = checkMediaPath('shot.png');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('not-absolute');
  });

  it('refuses an empty path', () => {
    expect(checkMediaPath('').allowed).toBe(false);
  });
});
