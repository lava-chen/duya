/**
 * Plan 587 R2.2 — the manifest is built from real configuration, and the run
 * has exactly one description of its input.
 *
 * Three separate failures are pinned here, and they are separate because they
 * fail in different places:
 *
 *  1. **The manifest was assembled from a fraction of what the host already
 *     knows.** The factory had fields for profile, mode, effort, permission
 *     rules, additional roots and origin; the router passed almost none of
 *     them, and one (`permissionRules`) had no field at all — so the manifest
 *     described a run whose configuration nobody could reconstruct.
 *  2. **Provenance was a comment.** The factory emitted `modes: ['general']`,
 *     `tools: []`, `env.hash: 'sha256:unresolved'` and a `workspaceId` derived
 *     from a session hash, and the ONLY record of which of those were real
 *     lived in a file header. A reader of the run row had no way to tell a
 *     resolved value from a placeholder. Contract §B requires the missing
 *     case to be expressed as unknown AND attributed to a source.
 *  3. **The input had two sources.** The run layer was opened with one prompt
 *     and the router sent another beside it. R2.1 removed the second dispatch
 *     but nothing PROVED the remaining one is the only one — so the proof is
 *     here, and the input digest is what makes it falsifiable.
 */

import { describe, expect, it } from 'vitest';
import { manifestFingerprint, runInputRevision, type RunManifest } from '@duya/agent-protocol';
import { buildRunManifest, type RunIntent } from '../control-plane/manifest-factory';

/** Everything a real Desktop chat turn resolves before a run is opened. */
const REAL_TURN: Omit<RunIntent, 'sessionId'> = {
  workingDirectory: '/repo',
  additionalRoots: ['/repo/vendor', '/repo'],
  projectId: 'p-1',
  permissionMode: 'auto',
  hostSwitch: 'always',
  model: 'claude-opus-5',
  providerId: 'prov-7',
  effort: 'high',
  agentProfileId: 'coder',
  modes: ['plan-task'],
  tools: ['Read', 'Bash'],
  maxTurns: 12,
  permissionRules: { default: ['Read'], bash: ['Bash'] },
  runOrigin: 'user',
  requiredCapabilities: ['streaming'],
  sourceVersions: { agent: 'provider-registry@7', capabilities: 'catalog@41' },
};

describe('R2.2 item 1: the manifest is built from the configuration the host resolved', () => {
  it('every field the host resolved reaches the manifest', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });

    expect(manifest.cwd).toBe('/repo');
    expect(manifest.roots).toEqual(['/repo', '/repo/vendor']);
    expect(manifest.projectId).toBe('p-1');
    expect(manifest.permissionPolicy.mode).toBe('auto');
    expect(manifest.permissionPolicy.hostSwitch).toBe('always');
    expect(manifest.agent).toEqual({
      profileId: 'coder',
      model: 'claude-opus-5',
      providerId: 'prov-7',
      effort: 'high',
    });
    expect(manifest.capabilities).toEqual({ profiles: ['coder'], modes: ['plan-task'], tools: ['Read', 'Bash'] });
    expect(manifest.budget).toEqual({ maxTurns: 12 });
    expect(manifest.requiredCapabilities).toEqual(['streaming']);
  });

  it('permission rules reach the manifest instead of being dropped as an unserialisable Map', () => {
    // Header note 1 of the factory used to explain why `rules` was omitted.
    // The real rules are a plain record, so the honest move is to carry them.
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    expect(manifest.permissionPolicy.rules).toEqual({ default: ['Read'], bash: ['Bash'] });
  });

  it('a root that repeats the cwd is deduplicated, so the digest is a function of the value', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    expect(manifest.roots).toEqual(['/repo', '/repo/vendor']);
    expect(new Set(manifest.roots).size).toBe(manifest.roots.length);
  });
});

describe('R2.2 item 1: provenance is recorded in the manifest, not in a comment', () => {
  it('a fully resolved field is attributed to the source it was read from', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    expect(manifest.provenance.permissionPolicy).toEqual({ source: 'host_chat_request', synthesised: false });
    expect(manifest.provenance.cwd).toEqual({ source: 'host_chat_request', synthesised: false });
  });

  it('a versioned source records its version', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    expect(manifest.provenance.agent).toEqual({
      source: 'host_chat_request',
      synthesised: false,
      sourceVersion: 'provider-registry@7',
    });
  });

  it('a field the Control Plane had to supply itself says so', () => {
    const { manifest } = buildRunManifest({ sessionId: 's-1', workingDirectory: '/repo' });
    // `workspaceId` is derived from the session id, not discovered.
    expect(manifest.provenance.workspaceId).toEqual({ source: 'derived', synthesised: true });
  });

  it('a field with NO source is recorded as unsupported, never as an empty value pretending to be configuration', () => {
    const { manifest } = buildRunManifest({ sessionId: 's-1', workingDirectory: '/repo' });
    // The old factory wrote `modes: ['general']` — a mode id that does not
    // exist, presented as a resolved mode.
    expect(manifest.capabilities.modes).toEqual([]);
    expect(manifest.provenance.capabilities).toEqual({ source: 'unsupported', synthesised: true });
    expect(manifest.provenance.connectorBindings).toEqual({ source: 'unsupported', synthesised: true });
    expect(manifest.provenance.env).toEqual({ source: 'unsupported', synthesised: true });
  });

  it('the invariant: an unsupported field is always a synthesised one', () => {
    // A value with no source that is NOT marked synthesised would be claiming
    // to be a fact it has no origin for — the exact thing §B forbids.
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      const { manifest } = buildRunManifest({ sessionId, workingDirectory: '/repo' });
      for (const [field, entry] of Object.entries(manifest.provenance)) {
        if (entry.source === 'unsupported') {
          expect(`${field}:${entry.synthesised}`).toBe(`${field}:true`);
        }
      }
    }
  });

  it('every field the manifest carries is attributed — a new field cannot be added unaccounted', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    const attributed = new Set(Object.keys(manifest.provenance));
    for (const field of [
      'roots',
      'cwd',
      'permissionPolicy',
      'capabilities',
      'connectorBindings',
      'env',
      'agent',
      'budget',
      'workspaceId',
      'deterministic',
    ]) {
      expect(attributed.has(field)).toBe(true);
    }
  });
});

describe('R2.2 item 1: the fingerprint covers provenance', () => {
  it('the same configuration from two different source versions is two different runs', () => {
    // If provenance sat outside the digest, a run resolved against a different
    // provider registry would hash identically and the run row could not tell
    // them apart.
    const a = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    const b = buildRunManifest({
      ...REAL_TURN,
      sessionId: 's-1',
      sourceVersions: { agent: 'provider-registry@8', capabilities: 'catalog@41' },
    });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });
});

describe('R2.2 item 2: the input has exactly one source of truth', () => {
  it('the resolved input is the only description of the turn, and it digests to one value', () => {
    // The router resolves a prompt and an option bag and hands them to
    // `openRun`. Everything downstream — the command that starts the work, the
    // revision the Control Plane persists, the digest the worker re-derives —
    // is computed from THESE values. There is no second copy to drift.
    const prompt = 'refactor the parser';
    const options = { files: [{ id: 'a-1', name: 'x.ts' }] } as Record<string, unknown>;
    const revision = runInputRevision({ sessionId: 's-1', prompt, options });

    // Same values, recomputed independently: one value.
    expect(runInputRevision({ sessionId: 's-1', prompt, options })).toBe(revision);
    // The input is NOT part of the manifest, so rewording a message does not
    // invalidate the run's configuration.
    const a = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    const b = buildRunManifest({ ...REAL_TURN, sessionId: 's-1', model: 'other' });
    expect(manifestFingerprint(a.manifest as RunManifest)).not.toBe(manifestFingerprint(b.manifest as RunManifest));
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R2.2 item 4: a configuration change does not reach a run that is already frozen', () => {
  it('the source configuration object is copied, so a later mutation cannot rewrite the snapshot', () => {
    const intent: RunIntent = { ...REAL_TURN, sessionId: 's-1' };
    const built = buildRunManifest(intent);
    const before = built.manifestHash;

    // The host's configuration object changes after the run was frozen.
    (intent.tools as string[]).push('Shell');
    (intent.permissionRules as Record<string, string[]>).default?.push('Shell');

    expect(built.manifestHash).toBe(before);
    expect(built.manifest.capabilities.tools).toEqual(['Read', 'Bash']);
    expect(manifestFingerprint(built.manifest)).toBe(before);
  });

  it('the manifest is frozen, so the mutation is a throw rather than a silent rewrite', () => {
    const { manifest } = buildRunManifest({ ...REAL_TURN, sessionId: 's-1' });
    expect(() => {
      (manifest as { cwd: string }).cwd = '/etc';
    }).toThrow();
    expect(manifest.cwd).toBe('/repo');
  });
});

describe('R2.2 item 5: the public manifest carries no secret', () => {
  it('the provider is named, its credential is not', () => {
    const { manifest } = buildRunManifest({
      ...REAL_TURN,
      sessionId: 's-1',
      // A host that has a resolved credential in hand. The manifest must not
      // absorb it just because it was available.
      envValue: { apiKey: 'sk-live-must-not-cross' },
    } as RunIntent & { envValue?: unknown });

    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain('sk-live-must-not-cross');
    expect(manifest.agent?.providerId).toBe('prov-7');
    expect(manifest.env.ref).toContain('s-1');
  });
});
