/**
 * packages/agent/tests/cli-control-plane/session-control-plane.test.ts
 *
 * Regression tests for the duya CLI session control plane.
 *
 * What this covers:
 *   - happy path: list / show for visible top-level sessions
 *   - visibility filter: deleted / automation / gw-* / sub-agent
 *     are filtered from list and return unified 404 from show
 *   - messageCount is the COUNT of `messages` rows
 *   - CLI flags: --limit / --offset / --format json are honored
 *   - 4xx errors: invalid_limit / invalid_offset produce clear message
 *     and non-zero exit
 *   - response shape: no internal field (working_directory,
 *     system_prompt, context_summary, parent_id, is_deleted,
 *     agent_type, agent_name, messages, research_*, etc.) is leaked
 *   - runtime / auth error paths
 *
 * Test mechanism:
 *   For each suite the harness spawns a real Electron main process
 *   pointing at an isolated temp userData with a freshly seeded DB,
 *   waits for the runtime file, then runs the real CLI entry point
 *   via `npx tsx packages/agent/src/cli/index.ts` (the same code
 *   path users run in production). After the suite the Electron
 *   process is killed and the temp userData is removed.
 *
 * Note: vitest runs each test file in its own worker, but multiple
 * `it` blocks share the file. We start ONE harness per test file
 * (vitest's `beforeAll` / `afterAll`) so the startup cost is paid
 * once and every assertion reuses the same server. This matches
 * how a developer would run the CLI repeatedly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, runCli, type Harness, type SeedSession } from './harness';

const STANDARD_SEED: SeedSession[] = [
  {
    id: 'sess-visible-1',
    title: 'Visible Top-level #1',
    mode: 'code',
    messageCount: 3,
  },
  {
    id: 'sess-visible-2',
    title: 'Visible Plan-mode #2',
    mode: 'plan',
    messageCount: 5,
  },
  {
    id: 'sess-automation-1',
    title: 'Automation Cron',
    mode: 'automation',
  },
  {
    id: 'sess-sub-1',
    title: 'Sub Agent Session',
    mode: 'code',
    parent_id: 'sess-visible-1',
    agent_type: 'sub-agent',
    messageCount: 7,
  },
  {
    id: 'sess-deleted-1',
    title: 'Deleted Session',
    mode: 'code',
    is_deleted: 1,
  },
  {
    id: 'fake-gateway',
    gateway: true,
    title: 'Gateway Internal',
  },
];

let h: Harness | null = null;

beforeAll(async () => {
  h = await startHarness(STANDARD_SEED);
}, 60_000);

afterAll(async () => {
  if (h) await h.teardown();
});

function env(): string {
  return `DUYA_CLI_USER_DATA_DIR=${h!.userData}`;
}

describe('CLI session control plane (real Electron + temp DB)', () => {
  describe('list (GET /v1/sessions)', () => {
    it('returns 4-field DTO for top-level visible sessions only', () => {
      const r = runCli(env(), ['session', 'list', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.sessions).toHaveLength(2);
      const ids = body.sessions.map((s: any) => s.id).sort();
      expect(ids).toEqual(['sess-visible-1', 'sess-visible-2']);
      // 4-field contract: id, title, updatedAt, messageCount
      for (const s of body.sessions) {
        expect(Object.keys(s).sort()).toEqual(['id', 'messageCount', 'title', 'updatedAt']);
      }
    });

    it('returns 5 messages for the visible-2 session (messageCount correctness)', () => {
      const r = runCli(env(), ['session', 'list', '--format', 'json']);
      const body = JSON.parse(r.stdout);
      const s = body.sessions.find((x: any) => x.id === 'sess-visible-2');
      expect(s.messageCount).toBe(5);
      const s1 = body.sessions.find((x: any) => x.id === 'sess-visible-1');
      expect(s1.messageCount).toBe(3);
    });

    it('text output renders 4 columns with title and messageCount', () => {
      const r = runCli(env(), ['session', 'list']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/ID\s+TITLE\s+UPDATED AT\s+MESSAGES/);
      expect(r.stdout).toContain('sess-visible-1');
      expect(r.stdout).toContain('sess-visible-2');
    });

    it('filters deleted / automation / gw-* / sub-agent from list', () => {
      const r = runCli(env(), ['session', 'list', '--format', 'json']);
      const body = JSON.parse(r.stdout);
      const ids = body.sessions.map((s: any) => s.id);
      // None of the 4 filtered categories should appear
      expect(ids).not.toContain('sess-automation-1');
      expect(ids).not.toContain('sess-sub-1');
      expect(ids).not.toContain('sess-deleted-1');
      expect(ids).not.toContain('gw-fake-gateway');
    });

    it('does not leak any internal field in the list response', () => {
      const r = runCli(env(), ['session', 'list', '--format', 'json']);
      const body = JSON.parse(r.stdout);
      const json = JSON.stringify(body).toLowerCase();
      const banned = [
        'working_directory',
        'system_prompt',
        'context_summary',
        'parent_id',
        'is_deleted',
        'agent_type',
        'agent_name',
        'permission_profile',
        'provider_id',
        'generation',
        'agent_profile_id',
        'context_summary_updated_at',
        'status',
        'project_name',
        'research_sessions',
        'messages',
        'content',
        'thinking',
        'tool_input',
        'is_main',
        'sessionid',
      ];
      for (const b of banned) {
        // word boundary — the literal "mode" inside "messageCount"
        // is not a leak because it's a substring of an allowed field
        const re = new RegExp(`\\b${b}\\b`);
        expect(re.test(json), `field "${b}" should not appear in list response`).toBe(false);
      }
    });

    it('respects --limit from the CLI entry point', () => {
      const r = runCli(env(), ['session', 'list', '--limit', '1', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.sessions).toHaveLength(1);
    });

    it('respects --offset from the CLI entry point (second page)', () => {
      const r = runCli(env(), ['session', 'list', '--offset', '1', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.sessions).toHaveLength(1);
      // ORDER BY updated_at DESC, id DESC; when updated_at is tied,
      // the larger id wins. sess-visible-2 > sess-visible-1 lex,
      // so page 1 is sess-visible-2 and page 2 is sess-visible-1.
      expect(body.sessions[0].id).toBe('sess-visible-1');
    });

    it('returns empty array when offset is past the end', () => {
      const r = runCli(env(), ['session', 'list', '--offset', '10000', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.sessions).toEqual([]);
    });

    it('returns 400 invalid_limit on --limit 0', () => {
      const r = runCli(env(), ['session', 'list', '--limit', '0']);
      expect(r.status).not.toBe(0);
      // Server's specific message includes "between 1 and 100"
      expect(r.stderr).toMatch(/between 1 and 100|limit/i);
    });

    it('returns 400 invalid_limit on --limit 200', () => {
      const r = runCli(env(), ['session', 'list', '--limit', '200']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/between 1 and 100|limit/i);
    });

    it('returns 400 invalid_offset on --offset -1', () => {
      const r = runCli(env(), ['session', 'list', '--offset', '-1']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/non-negative|offset/i);
    });

    it('returns 400 invalid_offset on --offset abc', () => {
      const r = runCli(env(), ['session', 'list', '--offset', 'abc']);
      expect(r.status).not.toBe(0);
      // Server's specific message is "must be a number" for non-numeric.
      // The test's regex matches any error mentioning the param name.
      expect(r.stderr).toMatch(/number|offset/i);
    });
  });

  describe('show (GET /v1/sessions/:id)', () => {
    it('returns 6-field DTO for a visible session', () => {
      const r = runCli(env(), ['session', 'show', 'sess-visible-1', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.id).toBe('sess-visible-1');
      expect(body.title).toBe('Visible Top-level #1');
      expect(typeof body.createdAt).toBe('number');
      expect(typeof body.updatedAt).toBe('number');
      expect(body.model).toBe('claude-test');
      expect(body.messageCount).toBe(3);
      // Strict 6-field contract
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'id',
        'messageCount',
        'model',
        'title',
        'updatedAt',
      ]);
    });

    it('text output renders title / createdAt / updatedAt / model / messages', () => {
      const r = runCli(env(), ['session', 'show', 'sess-visible-2']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('sess-visible-2');
      expect(r.stdout).toContain('Visible Plan-mode #2');
      expect(r.stdout).toContain('claude-test');
      expect(r.stdout).toMatch(/messages:\s+5/);
    });

    it('returns unified 404 for non-existent id', () => {
      const r = runCli(env(), ['session', 'show', 'sess-not-existing']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found/i);
    });

    it('returns unified 404 for automation id (filtered by mode)', () => {
      const r = runCli(env(), ['session', 'show', 'sess-automation-1']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found/i);
    });

    it('returns unified 404 for gateway id (filtered by gw- prefix)', () => {
      const r = runCli(env(), ['session', 'show', 'gw-fake-gateway']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found/i);
    });

    it('returns unified 404 for sub-agent id (filtered by parent_id)', () => {
      const r = runCli(env(), ['session', 'show', 'sess-sub-1']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found/i);
    });

    it('returns unified 404 for deleted id (filtered by is_deleted)', () => {
      const r = runCli(env(), ['session', 'show', 'sess-deleted-1']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found/i);
    });

    it('does not leak any internal field in the show response', () => {
      const r = runCli(env(), ['session', 'show', 'sess-visible-1', '--format', 'json']);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      const json = JSON.stringify(body).toLowerCase();
      const banned = [
        'working_directory',
        'system_prompt',
        'context_summary',
        'parent_id',
        'is_deleted',
        'agent_type',
        'agent_name',
        'permission_profile',
        'provider_id',
        'generation',
        'agent_profile_id',
        'context_summary_updated_at',
        'status',
        'project_name',
        'research_sessions',
        'messages',
        'content',
        'thinking',
        'tool_input',
        'is_main',
        'sessionid',
      ];
      for (const b of banned) {
        const re = new RegExp(`\\b${b}\\b`);
        expect(re.test(json), `field "${b}" should not appear in show response`).toBe(false);
      }
    });
  });

  describe('runtime / auth error paths', () => {
    it('returns exit 2 with a clear hint when the runtime file is missing', () => {
      // Simulate "GUI not running" by removing the runtime file.
      // We do not delete the temp userData (would break beforeAll),
      // just unlink the runtime file.
      const r = runCli(`DUYA_CLI_USER_DATA_DIR=${h!.userData}-nonexistent`, [
        'session',
        'list',
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/DUYA is not running|Open the DUYA app/);
    });

    it('returns auth_failed when the runtime file token is tampered', () => {
      // Write a runtime file with the right port but a wrong token.
      // This requires reaching into the test userData; we do that
      // by writing the file via a one-shot helper.
      const fs = require('node:fs');
      const runtimeFile = `${h!.userData}/runtime/cli-api.json`;
      const orig = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'));
      fs.writeFileSync(
        runtimeFile,
        JSON.stringify({ ...orig, token: 'deadbeef' + 'a'.repeat(56) }),
        'utf-8',
      );
      try {
        const r = runCli(env(), ['session', 'list']);
        expect(r.status).not.toBe(0);
        // 401 -> "Authentication failed" hint; client may re-read
        // runtime file (which still has the bad token) and report
        // auth_failed. Either message is acceptable.
        expect(r.stderr).toMatch(/Authentication failed|DUYA is not running/);
        // The token value MUST NOT appear anywhere in output.
        expect(r.stdout + r.stderr).not.toContain('deadbeef');
      } finally {
        // Restore the original runtime file for subsequent tests.
        fs.writeFileSync(runtimeFile, JSON.stringify(orig), 'utf-8');
      }
    });
  });
});
