/**
 * Forget repair (framework plan S5).
 *
 * The forget ledger is written before the canonical file is retired, so a
 * crash in that window leaves a ledger entry naming a file that is still
 * `status: active`. Recall readers hide every tombstoned path, so the fact
 * is invisible from the moment the ledger lands; this pass finishes the
 * job so the on-disk state converges:
 *
 *   1. retire the canonical file (`status: retired`);
 *   2. drop the tier-index row for that path.
 *
 * Idempotent: a completed forget is a no-op, and the pass can run on every
 * start. It is safe to call while the app is running — the desktop main
 * process is the only writer of both the files and the index.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getLogger, LogComponent } from '../logging/logger';
import { isCanonicalMemoryPath, resolveUnlinkedMemoryPath } from '@duya/memory/memory_paths';
import { readForgetLedgerSync } from '@duya/memory/forget_ledger';
import { removeTierEntryByPath } from './tierIndex';
import { retireCanonicalFile } from './tierWriter';

/**
 * What one repair pass did. A type alias (not an interface) so the report
 * can be handed to the structured logger's context directly.
 */
export type ForgetRecoveryReport = {
  /** Tombstoned paths inspected. */
  scanned: number;
  /** Files flipped to `status: retired`. */
  retired: number;
  /** Tier-index rows dropped. */
  indexRowsRemoved: number;
};

/**
 * Complete every forget the ledger records but the disk state does not yet
 * reflect. Safe to call at any time; never throws for a single bad entry —
 * one unreadable file must not block the remaining repairs.
 */
export function recoverForgottenMemories(
  db: Database,
  duyaRoot: string,
): ForgetRecoveryReport {
  const logger = getLogger();
  const report: ForgetRecoveryReport = { scanned: 0, retired: 0, indexRowsRemoved: 0 };
  const ledger = readForgetLedgerSync(path.join(duyaRoot, 'memory'));

  for (const entry of ledger.entries) {
    for (const relPath of entry.paths) {
      report.scanned += 1;
      const absPath = isCanonicalMemoryPath(relPath) ? resolveUnlinkedMemoryPath(duyaRoot, relPath) : null;
      if (!absPath) {
        logger.warn('Forget repair: unsafe canonical path skipped', { filePath: relPath }, LogComponent.Main);
        continue;
      }
      try {
        if (fs.existsSync(absPath) && retireCanonicalFile(absPath)) {
          report.retired += 1;
        }
      } catch (err) {
        logger.warn(
          'Forget repair: file retirement failed',
          { filePath: relPath, error: err instanceof Error ? err.message : String(err) },
          LogComponent.Main,
        );
      }
      try {
        if (removeTierEntryByPath(db, relPath)) {
          report.indexRowsRemoved += 1;
        }
      } catch (err) {
        logger.warn(
          'Forget repair: index row removal failed',
          { filePath: relPath, error: err instanceof Error ? err.message : String(err) },
          LogComponent.Main,
        );
      }
    }
  }

  if (report.retired > 0 || report.indexRowsRemoved > 0) {
    logger.info('Forget repair completed', report, LogComponent.Main);
  }
  return report;
}
