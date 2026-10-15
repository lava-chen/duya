import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionId } from '@duya/agent-protocol';
import type { HostSessionArchiveResult } from '@duya/agent-protocol/session-api';
import { archivedDirFor, resolveArchivedPath, resolveUnarchivedPath } from '@duya/data/archive-paths';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import { recoverOriginalRel } from '@duya/data/legacy-archive-migration';

type SessionArchiveStores = Pick<
  CoreDataHostStores,
  'sessions' | 'messageLog' | 'locks' | 'spawnEdges'
>;

interface ArchiveRowSnapshot {
  status: string;
  archivedAt: number | null;
  archivedPath: string | null;
  rolloutPath: string | null;
}

interface ArchiveMove {
  readonly srcAbs: string;
  readonly archivedAbs: string;
  readonly archivedRel: string;
}

interface ArchiveUnit {
  readonly sessionId: string;
  readonly moves: ArchiveMove[];
  readonly snapshot: ArchiveRowSnapshot;
  readonly target: ArchiveRowSnapshot;
}

interface SessionArchiveOptions {
  readonly stores: SessionArchiveStores;
  readonly rolloutRoot: string;
  readonly now?: () => number;
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}

function collectJsonlFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rank = (name: string): number => {
    if (/^archive-\d+\.jsonl$/.test(name)) return 0;
    if (name === 'active.jsonl') return 1;
    return 2;
  };
  return entries
    .filter((name) => name.endsWith('.jsonl'))
    .sort((a, b) => {
      const rankA = rank(a);
      const rankB = rank(b);
      if (rankA !== rankB) return rankA - rankB;
      if (rankA === 0) {
        const generationA = Number(a.match(/^archive-(\d+)\.jsonl$/)![1]);
        const generationB = Number(b.match(/^archive-(\d+)\.jsonl$/)![1]);
        if (generationA !== generationB) return generationA - generationB;
      }
      return a.localeCompare(b);
    })
    .map((name) => path.join(dir, name));
}

function restoreMoves(
  moves: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  warn?: SessionArchiveOptions['warn'],
): void {
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index]!;
    if (move.from === move.to) continue;
    try {
      fs.mkdirSync(path.dirname(move.to), { recursive: true });
      fs.renameSync(move.from, move.to);
    } catch (error) {
      // Continue restoring the other files; the caller reports the failed operation.
      warn?.('archive: failed to roll back a moved rollout file', {
        err: String(error),
      });
    }
  }
}

function planArchive(
  sessionId: string,
  row: ArchiveRowSnapshot,
  now: number,
  rolloutRoot: string,
  stores: SessionArchiveStores,
): ArchiveUnit {
  const snapshot = { ...row };
  const currentRel = row.rolloutPath ?? stores.sessions.getRolloutPath(sessionId);
  const enumerated = stores.messageLog.collectSessionRolloutFiles(sessionId);
  const candidates = enumerated.length > 0
    ? enumerated
    : currentRel
      ? [path.join(rolloutRoot, currentRel)].filter((filePath) => fs.existsSync(filePath))
      : [];

  if (candidates.length === 0) {
    return {
      sessionId,
      moves: [],
      snapshot,
      target: { status: 'archived', archivedAt: now, archivedPath: null, rolloutPath: row.rolloutPath },
    };
  }

  const moves = candidates.map((srcAbs) => {
    const rel = path.relative(rolloutRoot, srcAbs).split(path.sep).join('/');
    const archivedRel = resolveArchivedPath(rel, now);
    return { srcAbs, archivedRel, archivedAbs: path.join(rolloutRoot, archivedRel) };
  });

  return {
    sessionId,
    moves,
    snapshot,
    target: {
      status: 'archived',
      archivedAt: now,
      archivedPath: archivedDirFor(moves[moves.length - 1]!.archivedRel),
      rolloutPath: moves[moves.length - 1]!.archivedRel,
    },
  };
}

function commitArchiveBatch(
  units: ReadonlyArray<ArchiveUnit>,
  stores: SessionArchiveStores,
  rolloutRoot: string,
  warn?: SessionArchiveOptions['warn'],
): { readonly ok: true } | { readonly ok: false; readonly failedId: string } {
  const moved: Array<{ readonly from: string; readonly to: string }> = [];
  for (const unit of units) {
    for (const move of unit.moves) {
      try {
        fs.mkdirSync(path.dirname(move.archivedAbs), { recursive: true });
        fs.renameSync(move.srcAbs, move.archivedAbs);
        moved.push({ from: move.archivedAbs, to: move.srcAbs });
      } catch (error) {
        restoreMoves(moved, warn);
        warn?.('archive: rename failed, rolled back, SQL state unchanged', {
          sessionId: unit.sessionId,
          rolledBack: moved.length,
          err: String(error),
        });
        return { ok: false, failedId: unit.sessionId };
      }
    }
  }

  const written: ArchiveUnit[] = [];
  for (const unit of units) {
    try {
      stores.sessions.update(unit.sessionId, unit.target);
      written.push(unit);
    } catch (error) {
      for (let index = written.length - 1; index >= 0; index -= 1) {
        const completed = written[index]!;
        try {
          stores.sessions.update(completed.sessionId, completed.snapshot);
        } catch (restoreError) {
          // Continue restoring rows and files after an individual rollback failure.
          warn?.('archive: failed to restore a row after an aborted batch', {
            sessionId: completed.sessionId,
            err: String(restoreError),
          });
        }
      }
      restoreMoves(moved, warn);
      warn?.('archive: metadata update failed, rolled back rows and moved files', {
        sessionId: unit.sessionId,
        restoredRows: written.length,
        err: String(error),
      });
      return { ok: false, failedId: unit.sessionId };
    }
  }
  return { ok: true };
}

export function createSessionArchiveOperations(options: SessionArchiveOptions): {
  archive(sessionId: SessionId): HostSessionArchiveResult;
  unarchive(sessionId: SessionId): boolean;
} {
  const { stores, rolloutRoot } = options;
  const now = options.now ?? Date.now;

  function archive(sessionId: SessionId): HostSessionArchiveResult {
    const root = stores.sessions.get(sessionId);
    if (!root) return { ok: false, reason: 'not_found', sessionId };
    if (root.status === 'archived') return { ok: true, archivedSessionIds: [] };

    const subtree = new Set<string>([sessionId]);
    for (const edge of stores.spawnEdges.getTree(sessionId)) subtree.add(edge.childSessionId);
    for (const id of subtree) {
      if (!stores.locks.isLocked(id)) continue;
      return {
        ok: false,
        reason: 'session_busy',
        sessionId,
        blockedId: id,
        origin: stores.locks.lockOrigin(id),
      };
    }

    const archivedAt = now();
    const units: ArchiveUnit[] = [];
    for (const id of subtree) {
      const row = stores.sessions.get(id);
      if (!row || row.status === 'archived' || row.status === 'deleted') continue;
      units.push(planArchive(id, {
        status: row.status,
        archivedAt: row.archivedAt,
        archivedPath: row.archivedPath,
        rolloutPath: row.rolloutPath,
      }, archivedAt, rolloutRoot, stores));
    }

    const outcome = commitArchiveBatch(units, stores, rolloutRoot, options.warn);
    if (!outcome.ok) {
      return { ok: false, reason: 'io', sessionId, failedId: outcome.failedId };
    }
    for (const unit of units) stores.messageLog.invalidateRolloutPathCache(unit.sessionId);
    return { ok: true, archivedSessionIds: units.map((unit) => unit.sessionId) };
  }

  function unarchive(sessionId: SessionId): boolean {
    const session = stores.sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== 'archived') return true;
    const clearArchiveMetadata = (): void => {
      stores.sessions.update(sessionId, { status: 'active', archivedAt: null, archivedPath: null });
    };
    const archivedDirRel = session.archivedPath;
    if (!archivedDirRel) {
      clearArchiveMetadata();
      return true;
    }

    const archivedDirAbs = path.join(rolloutRoot, archivedDirRel);
    let archivedStat: fs.Stats | null = null;
    try {
      archivedStat = fs.statSync(archivedDirAbs);
    } catch {
      archivedStat = null;
    }
    if (!archivedStat) {
      clearArchiveMetadata();
      return true;
    }

    const legacyRestoreRel = archivedStat.isFile()
      ? recoverOriginalRel(session.rolloutPath, rolloutRoot)
      : null;
    const archivedFiles = archivedStat.isDirectory() ? collectJsonlFiles(archivedDirAbs) : [];
    const plan = (archivedFiles.length > 0 ? archivedFiles : [archivedDirAbs])
      .filter((filePath) => fs.existsSync(filePath))
      .map((srcAbs) => {
        const rel = path.relative(rolloutRoot, srcAbs).split(path.sep).join('/');
        const restoredRel = legacyRestoreRel ?? resolveUnarchivedPath(rel);
        return { srcAbs, restoredRel, restoredAbs: path.join(rolloutRoot, restoredRel) };
      });

    if (plan.length === 0) {
      clearArchiveMetadata();
      return true;
    }

    const moved: Array<{ readonly from: string; readonly to: string }> = [];
    for (const entry of plan) {
      try {
        fs.mkdirSync(path.dirname(entry.restoredAbs), { recursive: true });
        fs.renameSync(entry.srcAbs, entry.restoredAbs);
        moved.push({ from: entry.restoredAbs, to: entry.srcAbs });
      } catch (error) {
        restoreMoves(moved, options.warn);
        options.warn?.('unarchive: rename failed, rolled back, SQL state unchanged', {
          sessionId,
          rolledBack: moved.length,
          err: String(error),
        });
        return false;
      }
    }

    try {
      stores.sessions.update(sessionId, {
        status: 'active',
        archivedAt: null,
        archivedPath: null,
        rolloutPath: plan[plan.length - 1]!.restoredRel,
      });
    } catch (error) {
      restoreMoves(moved, options.warn);
      options.warn?.('unarchive: metadata update failed, rolled back moved files', {
        sessionId,
        rolledBack: moved.length,
        err: String(error),
      });
      return false;
    }
    stores.messageLog.invalidateRolloutPathCache(sessionId);
    return true;
  }

  return { archive, unarchive };
}
