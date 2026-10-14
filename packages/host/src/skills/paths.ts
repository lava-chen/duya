import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve bundled skill assets for workers and Host services.
 *
 * Callers that compose a worker with an explicit asset location should pass it
 * as `bundledSkillsRoot`. The relative candidates preserve the existing ESM,
 * worker-bundle, and packaged Electron layouts during the assembly migration.
 */
export function getBundledSkillsDir(bundledSkillsRoot?: string): string {
  if (bundledSkillsRoot && bundledSkillsRoot.trim().length > 0) {
    return path.resolve(bundledSkillsRoot);
  }

  try {
    const modulePath = fileURLToPath(new URL(import.meta.url));
    const moduleDir = path.dirname(modulePath);
    const candidates = [
      // Self-contained worker bundle: assets travel beside the executable.
      path.resolve(moduleDir, 'skills'),
      // Package asset root beside the compiled Host package.
      path.resolve(moduleDir, '..', '..', 'skills'),
      // Packaged Electron worker bundle: resources/agent-bundle -> resources/agent/skills.
      path.resolve(moduleDir, '..', 'agent', 'skills'),
      // Existing bundled worker layout: bundle -> sibling skills directory.
      path.resolve(moduleDir, '..', 'skills'),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
  } catch {
    const candidates = [
      path.resolve(process.cwd(), 'resources', 'agent', 'skills'),
      path.resolve(process.cwd(), '..', 'skills'),
      path.resolve(process.cwd(), 'skills'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
  }
}
