/** Per-process intents survive worker loss and cannot overwrite another worker's tasks. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { getManagedShellOutputDirectory } from '../managed-shell/paths.js';
import { cwdInsideRoot } from './aliveness.js';

interface TaskLeaseRecord { version: 1; id: string; taskId: string; cwd: string; sessionId?: string; pid: number | null }
function leaseDirectory(dataRoot?: string): string { return path.join(getManagedShellOutputDirectory(dataRoot), 'checkout-leases'); }
function filename(id: string, dataRoot?: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid checkout task lease identity');
  return path.join(leaseDirectory(dataRoot), `${id}.json`);
}
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
}
export function reserveCheckoutTask(task: { taskId: string; cwd: string; sessionId?: string }, dataRoot?: string): string {
  const id = randomUUID();
  mkdirSync(leaseDirectory(dataRoot), { recursive: true });
  const record: TaskLeaseRecord = { version: 1, id, ...task, pid: null };
  writeFileSync(filename(id, dataRoot), JSON.stringify(record), { flag: 'wx' });
  return id;
}
export function bindCheckoutTaskPid(id: string, pid: number, dataRoot?: string): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const file = filename(id, dataRoot);
  const record = JSON.parse(readFileSync(file, 'utf8')) as TaskLeaseRecord;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...record, pid }), { flag: 'wx' });
  renameSync(temporary, file);
}
/** Call only after an actual process completion or proof the task was never sent. */
export function releaseCheckoutTask(id: string, dataRoot?: string): void {
  try { unlinkSync(filename(id, dataRoot)); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
}
export function hasBackgroundCheckoutLease(cwd: string, dataRoot?: string): boolean {
  const directory = leaseDirectory(dataRoot);
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      let record: TaskLeaseRecord;
      try { record = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as TaskLeaseRecord; }
      catch { throw new Error('A checkout process lease is unreadable. The checkout is retained.'); }
      if (record.version !== 1 || typeof record.cwd !== 'string' || (record.pid !== null && (!Number.isInteger(record.pid) || record.pid <= 0))) {
        throw new Error('A checkout process lease is invalid. The checkout is retained.');
      }
      // A crash before PID acknowledgement is unknown, never proof of quiescence.
      if ((record.pid === null || processIsAlive(record.pid)) && cwdInsideRoot(cwd, record.cwd)) return true;
    }
  }
  // Legacy snapshots have no per-task intent. Preserve them conservatively.
  const legacy = path.join(getManagedShellOutputDirectory(dataRoot), 'bash-tasks.json');
  if (existsSync(legacy)) {
    const snapshot = JSON.parse(readFileSync(legacy, 'utf8')) as { tasks?: Array<{ status: string; pid: number; checkoutLeaseId?: string; workingDirectory?: string }> };
    if (!Array.isArray(snapshot.tasks)) throw new Error('The background task snapshot is unreadable.');
    return snapshot.tasks.some((task) => !task.checkoutLeaseId && task.status === 'running' && processIsAlive(task.pid)
      && (!task.workingDirectory || cwdInsideRoot(cwd, task.workingDirectory)));
  }
  return false;
}
