/**
 * spawned-workers.ts — the host's ONE list of the worker processes it spawned
 * (plan 587 C6.1).
 *
 * ## Why this exists
 *
 * The Control Plane's command sender check asks one question: *is this pid a
 * process this host spawned?* Before this slice, `handleDbRequest`
 * (`agents/db-bridge.ts:2856`) dispatched whatever action string arrived from
 * whatever process sent it, so the answer was assumed.
 *
 * Answering it by asking each manager (`AgentProcessPool`, the workflow runtime,
 * the agent-server lifecycle) is the obvious approach and the wrong one: three
 * readers, three chances to forget a spawn site, and a check that is only as
 * strong as the least-careful list. A `db:request` refused because someone
 * forgot to add a manager is a refusal with no useful diagnosis.
 *
 * So the list has one owner, and a spawn site joins it by REGISTERING. Forgetting
 * a new spawn site is then visible as a refusal naming the pid, rather than
 * silent.
 *
 * ## Why a registry and not a live read
 *
 * The alternative — reading each manager's live children at check time — is
 * honest about liveness but ties the Control Plane to three modules and makes
 * the trusted set a derived value nobody can enumerate. Registration is
 * explicit, and a dead child is removed by the same code path that reaps it.
 *
 * A pid the OS has recycled cannot re-enter: a re-register for a live pid is
 * refused, and unregister is keyed by BOTH pid and the child handle's own
 * identity, so a stale teardown cannot remove a newer process's entry.
 */

import { getLogger, LogComponent } from '../logging/logger';

interface Entry {
  readonly role: string;
  /** The child handle, so a stale teardown cannot unregister a successor. */
  readonly child: object;
}

const spawned = new Map<number, Entry>();

/**
 * Record a child this host just spawned.
 *
 * @returns `false` when the pid is already registered and still live, which
 *   means two spawn sites believe they own the same pid — refused rather than
 *   silently reassigned, because the loser would then be unable to authorise
 *   anything and would not know why.
 */
export function registerSpawnedWorker(pid: number | undefined, role: string, child: object): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  const existing = spawned.get(pid);
  if (existing !== undefined && existing.child === child) return true;
  if (existing !== undefined) {
    getLogger().warn('Two spawn sites claimed one worker pid; the later claim was refused', { pid, role }, LogComponent.AgentProcessPool);
    return false;
  }
  spawned.set(pid, { role, child });
  return true;
}

/**
 * Forget a child.
 *
 * No-op when the pid is unknown, or when the registered entry belongs to a
 * DIFFERENT child handle — a recycled pid whose predecessor's teardown arrives
 * late must not unregister the process that holds the pid now.
 */
export function unregisterSpawnedWorker(pid: number | undefined, child: object): void {
  if (pid === undefined) return;
  const existing = spawned.get(pid);
  if (existing === undefined || existing.child !== child) return;
  spawned.delete(pid);
}

/** The pids of every live child this host spawned. */
export function liveSpawnedWorkerPids(): ReadonlySet<number> {
  return new Set(spawned.keys());
}

/** The registered role for a pid, or `null`. Used to build the sender's origin. */
export function spawnedWorkerRole(pid: number | null): string | null {
  if (pid === null) return null;
  return spawned.get(pid)?.role ?? null;
}

/** Test-only. A process-wide registry that cannot be reset cannot be tested twice. */
export function _resetSpawnedWorkersForTesting(): void {
  spawned.clear();
}
