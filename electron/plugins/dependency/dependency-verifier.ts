import { getLogger, LogComponent } from '../../logging/logger';
import type {
  PluginDependency,
  DependencyVerificationResult,
  InstalledPluginInfoV2,
  InstalledPluginsFileV2,
} from '../types';

const COMPONENT = 'DependencyVerifier' as LogComponent;

let _logger: ReturnType<typeof getLogger> | null = null;

function getLog(): ReturnType<typeof getLogger> {
  if (!_logger) {
    try {
      _logger = getLogger();
    } catch {
      _logger = null as unknown as ReturnType<typeof getLogger>;
    }
  }
  return _logger!;
}

function parseSemver(version: string): number[] | null {
  const cleaned = version.replace(/^[vV~^>=<\s]+/, '');
  const parts = cleaned.split('.');
  const nums = parts.map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? null : n;
  });

  if (nums.every((n) => n !== null)) {
    return nums as number[];
  }

  return null;
}

function satisfiesVersion(
  installed: string,
  required: string
): boolean {
  if (!required || required === '*') {
    return true;
  }

  const installedParts = parseSemver(installed);
  if (!installedParts) {
    return false;
  }

  if (/^[\d.]+$/.test(required)) {
    const requiredParts = parseSemver(required);
    if (!requiredParts) return false;

    for (let i = 0; i < Math.max(installedParts.length, requiredParts.length); i++) {
      const a = installedParts[i] ?? 0;
      const b = requiredParts[i] ?? 0;
      if (a !== b) return false;
    }
    return true;
  }

  if (required.startsWith('>=')) {
    const minVer = required.slice(2).trim();
    const minParts = parseSemver(minVer);
    if (!minParts) return false;
    return compareParts(installedParts, minParts) >= 0;
  }

  if (required.startsWith('^')) {
    const baseVer = required.slice(1).trim();
    const baseParts = parseSemver(baseVer);
    if (!baseParts) return false;
    // ^1.2.3 means >=1.2.3 <2.0.0
    const maxParts = [baseParts[0] + 1, 0, 0];
    return (
      compareParts(installedParts, baseParts) >= 0 &&
      compareParts(installedParts, maxParts) < 0
    );
  }

  if (required.startsWith('~')) {
    const baseVer = required.slice(1).trim();
    const baseParts = parseSemver(baseVer);
    if (!baseParts) return false;
    // ~1.2.3 means >=1.2.3 <1.3.0
    const maxParts = [baseParts[0] ?? 0, (baseParts[1] ?? 0) + 1, 0];
    return (
      compareParts(installedParts, baseParts) >= 0 &&
      compareParts(installedParts, maxParts) < 0
    );
  }

  if (required.startsWith('>')) {
    const minVer = required.slice(1).trim();
    const minParts = parseSemver(minVer);
    if (!minParts) return false;
    return compareParts(installedParts, minParts) > 0;
  }

  return installed === required;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function verifyAndDemote(
  pluginId: string,
  deps: PluginDependency[],
  installedFile: InstalledPluginsFileV2
): DependencyVerificationResult {
  const log = getLog();
  const missing: PluginDependency[] = [];
  const downgraded: string[] = [];

  for (const dep of deps) {
    const installed = installedFile.plugins[dep.name];

    if (!installed) {
      missing.push(dep);
      if (log) log.warn(`Plugin "${pluginId}" missing dependency "${dep.name}"`, { dep }, COMPONENT);
      continue;
    }

    if (dep.version && !satisfiesVersion(installed.version, dep.version)) {
      const msg = `${dep.name}: ${installed.version} → need ${dep.version}`;
      downgraded.push(msg);
      if (log) log.warn(`Plugin "${pluginId}" dependency version mismatch: ${msg}`, {}, COMPONENT);
    }
  }

  return {
    satisfied: missing.length === 0 && downgraded.length === 0,
    missing,
    downgraded,
  };
}

export function checkUninstallDependents(
  pluginId: string,
  installedFile: InstalledPluginsFileV2
): string[] {
  const dependents: string[] = [];

  for (const [key, info] of Object.entries(installedFile.plugins)) {
    if (key === pluginId) continue;

    const deps = getAllDependenciesForPlugin(key, installedFile);
    const hasDep = deps.some((d) => d.name === pluginId);
    if (hasDep) {
      dependents.push(key);
    }
  }

  return dependents;
}

export function getAllDependenciesForPlugin(
  _pluginId: string,
  _installedFile: InstalledPluginsFileV2
): PluginDependency[] {
  return [];
}

export function getDependencyTree(
  pluginId: string,
  installedFile: InstalledPluginsFileV2,
  visited: Set<string> = new Set()
): Map<string, InstalledPluginInfoV2> {
  const tree = new Map<string, InstalledPluginInfoV2>();

  if (visited.has(pluginId)) return tree;
  visited.add(pluginId);

  const info = installedFile.plugins[pluginId];
  if (!info) return tree;

  tree.set(pluginId, info);

  const deps = getAllDependenciesForPlugin(pluginId, installedFile);
  for (const dep of deps) {
    const subTree = getDependencyTree(dep.name, installedFile, visited);
    for (const [key, val] of subTree) {
      if (!tree.has(key)) {
        tree.set(key, val);
      }
    }
  }

  return tree;
}

export function detectCircularDependency(
  pluginId: string,
  deps: PluginDependency[],
  installedFile: InstalledPluginsFileV2,
  visited: Set<string> = new Set()
): string[] | null {
  if (visited.has(pluginId)) {
    return [pluginId, ...visited];
  }

  visited.add(pluginId);

  for (const dep of deps) {
    const cycle = detectCircularDependency(
      dep.name,
      getAllDependenciesForPlugin(dep.name, installedFile),
      installedFile,
      new Set(visited)
    );
    if (cycle) return cycle;
  }

  return null;
}