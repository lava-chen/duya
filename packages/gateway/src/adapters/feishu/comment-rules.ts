// @ts-nocheck
/**
 * Feishu Comment Rules
 *
 * Access control rules for document comments.
 * Supports 3-layer fallback: exact match > wildcard > top-level > defaults
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

interface RuleConfig {
  enabled?: boolean;
  policy?: 'allowlist' | 'pairing' | 'disabled';
  allow_from?: string[];
}

interface ResolvedRule {
  enabled: boolean;
  policy: 'allowlist' | 'pairing' | 'disabled';
  allowFrom: string[];
}

interface CommentsConfig {
  enabled?: boolean;
  policy?: 'allowlist' | 'pairing' | 'disabled';
  allow_from?: string[];
  rules?: Record<string, RuleConfig>;
}

const RULE_DEFAULTS: ResolvedRule = {
  enabled: false,
  policy: 'disabled',
  allowFrom: [],
};

/** Get the pairing file path */
export function getPairingFilePath(): string {
  const home = os.homedir();
  return path.join(home, '.duya', 'feishu_comment_pairing.json');
}

/** Get the rules file path */
export function getRulesFilePath(): string {
  const home = os.homedir();
  return path.join(home, '.duya', 'feishu_comment_rules.json');
}

/** Load pairing list */
export function loadPairingList(): Set<string> {
  const filePath = getPairingFilePath();

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data.users)) {
        return new Set(data.users);
      }
    }
  } catch (err) {
    console.warn('[Feishu Comment] Failed to load pairing:', err);
  }

  return new Set();
}

/** Add user to pairing list */
export function pairingAdd(userId: string): void {
  const pairing = loadPairingList();
  pairing.add(userId);
  savePairingList(pairing);
}

/** Remove user from pairing list */
export function pairingRemove(userId: string): void {
  const pairing = loadPairingList();
  pairing.delete(userId);
  savePairingList(pairing);
}

/** List all paired users */
export function pairingList(): string[] {
  return Array.from(loadPairingList());
}

/** Save pairing list */
function savePairingList(pairing: Set<string>): void {
  const filePath = getPairingFilePath();
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write atomically
  const tempPath = filePath + '.tmp';
  const content = JSON.stringify({ users: Array.from(pairing) }, null, 2);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/** Load rules with mtime-based caching */
class MtimeCache<T> {
  private cached: T | null = null;
  private cachedMtime = 0;
  private filePath: string;
  private loader: () => T;

  constructor(filePath: string, loader: () => T) {
    this.filePath = filePath;
    this.loader = loader;
  }

  get(): T {
    try {
      const mtime = fs.statSync(this.filePath).mtimeMs;
      if (mtime !== this.cachedMtime) {
        this.cached = this.loader();
        this.cachedMtime = mtime;
      }
      return this.cached ?? this.loader();
    } catch {
      return this.loader();
    }
  }

  invalidate(): void {
    this.cached = null;
    this.cachedMtime = 0;
  }
}

/** Load rules file */
function loadRulesConfig(): CommentsConfig {
  const filePath = getRulesFilePath();

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn('[Feishu Comment] Failed to load rules:', err);
  }

  return {};
}

// Cache for rules file
const rulesCache = new MtimeCache<CommentsConfig>(
  getRulesFilePath(),
  loadRulesConfig
);

/** Resolve rule for a document
 *
 * Fallback order:
 * 1. Exact key (e.g., "docx:xxxxx")
 * 2. Wildcard "*"
 * 3. Top-level config
 * 4. Code defaults
 */
export function resolveRule(docKey: string): ResolvedRule {
  const config = rulesCache.get();

  // Try exact key
  if (config.rules?.[docKey]) {
    const rule = config.rules[docKey];
    return {
      enabled: rule.enabled ?? config.enabled ?? RULE_DEFAULTS.enabled,
      policy: rule.policy ?? config.policy ?? RULE_DEFAULTS.policy,
      allowFrom: rule.allow_from ?? config.allow_from ?? RULE_DEFAULTS.allowFrom,
    };
  }

  // Try wildcard
  if (config.rules?.['*']) {
    const rule = config.rules['*'];
    return {
      enabled: rule.enabled ?? config.enabled ?? RULE_DEFAULTS.enabled,
      policy: rule.policy ?? config.policy ?? RULE_DEFAULTS.policy,
      allowFrom: rule.allow_from ?? config.allow_from ?? RULE_DEFAULTS.allowFrom,
    };
  }

  // Top-level config
  if (config.enabled !== undefined || config.policy !== undefined) {
    return {
      enabled: config.enabled ?? RULE_DEFAULTS.enabled,
      policy: config.policy ?? RULE_DEFAULTS.policy,
      allowFrom: config.allow_from ?? RULE_DEFAULTS.allowFrom,
    };
  }

  // Code defaults
  return RULE_DEFAULTS;
}

/** Check if user is allowed */
export function isUserAllowed(userOpenId: string, rule?: ResolvedRule): boolean {
  if (!rule) {
    rule = RULE_DEFAULTS;
  }

  // Check allowlist
  if (rule.allowFrom.includes(userOpenId)) {
    return true;
  }

  // Check pairing
  if (rule.policy === 'pairing') {
    return loadPairingList().has(userOpenId);
  }

  return false;
}

/** Invalidate rules cache (for hot reload) */
export function invalidateRulesCache(): void {
  rulesCache.invalidate();
}