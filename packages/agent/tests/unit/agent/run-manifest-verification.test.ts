/**
 * Plan 587 R2.2 — the worker verifies what it was given.
 *
 * Until now `chat:start` carried `manifestHash` and `inputRevision`, and the
 * worker logged them. Nothing compared them. This suite is the first thing
 * that makes those two fields mean anything, and it pins the five refusals as
 * FIVE outcomes rather than one error, because they are five different
 * incidents:
 *
 *  - the manifest on the wire is not the manifest the Control Plane froze
 *  - the manifest is a shape this build cannot read
 *  - the manifest is intact but names a capability the run cannot do without
 *  - the manifest is intact but its `cwd` is illegal
 *  - the input that arrived is not the input that was pinned
 *
 * Collapsing them would let a host retry the wrong one, and — worse — would
 * make "I could not verify this" indistinguishable from "I verified it and it
 * is fine", which is the silent substitution the plan forbids.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  manifestFingerprint,
  runInputRevision,
  type RunManifest,
} from '@duya/agent-protocol';
import {
  verifyRunManifestBinding,
  type WorkerCapabilitySet,
} from '../../../src/process/run-manifest-verification';

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
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
    capabilities: { profiles: ['coder'], modes: ['plan-task'], tools: ['Read', 'Bash'] },
    requiredCapabilities: ['streaming'],
    connectorBindings: [],
    env: { ref: 'env:session-1', hash: 'sha256:unresolved' },
    agent: { profileId: 'coder', model: 'm', providerId: 'p' },
    budget: { maxTurns: 8 },
    deterministic: false,
    ...overrides,
  } as RunManifest;
}

/** A worker that can do what the manifest above requires. */
const capableWorker: WorkerCapabilitySet = {
  available: ['streaming', 'tool.preview', 'Read', 'Bash', 'plan-task', 'coder'],
  catalogRevision: 'catalog-1',
  manifestVersion: 1,
};

const input = { sessionId: 's-1', prompt: 'do the thing', options: {} as Record<string, unknown> };

describe('R2.2: a run whose manifest checks out is accepted', () => {
  it('accepts and reports what it satisfied', () => {
    const m = manifest();
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.satisfied).toContain('streaming');
    expect(result.unsatisfiedOptional).toEqual([]);
  });
});

describe('R2.2: the five refusals are five outcomes, not one error', () => {
  it('manifest_hash_mismatch — the manifest is not the one that was frozen', () => {
    const m = manifest({ cwd: '/somewhere-else' });
    const result = verifyRunManifestBinding({
      manifest: m,
      // The hash of the ORIGINAL, before the manifest was rewritten.
      manifestHash: manifestFingerprint(manifest()),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('manifest_hash_mismatch');
    expect(result.expected).toBe(manifestFingerprint(manifest()));
    expect(result.actual).toBe(manifestFingerprint(m));
  });

  it('manifest_version_unsupported — the build cannot read the contract', () => {
    // The digest is CORRECT for a manifest this build must not interpret. A
    // hash check cannot even be meaningful here, which is exactly why this is
    // a different refusal from the one above rather than a special case of it.
    const m = manifest({ version: 2 as unknown as 1 });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('manifest_version_unsupported');
    expect(result.supported).toBe(1);
    expect(result.received).toBe(2);
  });

  it('required_capability_unavailable — the run said it cannot proceed without this', () => {
    const m = manifest({ requiredCapabilities: ['replay'] });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('required_capability_unavailable');
    expect(result.capability).toBe('replay');
  });

  it('cwd_illegal — an intact manifest can still name a cwd that is not allowed', () => {
    const m = manifest({ cwd: '/etc', roots: ['/repo'] });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cwd_illegal');
  });

  it('input_binding_mismatch — the prompt that arrived is not the prompt that was pinned', () => {
    const m = manifest();
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      // A side channel delivered a different prompt beside the one the run
      // layer resolved. This is the regression the digest exists to catch.
      received: { ...input, prompt: 'do something else entirely' },
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_binding_mismatch');
  });
});

describe('R2.2: the order of the checks is itself the contract', () => {
  it('version is read BEFORE the digest, because an unreadable manifest has no comparable digest', () => {
    // Every other check on this manifest is also violated. Reporting the hash
    // would blame the Control Plane for something the worker cannot evaluate.
    const m = manifest({ version: 2 as unknown as 1, cwd: '/etc', requiredCapabilities: ['replay'] });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: 'not-the-digest-of-anything',
      inputRevision: 'not-the-digest-of-anything',
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('manifest_version_unsupported');
  });

  it('the digest is checked BEFORE the content, so content claims are read only from a manifest known to be real', () => {
    const m = manifest({ cwd: '/etc' });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: '0'.repeat(64),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('manifest_hash_mismatch');
  });
});

describe('R2.2: required is not the same as absent', () => {
  it('an OPTIONAL capability this build lacks degrades the run and is recorded', () => {
    // `capabilities.tools` names a tool this build has never heard of. That is
    // version skew, not a broken contract, and refusing the run would turn
    // every skew into an outage.
    const m = manifest({ capabilities: { profiles: ['coder'], modes: ['plan-task'], tools: ['Read', 'QuantumRepl'] } });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unsatisfiedOptional).toEqual(['QuantumRepl']);
  });

  it('an ABSENT requiredCapabilities list demands nothing, so nothing is refused', () => {
    const m = manifest({ requiredCapabilities: undefined });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: { ...capableWorker, available: [] },
    });

    expect(result.ok).toBe(true);
  });
});

describe('R2.2: cwd is a boundary, not a claim', () => {
  it('accepts a cwd that is a real root', () => {
    const m = manifest({ roots: ['/repo', '/repo/sub'], cwd: '/repo/sub' });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a relative cwd', () => {
    const m = manifest({ roots: ['/repo'], cwd: 'repo' });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cwd_illegal');
  });

  it('rejects a cwd reached by traversal out of a legal root', () => {
    // The classic: the string starts with the root and is still outside it.
    // A prefix comparison would accept this; a path comparison does not.
    const m = manifest({ roots: ['/repo'], cwd: '/repo/../etc' });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cwd_illegal');
  });

  it('rejects a cwd outside every root even when one root is a path prefix of it', () => {
    const m = manifest({ roots: ['/repo/app'], cwd: '/repo/application' });
    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: manifestFingerprint(m),
      inputRevision: runInputRevision(input),
      received: input,
      worker: capableWorker,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cwd_illegal');
  });
});

describe('R2.2: the manifest the worker holds is not mutated by a later catalog change', () => {
  it('records the catalog revision difference instead of adopting it', () => {
    const m = manifest();
    const before = manifestFingerprint(m);

    const result = verifyRunManifestBinding({
      manifest: m,
      manifestHash: before,
      inputRevision: runInputRevision(input),
      received: input,
      // The process's own catalog has moved on since the run was frozen.
      worker: { ...capableWorker, catalogRevision: 'catalog-2' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reported, and explicitly NOT adopted: the run keeps executing against
    // the snapshot it was frozen with.
    expect(result.catalogRevision.adopted).toBe(false);
    expect(result.catalogRevision.worker).toBe('catalog-2');
    expect(manifestFingerprint(m)).toBe(before);
  });
});

describe('R2.2: the manifest that crosses the boundary carries no secret', () => {
  it('the accepted manifest names an env REFERENCE and never a value', () => {
    const m = manifest();
    const serialised = JSON.stringify(m).toLowerCase();
    expect(serialised).not.toContain('sk-');
    expect(Object.keys(m.env).sort()).toEqual(['hash', 'ref']);
  });
});
