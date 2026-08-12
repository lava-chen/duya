// packages/agent/tests/mcp/config.test.ts
// Unit tests for the worker-side user-MCP read path.
//
// Plan 334 moved user-managed MCP servers from the legacy `mcp.toml`
// into the unified `~/.duya/config.toml` (`[mcp_servers.*]`). The
// worker MUST read the same source as the main process, otherwise
// servers configured in config.toml (e.g. codegraph) never reach the
// agent tool list. These tests pin `readUserMcpToml` to config.toml.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// A temp dir stands in for the user's home so tests never touch the
// real ~/.duya. `os` is mocked below to report this path.
const { fakeHome } = vi.hoisted(() => ({ fakeHome: { value: '' } }));

vi.mock('os', () => ({
  homedir: () => fakeHome.value,
}));

import { readUserMcpToml } from '../../src/mcp/config.js';

beforeEach(() => {
  const tmp = process.env.TEMP || '/tmp';
  fakeHome.value = path.join(tmp, 'duya-mcp-config-test-home');
  fs.rmSync(fakeHome.value, { recursive: true, force: true });
  fs.mkdirSync(fakeHome.value, { recursive: true });
});

afterEach(() => {
  delete process.env.DUYA_TEST;
  delete process.env.DUYA_TEST_NAMESPACE;
  fs.rmSync(fakeHome.value, { recursive: true, force: true });
});

function writeConfigToml(relPath: string, content: string): void {
  const p = path.join(fakeHome.value, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

describe('readUserMcpToml — reads config.toml (not legacy mcp.toml)', () => {
  it('returns the [mcp_servers] from config.toml', async () => {
    writeConfigToml(
      '.duya/config.toml',
      [
        '[mcp_servers.codegraph]',
        'name = "codegraph"',
        'command = "codegraph"',
        'args = [ "serve", "--mcp" ]',
        'enabled = true',
      ].join('\n'),
    );
    const servers = await readUserMcpToml();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('codegraph');
    expect(servers[0].command).toBe('codegraph');
    expect(servers[0].enabled).toBe(true);
  });

  it('reads from the test-namespace root when DUYA_TEST is set', async () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = 'ns1';
    writeConfigToml(
      '.duya/test-namespaces/ns1/config.toml',
      '[mcp_servers.foo]\ncommand = "foo"\nenabled = true\n',
    );
    const servers = await readUserMcpToml();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('foo');
  });

  it('returns [] when config.toml does not exist', async () => {
    const servers = await readUserMcpToml();
    expect(servers).toEqual([]);
  });

  it('ignores a legacy mcp.toml that is no longer sourced', async () => {
    writeConfigToml(
      'mcp.toml',
      '[mcp_servers.legacy]\ncommand = "legacy"\nenabled = true\n',
    );
    writeConfigToml(
      '.duya/config.toml',
      '[mcp_servers.codegraph]\ncommand = "codegraph"\nenabled = true\n',
    );
    const servers = await readUserMcpToml();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('codegraph');
  });
});