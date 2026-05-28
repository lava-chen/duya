import { resolve, relative, normalize } from 'path';
import fs from 'fs';

export interface PathValidationResult {
  safe: boolean;
  resolvedPath?: string;
  reason?: string;
}

export class PathSafetyValidator {
  validatePathWithinBase(targetPath: string, base: string): PathValidationResult {
    const resolved = resolve(base, normalize(targetPath));

    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      realPath = resolved;
    }

    const rel = relative(base, realPath);
    if (rel.startsWith('..') || rel === '' || /^[a-zA-Z]:/.test(rel)) {
      return {
        safe: false,
        reason: `Path traversal detected: ${targetPath} resolves outside ${base}`,
      };
    }

    if (targetPath.includes('\0')) {
      return {
        safe: false,
        reason: 'Path contains null byte',
      };
    }

    if (targetPath.includes('\u0000')) {
      return {
        safe: false,
        reason: 'Path contains null byte (unicode)',
      };
    }

    return { safe: true, resolvedPath: realPath };
  }

  validatePluginPaths(
    pluginDir: string,
    paths: string[],
  ): { safe: boolean; violations: Array<{ path: string; reason: string }> } {
    const violations: Array<{ path: string; reason: string }> = [];

    for (const p of paths) {
      const result = this.validatePathWithinBase(p, pluginDir);
      if (!result.safe) {
        violations.push({ path: p, reason: result.reason! });
      }
    }

    return { safe: violations.length === 0, violations };
  }
}