/**
 * pluginHookConsent.ts — persistent user consent for plugin hook execution
 * (plan 583, seam C).
 *
 * A plugin's `hooks/hooks.json` may declare `command` / `process` hooks, and
 * the agent's hook executor spawns them for real: `command` through the shell
 * with `cwd` set to the session working directory, `process` as a direct exec,
 * and a `node` command rewritten onto the app's own Electron runtime. That is
 * arbitrary local code execution under the user's full privileges, fired
 * automatically whenever the matching hook event happens.
 *
 * Plan 583 G4 closed the network door (`allowHttpHooks` / `maxHooks`). This
 * table backs the remaining one. It is deliberately the *only* thing standing
 * between a third-party plugin and local process execution, so the semantics
 * are strict:
 *
 *  - No row means **not granted**. The agent fails closed and drops those
 *    hooks. Absence of a decision is never treated as consent.
 *  - `denied` is stored, not implied by the absence of a row, so revoking is
 *    a real recorded decision and the UI can distinguish "you said no" from
 *    "you have not been asked yet".
 *  - Consent is per plugin id, so granting one plugin never silently grants
 *    another, and a reinstall of the same id keeps the recorded answer.
 *
 * Storage is a module-owned side table in the legacy main DB, following the
 * `toolApprovalState.ts` pattern: idempotent DDL wired both as a numbered
 * migration and as a boot self-repair so a partially-migrated database heals.
 */

type BetterSqlite3Db = import('better-sqlite3').Database;

export type PluginHookConsentDecision = 'granted' | 'denied';

export interface PluginHookConsentRow {
  plugin_id: string;
  decision: PluginHookConsentDecision;
  decided_at: number;
}

export function isPluginHookConsentDecision(
  value: unknown,
): value is PluginHookConsentDecision {
  return value === 'granted' || value === 'denied';
}

/**
 * Idempotent DDL — safe on every boot (self-repair) and in the migration.
 * Statements are prepared individually; better-sqlite3 prepares one statement
 * per call, so there is no multi-statement string here.
 */
export function ensurePluginHookConsentTables(db: BetterSqlite3Db): void {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS plugin_hook_consent (' +
      'plugin_id TEXT PRIMARY KEY, ' +
      "decision TEXT NOT NULL CHECK (decision IN ('granted', 'denied')), " +
      'decided_at INTEGER NOT NULL)',
  ).run();
}

/** Every recorded decision, keyed by plugin id. Missing ids are absent. */
export function getPluginHookConsentMap(
  db: BetterSqlite3Db,
): Record<string, PluginHookConsentDecision> {
  const rows = db
    .prepare('SELECT plugin_id, decision FROM plugin_hook_consent')
    .all() as Array<{ plugin_id: string; decision: string }>;
  const out: Record<string, PluginHookConsentDecision> = {};
  for (const row of rows) {
    // The CHECK constraint should make an unknown value impossible, but this
    // map is consumed as "is this plugin allowed to execute?" — a row we
    // cannot interpret must read as absent, never as granted.
    if (isPluginHookConsentDecision(row.decision)) {
      out[row.plugin_id] = row.decision;
    }
  }
  return out;
}

export function getPluginHookConsent(
  db: BetterSqlite3Db,
  pluginId: string,
): PluginHookConsentDecision | null {
  const row = db
    .prepare('SELECT decision FROM plugin_hook_consent WHERE plugin_id = ?')
    .get(pluginId) as { decision: string } | undefined;
  return row && isPluginHookConsentDecision(row.decision) ? row.decision : null;
}

/** Record (or replace) the user's answer for one plugin. */
export function setPluginHookConsent(
  db: BetterSqlite3Db,
  pluginId: string,
  decision: PluginHookConsentDecision,
): void {
  db.prepare(
    'INSERT INTO plugin_hook_consent (plugin_id, decision, decided_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(plugin_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at',
  ).run(pluginId, decision, Date.now());
}

/** Drop a record entirely, so the plugin is asked again. */
export function clearPluginHookConsent(db: BetterSqlite3Db, pluginId: string): void {
  db.prepare('DELETE FROM plugin_hook_consent WHERE plugin_id = ?').run(pluginId);
}
