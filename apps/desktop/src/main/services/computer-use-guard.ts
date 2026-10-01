/**
 * services/computer-use-guard.ts — shared execution guard (plan 575 §0
 * follow-up round).
 *
 * ONE implementation of the computer-use safety gates, consumed by BOTH
 * the classic vision surface (ipc/computer-use.ts `computer_use`) and
 * the CUA surface (services/cua + ipc/cua-handlers.ts `computer_cua`):
 *
 *   1. revoke gate    — the user pressed STOP on the overlay; every
 *                       computer-use action refuses until they re-arm.
 *   2. app access gate — the [computer_use] config policy
 *                       (default_access / allowed_apps / denied_apps)
 *                       evaluated against the TARGET app (CUA element
 *                       actions may address a background window, so the
 *                       target pid wins when known) or the foreground
 *                       app (pixel-level actions, vision click).
 *
 * The guard deliberately owns the policy loading + target resolution so
 * future gates (sensitive-field redaction, per-app denylists, arbiter
 * scheduling) land here once for both surfaces instead of forking.
 *
 * Error-code mapping stays at the call sites: the vision surface maps
 * `revoked` → USER_REJECTED and `app-blocked` → APP_BLOCKED; the CUA
 * surface maps them onto its own taxonomy (NOT_AUTHORIZED /
 * PERMISSION_DENIED). The DECISIONS are shared; the envelopes are not.
 */

import { checkAccess, type AppAccessPolicy } from '@duya/computer-use';

import { getLogger, LogComponent } from '../logging/logger.js';
import { isComputerUseControlRevoked } from './computer-use-overlay.js';
import { getSharedUiaProbeClient } from './recorder/uia-probe.js';

const logger = getLogger();

/** Target app identity the caller already knows (best-effort, all optional). */
export interface GuardTargetApp {
  pid?: number | null;
  title?: string | null;
}

/** Decision returned by every guard entry — never throws. */
export type GuardDecision =
  | { ok: true }
  | { ok: false; kind: 'revoked' | 'app-blocked'; reason: string };

// ────────────────────────────────────────────────────────────────────
// Revoke gate (overlay STOP button)
// ────────────────────────────────────────────────────────────────────

/**
 * The user stopped computer control from the overlay — refuse until
 * they re-arm. Sync and cheap; call sites map `revoked` onto their own
 * error code (vision: USER_REJECTED, CUA: NOT_AUTHORIZED).
 */
export function assertNotRevoked(): GuardDecision {
  if (isComputerUseControlRevoked()) {
    return {
      ok: false,
      kind: 'revoked',
      reason: 'computer control was stopped by the user from the overlay — ask the user before continuing',
    };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// App access policy (migrated verbatim from ipc/computer-use.ts)
// ────────────────────────────────────────────────────────────────────

/**
 * Cached Computer Use access policy. Loaded lazily from config on
 * first use (defaults to deny-by-default) and refreshed whenever
 * the config store broadcasts a change.
 */
let cachedAccessPolicy: AppAccessPolicy | null = null;

/**
 * Read the [computer_use] access policy from the config store. Uses
 * `ConfigStore` if available; falls back to the deny-by-default
 * constant when the store isn't reachable (unit tests, CLI).
 */
function getAccessPolicy(): AppAccessPolicy {
  if (cachedAccessPolicy) return cachedAccessPolicy;
  try {
    // Lazy import keeps the module independent of the config tree.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfigStore } = require('../config/store-instance') as {
      getConfigStore: () => { getByPath(path: string): unknown };
    };
    const store = getConfigStore();
    const raw = store.getByPath('computer_use') as AppAccessPolicy | undefined;
    if (raw === undefined) {
      // No [computer_use] section configured: keep the feature usable
      // (allow-by-default) so dev / first-run works out of the box.
      cachedAccessPolicy = { default_access: 'allow', allowed_apps: [], denied_apps: [] };
    } else {
      // User explicitly configured the section: honor their values
      // with a deny default so an allow-list-only config locks
      // everything else down.
      cachedAccessPolicy = {
        default_access: raw?.default_access ?? 'deny',
        allowed_apps: raw?.allowed_apps ?? [],
        denied_apps: raw?.denied_apps ?? [],
      };
    }
  } catch {
    // Store unreachable (unit tests, CLI): allow by default so
    // non-Electron contexts don't hard-fail every action.
    cachedAccessPolicy = { default_access: 'allow', allowed_apps: [], denied_apps: [] };
  }
  return cachedAccessPolicy;
}

/** True when the pid's exe could not be resolved within the TTL. */
interface PidExeCacheEntry {
  exe: string | null;
  at: number;
}

/** pid → exe cache: mutating actions fire one probe apps op at most per TTL. */
const PID_EXE_TTL_MS = 5_000;
const pidExeCache = new Map<number, PidExeCacheEntry>();

async function pidToExe(pid: number): Promise<string | null> {
  const cached = pidExeCache.get(pid);
  if (cached && Date.now() - cached.at < PID_EXE_TTL_MS) {
    return cached.exe;
  }
  let exe: string | null = null;
  try {
    const rows = await getSharedUiaProbeClient().listApps();
    exe = rows?.find((r) => r.pid === pid)?.exe ?? null;
  } catch {
    exe = null;
  }
  if (pidExeCache.size > 64) pidExeCache.clear();
  pidExeCache.set(pid, { exe, at: Date.now() });
  return exe;
}

function exeBasename(exe: string | null): string | null {
  if (!exe) return null;
  const normalized = exe.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.length > 0 ? base : null;
}

/**
 * Evaluate the access policy for one action. When `targetApp` carries a
 * pid (CUA element actions address a known background window) the
 * policy is evaluated against THAT process; otherwise it falls back to
 * the foreground app (pixel-level actions and the vision click — the
 * classic semantics).
 */
export async function assertAppAllowed(
  action: string,
  targetApp?: GuardTargetApp | null,
): Promise<GuardDecision> {
  let processName: string | null = null;
  let title: string | null = null;
  let focusedEntity: unknown = null;

  const pid = typeof targetApp?.pid === 'number' && targetApp.pid > 0 ? targetApp.pid : null;
  if (pid !== null) {
    processName = exeBasename(await pidToExe(pid));
    title = targetApp?.title ?? null;
  } else {
    // Foreground semantics (vision path parity): read the OS context.
    try {
      // Lazy import mirrors ipc/computer-use.ts (no hard agent dep).
      const { getOSContextBridge } = (require('../../../../../packages/agent/dist/context/os-context/index.js') as {
        getOSContextBridge: () => {
          getCurrent: () => {
            foreground?: { exeName?: string; title?: string } | null;
            focusedEntity?: unknown;
          } | null;
        };
      });
      const ctx = getOSContextBridge().getCurrent();
      processName = ctx?.foreground?.exeName ?? null;
      title = ctx?.foreground?.title ?? null;
      focusedEntity = ctx?.focusedEntity ?? null;
    } catch {
      processName = null;
      title = null;
      focusedEntity = null;
    }
  }

  try {
    const verdict = checkAccess(getAccessPolicy(), { processName, title, focusedEntity });
    if (verdict.allowed) return { ok: true };
    logger.info(
      'computer-use guard: action blocked by app access policy',
      { action, processName, pid, reason: verdict.reason },
      LogComponent.ComputerUse,
    );
    return { ok: false, kind: 'app-blocked', reason: verdict.reason ?? 'app blocked by access policy' };
  } catch (err) {
    logger.warn(
      'computer-use guard: access check threw',
      { action, error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
    return {
      ok: false,
      kind: 'app-blocked',
      reason: 'Access policy evaluation failed; action refused for safety.',
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Combined entry (both gates, one call)
// ────────────────────────────────────────────────────────────────────

/**
 * Run the full guard for one action: revoke first (cheap, sync), then
 * the app access policy. The vision `computer_use` action paths and the
 * CUA mutating paths both land here. `skipAppPolicy` marks read-only
 * observations (list/observe/capture): still revocation-gated, but the
 * app policy is not consulted.
 */
export async function assertComputerUseAllowed(input: {
  action: string;
  targetApp?: GuardTargetApp | null;
  skipAppPolicy?: boolean;
}): Promise<GuardDecision> {
  const revoked = assertNotRevoked();
  if (!revoked.ok) return revoked;
  if (input.skipAppPolicy) return { ok: true };
  return assertAppAllowed(input.action, input.targetApp);
}

/** Test-only: drop memoized policy + pid cache between tests. */
export function __resetComputerUseGuard(): void {
  cachedAccessPolicy = null;
  pidExeCache.clear();
}
