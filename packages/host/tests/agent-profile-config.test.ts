import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigAgents, resolveAgentConfig, resolveConfigRoot } from '../src/agent-profile-config.js';

const previousDataRoot = process.env.DUYA_DATA_ROOT;
const previousDefaultWorkspace = process.env.DUYA_DEFAULT_WORKSPACE;
const previousTestMode = process.env.DUYA_TEST;
const previousTestNamespace = process.env.DUYA_TEST_NAMESPACE;
let dataRoot: string | undefined;

afterEach(() => {
  if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
  if (previousDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
  else process.env.DUYA_DATA_ROOT = previousDataRoot;
  if (previousDefaultWorkspace === undefined) delete process.env.DUYA_DEFAULT_WORKSPACE;
  else process.env.DUYA_DEFAULT_WORKSPACE = previousDefaultWorkspace;
  if (previousTestMode === undefined) delete process.env.DUYA_TEST;
  else process.env.DUYA_TEST = previousTestMode;
  if (previousTestNamespace === undefined) delete process.env.DUYA_TEST_NAMESPACE;
  else process.env.DUYA_TEST_NAMESPACE = previousTestNamespace;
});

describe('Host agent profile config', () => {
  it('reads agent entries from the resolved Duya data root', async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-agent-config-'));
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    process.env.DUYA_DATA_ROOT = dataRoot;
    fs.writeFileSync(
      path.join(dataRoot, 'config.toml'),
      '[agents.research]\nname = "Research"\nmodel = "provider/model"\n',
    );

    expect(resolveConfigRoot()).toBe(dataRoot);
    expect(resolveAgentConfig('default', {}).workspace).toBe(path.join(dataRoot, 'workspace'));
    await expect(readConfigAgents()).resolves.toEqual({
      research: { name: 'Research', model: 'provider/model' },
    });
  });

  it('keeps workspace and instruction path expansion in the Host config adapter', () => {
    process.env.DUYA_DEFAULT_WORKSPACE = path.join(os.tmpdir(), 'duya-default-workspace');
    expect(resolveAgentConfig('research', { agents_md: '~/instructions.md' })).toMatchObject({
      workspace: process.env.DUYA_DEFAULT_WORKSPACE,
      agents_md: path.join(os.homedir(), 'instructions.md'),
    });
  });

  it('treats a missing config file as an empty custom-agent set', async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-agent-config-'));
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    process.env.DUYA_DATA_ROOT = dataRoot;

    await expect(readConfigAgents()).resolves.toEqual({});
  });
});
