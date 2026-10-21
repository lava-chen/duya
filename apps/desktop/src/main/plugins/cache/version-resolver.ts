import { execSync } from 'child_process';
import type { PluginManifest } from '../types';

export function resolvePluginVersion(
  sourceDir: string,
  manifest?: PluginManifest
): string {
  if (manifest?.version && manifest.version !== '0.0.0') {
    return manifest.version;
  }

  const gitTag = tryGetGitTag(sourceDir);
  if (gitTag) return gitTag;

  const gitSha = tryGetGitShortSha(sourceDir);
  if (gitSha) return gitSha;

  const timestamp = Date.now().toString(36);
  return `unknown-${timestamp}`;
}

function tryGetGitTag(dir: string): string | null {
  try {
    const tag = execSync('git describe --tags --exact-match 2>nul', {
      cwd: dir,
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim();
    return tag || null;
  } catch {
    return null;
  }
}

function tryGetGitShortSha(dir: string): string | null {
  try {
    const sha = execSync('git rev-parse --short HEAD 2>nul', {
      cwd: dir,
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim();
    if (sha.length >= 7) return sha;
    return null;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;

  if (a === 'unknown' || a.startsWith('unknown-')) return -1;
  if (b === 'unknown' || b.startsWith('unknown-')) return 1;

  const aIsSha = /^[0-9a-f]{7,40}$/i.test(a);
  const bIsSha = /^[0-9a-f]{7,40}$/i.test(b);

  if (aIsSha && !bIsSha) return -1;
  if (!aIsSha && bIsSha) return 1;
  if (aIsSha && bIsSha) return a.localeCompare(b);

  try {
    const aParts = parseSemverSafe(a);
    const bParts = parseSemverSafe(b);

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aNum = aParts[i] ?? 0;
      const bNum = bParts[i] ?? 0;
      if (aNum !== bNum) return aNum - bNum;
    }
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

function parseSemverSafe(version: string): number[] {
  const cleaned = version.replace(/^[vV]/, '');
  const parts = cleaned.split('.');
  return parts.map((p) => {
    const num = parseInt(p, 10);
    if (isNaN(num)) return 0;
    return num;
  });
}

export function isVersionNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function pickLatestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((latest, v) =>
    compareVersions(v, latest) > 0 ? v : latest
  );
}