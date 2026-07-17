import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultGatewayWorkspace,
  prepareGatewayWorkspace,
  resolveGatewayWorkspace,
} from './config';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('gateway workspace', () => {
  it('defaults to the user-scoped Duya workspace and expands tilde paths', () => {
    expect(getDefaultGatewayWorkspace()).toBe(join(homedir(), '.duya', 'workspace'));
    expect(resolveGatewayWorkspace({
      platforms: [],
      autoStart: false,
      workingDirectory: '~/.duya/workspace',
    })).toBe(join(homedir(), '.duya', 'workspace'));
  });

  it('creates the directory before it is used as a worker cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-gateway-workspace-'));
    tempRoots.push(root);
    const workspace = join(root, 'nested', 'workspace');

    expect(prepareGatewayWorkspace({
      platforms: [],
      autoStart: false,
      workingDirectory: workspace,
    })).toBe(workspace);
    expect(existsSync(workspace)).toBe(true);
  });
});
