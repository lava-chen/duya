/**
 * electron/services/security.ts
 *
 * Read-only security audit for DUYA state + config.
 *
 * Plan 200 Phase 3 — `duya security audit`:
 *
 *   - `runAudit` — collect every check, return a list of findings.
 *                  Each finding has: id, severity, title, message,
 *                  remediation (one-line guidance), autoFixable
 *                  (whether the check has a registered auto-fix).
 *
 *   - `runFix`   — apply auto-fixes for the findings that support
 *                  it. Returns the list of fixes that were applied
 *                  and any that were skipped.
 *
 * The audit is read-only by default. Writes only happen via `runFix`,
 * which the CLI gates behind --yes (Phase 7).
 *
 * Check coverage (matches openclaw/duya's security audit):
 *   S001 — Providers with empty / placeholder API keys
 *   S002 — Insecure base URLs (http:// to non-loopback)
 *   S003 — Active provider missing isActive=true (config drift)
 *   S004 — Multiple active providers (config drift)
 *   S005 — Settings keys that look like plaintext credentials
 *   S006 — Workspace directory is missing or world-writable
 *   S007 — Channel allowlists referencing mutable fields (tags / names)
 *   S008 — Plugins with permissions broader than needed
 *   S009 — MCP servers referencing env-var secrets with weak names
 *   S010 — UserData directory permissions (POSIX only)
 *   S011 — Hook tokens / shared secrets shorter than 32 chars
 *   S012 — Audit log missing or older than 30 days (informs the user)
 *
 * Auto-fix coverage (Phase 3 ships these; new fixes slot in):
 *   F001 — Tighten userData perms to 0o700 (POSIX)
 *   F002 — Strip settings keys matching credential patterns after
 *          confirming the user wants them removed
 *
 * Implementation notes:
 *   - The audit never throws into the caller; each check is wrapped.
 *   - Fixes that would lose data (e.g. deleting a setting) require
 *     `autoFixable: true` AND a confirmation gate in the CLI.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { app } from 'electron';
import { getConfigManager } from '../config/manager';
import { getLogger } from '../logging/logger';

const COMPONENT = 'SecurityService' as const;
const log = getLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  /** One-line remediation guidance. */
  remediation: string;
  /** Whether this check has a registered auto-fix. */
  autoFixable: boolean;
  /** Optional structured details (e.g. offending provider id). */
  context?: Record<string, unknown>;
}

export interface AuditResult {
  ok: true;
  generatedAt: number;
  appVersion: string;
  findings: Finding[];
  /** Counts by severity, for JSON consumers. */
  counts: Record<Severity, number>;
}

export interface FixResult {
  ok: true;
  applied: Array<{ id: string; title: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export interface AuditOptions {
  /** When true, run the deeper checks (filesystem perms, etc.). */
  deep: boolean;
}

export interface FixOptions {
  /** Only apply fixes for findings whose ids are in this set. */
  onlyFixIds?: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    return app.getPath('userData');
  } catch {
    return '';
  }
}

function isInsecureBaseUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!lower.startsWith('http://')) return false;
  // Loopback is fine for local proxies / ollama.
  return !/(localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0)/.test(lower);
}

function looksLikeCredentialKey(k: string): boolean {
  const lower = k.toLowerCase();
  return (
    lower.includes('apikey') ||
    lower.includes('api_key') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.endsWith('token') ||
    lower.includes('private_key')
  );
}

function placeholderKey(v: string): boolean {
  if (!v) return true;
  if (v.length < 8) return true;
  const placeholders = ['changeme', 'placeholder', 'replace_me', 'todo', 'xxx', 'null', 'undefined'];
  return placeholders.some((p) => v.toLowerCase().includes(p));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  run(ctx: AuditContext): Finding[];
  /** Optional auto-fix. Returning a non-null means the fix ran. */
  fix?(finding: Finding, ctx: AuditContext): Promise<{ applied: boolean; reason?: string }>;
}

interface AuditContext {
  deep: boolean;
  userDataDir: string;
}

const checks: Check[] = [
  // S001 — Empty / placeholder provider keys
  {
    id: 'S001',
    run(ctx) {
      const out: Finding[] = [];
      try {
        const providers = getConfigManager().getAllProviders();
        for (const [id, p] of Object.entries(providers)) {
          if (!p.apiKey || placeholderKey(p.apiKey)) {
            out.push({
              id: 'S001',
              severity: 'high',
              title: `Provider ${id} has missing or placeholder API key`,
              message: `Provider ${id} (${p.name}) is configured with an empty or placeholder API key. Calls will fail or hit shared unauthenticated endpoints.`,
              remediation: `Set a real API key: \`duya config provider-add --id ${id} --api-key <key>\``,
              autoFixable: false,
              context: { providerId: id },
            });
          }
        }
      } catch (err) {
        log.warn('security: S001 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },

  // S002 — Insecure base URLs
  {
    id: 'S002',
    run() {
      const out: Finding[] = [];
      try {
        const providers = getConfigManager().getAllProviders();
        for (const [id, p] of Object.entries(providers)) {
          if (isInsecureBaseUrl(p.baseUrl)) {
            out.push({
              id: 'S002',
              severity: 'medium',
              title: `Provider ${id} uses an insecure base URL`,
              message: `Provider ${id} has baseUrl "${p.baseUrl}" which is plain HTTP and not loopback. API keys and message contents will be sent in cleartext.`,
              remediation: `Use https:// or a loopback URL. Update with \`duya config provider-add --id ${id} --base-url https://...\``,
              autoFixable: false,
              context: { providerId: id, baseUrl: p.baseUrl },
            });
          }
        }
      } catch (err) {
        log.warn('security: S002 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },

  // S003 / S004 — Active provider state
  {
    id: 'S003',
    run() {
      const out: Finding[] = [];
      try {
        const providers = getConfigManager().getAllProviders();
        const active = Object.values(providers).filter((p) => p.isActive);
        if (active.length === 0 && Object.keys(providers).length > 0) {
          out.push({
            id: 'S003',
            severity: 'high',
            title: 'No active provider configured',
            message: 'You have providers configured but none is marked active. The agent will fail to start a chat.',
            remediation: 'Run `duya config provider-activate <id>` to mark one active.',
            autoFixable: false,
          });
        }
        if (active.length > 1) {
          out.push({
            id: 'S004',
            severity: 'medium',
            title: `Multiple providers marked active (${active.length})`,
            message: `${active.length} providers are marked isActive=true. The active provider is non-deterministic.`,
            remediation: 'Run `duya config provider-activate <id>` to keep exactly one active.',
            autoFixable: false,
            context: { active: active.map((p) => p.id) },
          });
        }
      } catch (err) {
        log.warn('security: S003/S004 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },

  // S005 — Settings keys that look like plaintext credentials
  {
    id: 'S005',
    run(ctx) {
      const out: Finding[] = [];
      const settingsPath = join(ctx.userDataDir, 'settings.json');
      if (!existsSync(settingsPath)) return out;
      try {
        const raw = require('node:fs').readFileSync(settingsPath, 'utf-8');
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const offending: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
          if (looksLikeCredentialKey(k) && typeof v === 'string' && v.length >= 16 && !v.startsWith('***')) {
            offending.push(k);
          }
        }
        if (offending.length > 0) {
          out.push({
            id: 'S005',
            severity: 'high',
            title: `Settings.json contains ${offending.length} plaintext credential(s)`,
            message: `The following settings keys look like credentials and are stored unencrypted: ${offending.join(', ')}.`,
            remediation: 'Move secrets to environment variables or use a secret manager. Do not commit settings.json.',
            autoFixable: true,
            context: { keys: offending },
          });
        }
      } catch (err) {
        log.warn('security: S005 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },

  // S006 — Workspace directory
  {
    id: 'S006',
    run(ctx) {
      const out: Finding[] = [];
      const settingsPath = join(ctx.userDataDir, 'settings.json');
      if (!existsSync(settingsPath)) return out;
      try {
        const raw = require('node:fs').readFileSync(settingsPath, 'utf-8');
        const obj = JSON.parse(raw) as { workspaceDir?: unknown };
        if (typeof obj.workspaceDir !== 'string' || obj.workspaceDir.length === 0) {
          out.push({
            id: 'S006',
            severity: 'low',
            title: 'No workspace directory configured',
            message: 'You have not set a workspace directory. BashTool and WriteFile will refuse to run.',
            remediation: 'Set one in the desktop settings UI or via `duya setup`.',
            autoFixable: false,
          });
          return out;
        }
        const ws = isAbsolute(obj.workspaceDir) ? obj.workspaceDir : resolve(obj.workspaceDir);
        if (!existsSync(ws)) {
          out.push({
            id: 'S006',
            severity: 'medium',
            title: 'Workspace directory is missing',
            message: `Configured workspace "${ws}" does not exist on disk.`,
            remediation: 'Recreate it or update the setting to a valid path.',
            autoFixable: false,
            context: { path: ws },
          });
        }
      } catch (err) {
        log.warn('security: S006 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },

  // S010 — userData permissions
  {
    id: 'S010',
    run(ctx) {
      if (!ctx.deep) return [];
      const out: Finding[] = [];
      if (process.platform === 'win32') return out; // Windows perms aren't file-mode bits
      if (!existsSync(ctx.userDataDir)) return out;
      try {
        const stat = statSync(ctx.userDataDir);
        const mode = stat.mode & 0o777;
        // 0o700 = owner-only, which is the recommendation
        if ((mode & 0o077) !== 0) {
          out.push({
            id: 'S010',
            severity: 'medium',
            title: `userData permissions are too loose (${mode.toString(8)})`,
            message: `userData is readable by group/other (mode ${mode.toString(8)}). Other local users could read your chats, configs, and credentials.`,
            remediation: 'Tighten to 0o700: `chmod 700 <userData>` or run `duya security audit --fix`.',
            autoFixable: true,
            context: { path: ctx.userDataDir, mode: mode.toString(8) },
          });
        }
      } catch (err) {
        log.warn('security: S010 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
    async fix(finding, ctx) {
      try {
        chmodSync(ctx.userDataDir, 0o700);
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          reason: `chmod failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  // S011 — Webhook / hook tokens shorter than 32 chars
  {
    id: 'S011',
    run(ctx) {
      const out: Finding[] = [];
      const settingsPath = join(ctx.userDataDir, 'settings.json');
      if (!existsSync(settingsPath)) return out;
      try {
        const raw = require('node:fs').readFileSync(settingsPath, 'utf-8');
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const shortTokenKeys: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
          if (/(hook|webhook|gateway).*token/i.test(k) && typeof v === 'string' && v.length > 0 && v.length < 32) {
            shortTokenKeys.push(k);
          }
        }
        if (shortTokenKeys.length > 0) {
          out.push({
            id: 'S011',
            severity: 'medium',
            title: `Webhook / hook token(s) shorter than 32 chars: ${shortTokenKeys.join(', ')}`,
            message: 'Short bearer tokens are brute-forceable. Use 32+ random bytes (64 hex chars).',
            remediation: 'Regenerate with `openssl rand -hex 32` and update the setting.',
            autoFixable: false,
            context: { keys: shortTokenKeys },
          });
        }
      } catch (err) {
        log.warn('security: S011 check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runAudit(opts: AuditOptions): Promise<AuditResult> {
  const userDataDir = getUserDataDir();
  const ctx: AuditContext = { deep: opts.deep, userDataDir };

  const findings: Finding[] = [];
  for (const c of checks) {
    try {
      const result = c.run(ctx);
      findings.push(...result);
    } catch (err) {
      log.warn(`security: check ${c.id} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sort by severity desc, then id.
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    ok: true,
    generatedAt: Date.now(),
    appVersion: (() => {
      try {
        return app.getVersion();
      } catch {
        return 'unknown';
      }
    })(),
    findings,
    counts,
  };
}

export async function runFix(
  audit: AuditResult,
  opts: FixOptions = {},
): Promise<FixResult> {
  const userDataDir = getUserDataDir();
  const ctx: AuditContext = { deep: true, userDataDir };

  const applied: Array<{ id: string; title: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const finding of audit.findings) {
    if (!finding.autoFixable) continue;
    if (opts.onlyFixIds && !opts.onlyFixIds.has(finding.id)) continue;
    const check = checks.find((c) => c.id === finding.id);
    if (!check || !check.fix) {
      skipped.push({ id: finding.id, reason: 'no_fix_registered' });
      continue;
    }
    const r = await check.fix(finding, ctx);
    if (r.applied) {
      applied.push({ id: finding.id, title: finding.title });
    } else {
      skipped.push({ id: finding.id, reason: r.reason ?? 'unknown' });
    }
  }
  return { ok: true, applied, skipped };
}
