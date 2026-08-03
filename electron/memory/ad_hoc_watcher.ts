/**
 * Ad-hoc input chain for the Phase 2 curation cycle (Plan 406, design §9.1).
 *
 * Files under `memory/extensions/ad_hoc/*.md` are user-authored notes that
 * the curator agent reads as evidence. They are NOT edited by the agent.
 *
 * A file is "eligible" for curation when no `curation_run_inputs` row with
 * `(input_kind='ad_hoc', input_key=<relpath>, content_hash=<current hash>)`
 * exists on a `curation_runs.status='succeeded'` run. Modifying the file
 * changes its hash, which re-eligibilities it.
 *
 * `scanAdHocChanges` is called by `runCurationCycle` alongside the rollout
 * eligibility query; the two lists are merged and truncated to `maxInputs`
 * (§3.5). The staging step (Plan 402) copies the eligible ad-hoc files into
 * `staging/<run_id>/inputs/ad_hoc/` so the curator reads a frozen snapshot.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AdHocInput {
  inputKind: 'ad_hoc';
  inputKey: string;
  contentHash: string;
  sourcePath: string;
  outputUpdatedAt: number;
}

/**
 * Relative path used as `input_key`, computed from the memory root so the
 * ledger stores a stable project-relative reference (not an absolute path).
 * The caller passes `adHocDir` which is typically `<memoryRoot>/extensions/ad_hoc`,
 * so the relative key is `extensions/ad_hoc/<name>.md`.
 */
function toInputKey(adHocDir: string, filePath: string): string {
  // Walk up until we find `extensions/` and return everything from there.
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  const marker = '/extensions/ad_hoc/';
  const idx = normalized.indexOf(marker);
  if (idx === -1) {
    // Fallback: basename only (still unique within ad_hoc).
    return `extensions/ad_hoc/${path.basename(filePath)}`;
  }
  return normalized.slice(idx + 1);
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Scan `adHocDir` for `.md` files whose `(input_key, content_hash)` pair is
 * not already consumed by a succeeded curation run. Returns eligible inputs
 * sorted by `outputUpdatedAt` ascending (oldest first) so the caller's
 * `maxInputs` truncation keeps the oldest pending notes.
 */
export async function scanAdHocChanges(db: Database, adHocDir: string): Promise<AdHocInput[]> {
  if (!fs.existsSync(adHocDir) || !fs.statSync(adHocDir).isDirectory()) {
    return [];
  }

  const candidates: AdHocInput[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(adHocDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const full = path.join(adHocDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || !entry.endsWith('.md')) continue;

    const hash = sha256File(full);
    const inputKey = toInputKey(adHocDir, full);

    const consumed = db
      .prepare(
        `SELECT 1 FROM curation_run_inputs AS cri
         JOIN curation_runs AS cr ON cr.run_id = cri.run_id
         WHERE cri.input_kind = 'ad_hoc'
           AND cri.input_key = ?
           AND cri.content_hash = ?
           AND cr.status = 'succeeded'
           AND cri.disposition IN ('absorbed','no_change','rejected')
         LIMIT 1`
      )
      .get(inputKey, hash) as { 1: number } | undefined;

    if (consumed) continue;

    candidates.push({
      inputKind: 'ad_hoc',
      inputKey,
      contentHash: hash,
      sourcePath: full,
      outputUpdatedAt: Math.floor(stat.mtimeMs),
    });
  }

  candidates.sort((a, b) => a.outputUpdatedAt - b.outputUpdatedAt);
  return candidates;
}