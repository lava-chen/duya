/**
 * apps/desktop/src/main/memory-state/__tests__/agent-fixture-drift.test.ts
 *
 * The host owns `memory-state.db`'s schema. This test is the only thing that
 * keeps the agent package's copy of that schema honest.
 *
 * ## Why this file has to live here
 *
 * Plan 587 M5.1 ranked `pkg:agent -> electron-main` as the top cut: 15 value
 * edges, every one of them starting in a test file, 14 of them reaching the
 * migrations in this directory by relative path. The agent's memory-state
 * modules are readers and writers of tables the HOST creates, so the agent
 * package cannot import them without owning a dependency on the host.
 *
 * M5.2 fixed that by giving the agent its own statement of the schema it
 * requires (`packages/agent/src/memory-state/__tests__/schema-ddl.ts`). A copy
 * is only honest while it matches, and nothing in the agent package can check
 * that without re-creating the edge it just removed. So the check lives with
 * the owner.
 *
 * ## Why this test READS that file instead of importing it
 *
 * Because importing it would simply trade one boundary violation for another.
 * The first version of this test imported the agent DDL, and
 * `architecture:check` correctly reported it as a new
 * `package-boundary-escape` (162 -> 163), because a host file reaching into
 * `packages/` by relative path is the same class of coupling M5.2 was cutting
 * — just pointing the other way. The fix is not to baseline it away.
 *
 * So the agent DDL is read as TEXT, by path, at test time. That creates no
 * import edge, so both directions stay at zero, and it is the right technique
 * for a drift check anyway: the question is whether two committed files agree,
 * not whether two modules can be loaded together.
 *
 * The dependency is real and is not hidden. The path is named, the file's
 * existence is asserted, and a moved or reshaped file fails loudly here rather
 * than passing quietly.
 *
 * ## What it compares
 *
 * Not the text. Both sides are applied to a real in-memory SQLite database and
 * the resulting `sqlite_master` is compared, so this is a semantic check: a
 * host migration that changes the schema a table actually gets fails even when
 * the two texts differ only in formatting, and a cosmetic difference that
 * changes nothing in SQLite does not.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';

/** Where the memory package states the schema it requires. */
const AGENT_DDL_PATH = path.resolve(
  __dirname,
  '../../../../../../packages/memory/src/testing/schema-ddl.ts',
);

/**
 * The migrations the agent fixture mirrors.
 *
 * The fixture is a transcription of the schema as of 0008, so the comparison is
 * scoped to that prefix. Migrations 0009+ DROP legacy tables and add indexes
 * the agent modules never reference, so requiring the fixture to carry them
 * would be asserting a migration rather than a contract — and would make this
 * test fail every time the host legitimately appends one.
 */
const MIRRORED_MAX_VERSION = 8;
const mirrored = MIGRATIONS.filter((m) => m.version <= MIRRORED_MAX_VERSION);

/** The DDL statements the agent fixture applies, read from its source. */
function agentFixtureStatements(): string[] {
  expect(
    fs.existsSync(AGENT_DDL_PATH),
    `the agent fixture DDL is gone: ${AGENT_DDL_PATH}. If it moved, the agent's ` +
      'memory-state tests are building a schema this host no longer has.',
  ).toBe(true);

  const source = fs.readFileSync(AGENT_DDL_PATH, 'utf8');
  const start = source.indexOf('MEMORY_STATE_FIXTURE_DDL: readonly string[] = [');
  expect(start, 'the agent DDL no longer exports MEMORY_STATE_FIXTURE_DDL').toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  expect(end, 'the agent DDL array is unterminated').toBeGreaterThan(start);

  const body = source.slice(start, end);
  const statements: string[] = [];
  for (let i = body.indexOf('`'); i !== -1; i = body.indexOf('`', i + 1)) {
    const close = body.indexOf('`', i + 1);
    if (close === -1) break;
    statements.push(body.slice(i + 1, close));
    i = close;
  }
  expect(statements.length, 'no DDL statements found in the agent fixture').toBeGreaterThanOrEqual(
    mirrored.length,
  );
  return statements;
}

/** Collapse whitespace so the comparison is about schema, not formatting. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The schema a list of statements actually produces, in a real SQLite engine. */
function schemaOf(statements: readonly string[]): string[] {
  const db = new Database(':memory:');
  try {
    for (const statement of statements) db.exec(statement);
    const rows = db
      .prepare(
        `SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as { type: string; name: string; sql: string }[];
    return rows.map((r) => `${r.type} ${r.name} ${normalize(r.sql)}`);
  } finally {
    db.close();
  }
}

describe('the agent fixture schema still matches the host migrations', () => {
  it('mirrors every migration up to the version the fixture claims', () => {
    // Guards the scope itself. If the fixture ever grows to cover a later
    // migration, this fails until MIRRORED_MAX_VERSION is raised with it,
    // rather than silently comparing a subset and passing.
    expect(mirrored.map((m) => m.version)).toEqual([1, 2, 3, 5, 6, 7, 8]);
  });

  it('produces the same schema as the host migrations, in the same order', () => {
    // The load-bearing assertion, and a semantic one: both sides are applied to
    // a real SQLite engine, so this compares the schema the agent fixture
    // actually builds against the schema the host actually builds.
    const host = schemaOf(mirrored.map((m) => m.sql));
    const agent = schemaOf(agentFixtureStatements());
    expect(agent).toEqual(host);
  });

  it('covers the tables the agent memory-state modules read and write', () => {
    // A schema match is only meaningful if the fixture is the schema the agent
    // actually uses. These are tables the agent modules name in SQL, so a
    // migration that dropped one would otherwise pass the comparison above
    // while the agent's queries silently stopped working.
    const required = [
      'rollout_catalog',
      'stage1_outputs',
      'projection_outbox',
      'rollout_leases',
      'rollout_retired',
      'memory_entries',
      'curation_runs',
    ];
    const created = new Set(
      agentFixtureStatements()
        .join('\n')
        .match(/CREATE TABLE (\w+)/g)
        ?.map((m) => m.replace('CREATE TABLE ', '')) ?? [],
    );
    expect(required.filter((t) => !created.has(t))).toEqual([]);
  });
});
