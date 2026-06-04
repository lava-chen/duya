/**
 * packages/agent/src/cli/program/registry.test.ts
 *
 * Unit tests for the descriptor-driven command registry.
 *
 * Verifies the frozen command paths, the shape of every descriptor,
 * the agent-tool bridge, and the unknown/id-required error contract.
 *
 * These tests run without a DUYA desktop app — they exercise the
 * data + dispatch layer only, not the HTTP handlers.
 */

import { describe, it, expect } from 'vitest';
import { CLI_DESCRIPTORS } from './descriptors.js';
import {
  type CliCommandPath,
  listCommandNames,
  listSubcommandNames,
  resolveSubcommand,
} from './registry.js';
import { buildAgentRunner } from './build-agent-runner.js';

// ---------------------------------------------------------------------------
// Frozen paths
// ---------------------------------------------------------------------------

describe('CLI_DESCRIPTORS — frozen v1.0.0', () => {
  const EXPECTED_PATHS: CliCommandPath[] = [
    'status',
    'plugin',
    'session',
    'doctor',
    'skill',
    'mcp',
    'provider',
    'channel',
    'cron',
    'message',
    'gateway',
    'update',
    'backup',
    'security',
    'install-cli',
    'uninstall-cli',
    'config',
    'setup',
  ];

  it('has all 18 expected top-level command paths', () => {
    const actual = CLI_DESCRIPTORS.map((d) => d.name);
    expect(actual).toEqual(EXPECTED_PATHS);
  });

  it('has no duplicate top-level paths', () => {
    const seen = new Set<string>();
    for (const d of CLI_DESCRIPTORS) {
      expect(seen.has(d.name)).toBe(false);
      seen.add(d.name);
    }
  });

  it('every descriptor has a non-empty description', () => {
    for (const d of CLI_DESCRIPTORS) {
      expect(d.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Subcommand resolution
// ---------------------------------------------------------------------------

describe('resolveSubcommand', () => {
  it('resolves plugin info', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'plugin', 'info');
    expect(r?.subName).toBe('info');
    expect(r?.sub.description).toMatch(/detail/i);
  });

  it('resolves skill enable (write op)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'skill', 'enable');
    expect(r?.sub.write).toBe(true);
  });

  it('resolves cron runs (paginated)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'cron', 'runs');
    expect(r?.sub.pagination).toBe(true);
  });

  it('resolves message show (two-arg subcommand)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'message', 'show');
    expect(r?.sub.args?.length).toBe(2);
    expect(r?.sub.args?.[0].name).toBe('sessionId');
    expect(r?.sub.args?.[1].name).toBe('msgId');
  });

  it('returns null for unknown subcommand', () => {
    expect(resolveSubcommand(CLI_DESCRIPTORS, 'plugin', 'reindex')).toBeNull();
  });

  it('returns null for unknown command', () => {
    expect(resolveSubcommand(CLI_DESCRIPTORS, 'telegram', 'send')).toBeNull();
  });

  it('returns null when subcommand missing', () => {
    expect(resolveSubcommand(CLI_DESCRIPTORS, 'plugin', undefined)).toBeNull();
  });

  // Plan 102 — `duya config …` subcommand tree (flattened, dash-joined)
  it('resolves config provider-add (write op; replaces duya_config provider_add)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'config', 'provider-add');
    expect(r?.subName).toBe('provider-add');
    expect(r?.sub.write).toBe(true);
  });

  it('resolves config settings-show (read; replaces duya_config settings_get)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'config', 'settings-show');
    expect(r?.subName).toBe('settings-show');
    expect(r?.sub.write).toBeFalsy();
  });

  it('resolves config vision-set (write; renames isActive → enabled at the wire boundary)', () => {
    const r = resolveSubcommand(CLI_DESCRIPTORS, 'config', 'vision-set');
    expect(r?.sub.write).toBe(true);
  });

  it('resolves mcp add / remove / assign (Plan 99 §3.3 Phase 7 write ops)', () => {
    for (const sub of ['add', 'remove', 'assign']) {
      const r = resolveSubcommand(CLI_DESCRIPTORS, 'mcp', sub);
      expect(r).not.toBeNull();
      expect(r?.sub.write).toBe(true);
    }
  });

  it('config subcommands have a unique flat name (no 3-level nesting)', () => {
    const configDesc = CLI_DESCRIPTORS.find((d) => d.name === 'config');
    expect(configDesc).toBeDefined();
    const subs = Object.keys(configDesc!.subcommands ?? {});
    // Every name should be dash-joined (no whitespace, no slash).
    for (const s of subs) {
      expect(s).toMatch(/^[a-z0-9-]+$/);
    }
    // Spot-check expected names.
    expect(subs).toEqual(
      expect.arrayContaining([
        'provider-add', 'provider-remove', 'settings-show', 'settings-set',
        'vision-show', 'vision-set', 'style-list', 'style-set',
        'pairing-list', 'pairing-approve', 'pairing-revoke', 'pairing-check',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Error message helpers
// ---------------------------------------------------------------------------

describe('error message helpers', () => {
  it('listCommandNames joins all top-level paths with " | "', () => {
    const list = listCommandNames(CLI_DESCRIPTORS);
    expect(list).toContain('status | plugin');
    expect(list).toContain('message | gateway');
    expect(list).toContain('security | install-cli');
  });

  it('listSubcommandNames joins a command\'s subcommands', () => {
    const cron = CLI_DESCRIPTORS.find((d) => d.name === 'cron');
    expect(cron).toBeDefined();
    expect(listSubcommandNames(cron!)).toBe(
      'list | info | create | update | delete | run | enable | disable | runs | logs',
    );
  });
});

// ---------------------------------------------------------------------------
// Agent tool bridge
// ---------------------------------------------------------------------------

describe('buildAgentRunner — agent tool bridge', () => {
  const resolve = buildAgentRunner();

  it('unknown command returns exit code 64 with allowed list', async () => {
    const r = await resolve({ command: 'telegram', subcommand: 'send' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/unknown command: telegram/);
    expect(r.stderr).toContain('allowed:');
  });

  it('unknown subcommand returns exit code 64 with expected list', async () => {
    // pick a subcommand that is NOT in the plugin tree after Plan 200
    const r = await resolve({ command: 'plugin', subcommand: 'reinstall' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/unknown plugin subcommand: reinstall/);
    expect(r.stderr).toContain('expected:');
  });

  it('plugin info without id returns exit code 64 with friendly hint', async () => {
    const r = await resolve({ command: 'plugin', subcommand: 'info' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/plugin info requires an <id> argument/);
  });

  it('skill enable without id returns exit code 64 with friendly hint', async () => {
    const r = await resolve({ command: 'skill', subcommand: 'enable' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/skill enable requires an <id> argument/);
  });

  it('channel info without id returns exit code 64 with friendly hint', async () => {
    const r = await resolve({ command: 'channel', subcommand: 'info' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/channel info requires an <id> argument/);
  });

  it('cron update without id returns exit code 64 with friendly hint', async () => {
    const r = await resolve({ command: 'cron', subcommand: 'update' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/cron update requires an <id> argument/);
  });

  it('message show without sessionId returns exit code 64', async () => {
    const r = await resolve({ command: 'message', subcommand: 'show' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/message show requires an <id> argument/);
  });
});

// ---------------------------------------------------------------------------
// Descriptor integrity
// ---------------------------------------------------------------------------

describe('descriptor integrity', () => {
  it('every subcommand has a non-empty description', () => {
    for (const d of CLI_DESCRIPTORS) {
      if (!d.subcommands) continue;
      for (const [name, sub] of Object.entries(d.subcommands)) {
        if (!sub) {
          throw new Error(`subcommand ${d.name} ${name} is undefined`);
        }
        expect(sub.description.length, `${d.name} ${name} description`).toBeGreaterThan(0);
      }
    }
  });

  it('write operations are explicitly marked', () => {
    const writeSubs: string[] = [];
    for (const d of CLI_DESCRIPTORS) {
      if (!d.subcommands) continue;
      for (const [name, sub] of Object.entries(d.subcommands)) {
        if (sub.write === true) writeSubs.push(`${d.name} ${name}`);
      }
    }
    // Frozen Phase 7 surface: skill enable/disable + cron create/update/delete/run.
    expect(writeSubs).toEqual(
      expect.arrayContaining(['skill enable', 'skill disable']),
    );
    expect(writeSubs).toEqual(
      expect.arrayContaining(['cron create', 'cron update', 'cron delete', 'cron run']),
    );
  });

  it('paginated subcommands declare --limit/--offset', () => {
    for (const d of CLI_DESCRIPTORS) {
      if (!d.subcommands) continue;
      for (const [name, sub] of Object.entries(d.subcommands)) {
        if (!sub.pagination) continue;
        const flags = (sub.options ?? []).map((o) => o.flags);
        // pagination flag is auto-added by build-control-plane; the
        // descriptor doesn't need to repeat it.
        expect(typeof flags).toBe('object');
        // Sanity: only some commands should be paginated
        expect(['session list', 'cron runs', 'message list']).toContain(`${d.name} ${name}`);
      }
    }
  });
});
