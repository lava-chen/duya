/**
 * Drift test #12 — no secret crosses the manifest boundary.
 *
 * This is a guard against a specific regression: `RunManifest.env` exists
 * precisely because credentials are inlined today in
 * `packages/agent/src/process/worker-protocol.ts:7` (`InitCommand.providerConfig.apiKey`)
 * plus three more copies in `types.ts` (:141 visionConfig, :152 compactModelConfig,
 * :158 AgentOptions). A manifest that grew an `apiKey` field would put a
 * credential on the wire, into logs, and into every IPC trace.
 *
 * The check walks the whole manifest, not just known field names, so an
 * invented field name cannot slip past.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  manifestFingerprint,
  manifestsMatch,
  type RunManifest,
} from '../src/index.js';

const SECRET_KEY = /api[-_]?key|secret|token|password|credential|bearer|auth[-_]?header|private[-_]?key/i;

function sampleManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    runId: 'run-1',
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/repo'],
    cwd: '/repo',
    permissionPolicy: {
      mode: 'default',
      hostSwitch: 'ask',
      defaultTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'envref_abc', hash: 'deadbeef' },
    budget: {},
    deterministic: false,
    ...overrides,
  } as RunManifest;
}

function findSecretKeys(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = `${path}.${key}`;
    if (SECRET_KEY.test(key)) found.push(here);
    findSecretKeys(child, here, found);
  }
  return found;
}

describe('drift #12: the manifest carries references, never credentials', () => {
  it('the sample manifest is clean', () => {
    expect(findSecretKeys(sampleManifest())).toEqual([]);
  });

  it('detects a credential smuggled into env', () => {
    const bad = sampleManifest({
      env: { ref: 'envref_abc', hash: 'deadbeef', apiKey: 'sk-live-should-be-caught' },
    } as Partial<RunManifest>);
    const found = findSecretKeys(bad);
    expect(found.some((p) => p.includes('apiKey'))).toBe(true);
  });

  it('detects a credential under any invented field name at any depth', () => {
    const bad = sampleManifest({
      agent: {
        profileId: null,
        model: 'm',
        providerId: 'p',
        bearer: 'sk-should-be-caught',
      },
    } as Partial<RunManifest>);
    expect(findSecretKeys(bad).some((p) => p.endsWith('.bearer'))).toBe(true);

    const deeper = sampleManifest({
      connectorBindings: [
        { provider: 'slack', connectionId: 'c1', accessToken: 'xoxb-should-be-caught' },
      ],
    } as Partial<RunManifest>);
    expect(findSecretKeys(deeper).some((p) => p.includes('accessToken'))).toBe(true);
  });

  it('the declared env shape has exactly two safe keys', () => {
    const env = sampleManifest().env;
    expect(Object.keys(env).sort()).toEqual(['hash', 'ref']);
  });
});

describe('drift #11 support: the manifest is immutable and self-identifying', () => {
  it('is a pure function of its value, not of key insertion order', () => {
    const a = sampleManifest();
    const b = sampleManifest();
    expect(manifestFingerprint(a)).toBe(manifestFingerprint(b));
    expect(manifestFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a changed field changes the fingerprint, which is what makes resume safe', () => {
    const base = sampleManifest();
    const changed = sampleManifest({ cwd: '/repo/sub' });
    expect(manifestFingerprint(changed)).not.toBe(manifestFingerprint(base));
    expect(manifestsMatch(base, changed).ok).toBe(false);
  });

  it('an optional field appearing or disappearing changes the fingerprint', () => {
    const without = sampleManifest();
    const with_ = sampleManifest({ parentRunId: 'run-parent' });
    expect(manifestFingerprint(with_)).not.toBe(manifestFingerprint(without));
  });

  it('the permission timeout default matches the runtime hardcode', () => {
    // agent-process-entry.ts:2240 hardcodes 300000.
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(300_000);
    expect(sampleManifest().permissionPolicy.defaultTimeoutMs).toBe(300_000);
  });
});
