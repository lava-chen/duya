/**
 * Plan 610 P8: the permission mode the manifest RECORDS must be the mode the
 * repository itself declares, for every mode the worker entry can resolve.
 *
 * ## What regressed
 *
 * The entry mapped `bypassPermissions` to `acceptEdits` and `auto` to `plan`,
 * under a comment claiming the manifest "names `acceptEdits` for" the
 * auto/full-access profile. It does not: `PermissionPolicyMode` carries
 * `bypassPermissions` itself. And `auto` is not `plan` -- `auto` default-allows
 * workspace-confined actions and asks for the rest, while `plan` means
 * read-only planning. The lossy pair was then frozen into two hand-written
 * unions, `'default' | 'acceptEdits' | 'plan'`, so the type made the bad
 * mapping look like the only one available.
 *
 * ## Why the oracle is `PERMISSION_MODE_CONFIG`, not a literal
 *
 * The expected side is `PERMISSION_MODE_CONFIG[mode].external` -- the
 * repository's own declaration of what each internal mode is called
 * externally. The actual side is what `buildLegacyRunManifest` puts in the
 * manifest. Those are different sources and can disagree, which is the point:
 * a table copied into this file would agree with itself while the entry drifted.
 *
 * ## What this does NOT claim
 *
 * That the recorded mode is ENFORCED. It is not. `RunEngineImpl.#dispatchCall`
 * asks `ports.approval.authorize` for every call with no mode shortcut, and the
 * engine reads this string only to stamp `ApprovalRequest.permissionMode`. The
 * decision is the entry's `askApproval` -> `requestPermission` bridge, running
 * against the untranslated mode set by `setPermissionMode`. This file is about
 * the record being honest, which is a separate property from the decision.
 */

import { describe, expect, it } from 'vitest';
import { PERMISSION_MODE_CONFIG } from '../../permissions/policy.js';
import { manifestPermissionMode, profileToAgentMode } from '../permission-profile-bridge.js';
import { buildLegacyRunManifest, type LegacyRunFacts } from '../run-composition.js';
import type { RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-perm' as RunId;

/** Every DB profile the worker entry's `profileToAgentMode` can produce. */
const PROFILES = ['default', 'auto', 'full_access'] as const;

function manifestFor(profile: string) {
  const agentMode = profileToAgentMode(profile);
  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-perm',
    projectId: null,
    revision: 'rev-perm',
    catalogRevision: 0,
    // The production seam. Deliberately NOT `toExternalPermissionMode` called
    // here: an earlier version of this file computed the mapping itself, which
    // meant the entry's call site was never exercised and a mutation that
    // restored the lossy ternary left every assertion in this file green.
    permissionMode: manifestPermissionMode(agentMode),
  };
  return { agentMode, manifest: buildLegacyRunManifest(facts) };
}

describe('the recorded permission mode is the one the repository declares', () => {
  it('records bypassPermissions for the full-access profile, not acceptEdits', () => {
    const { agentMode, manifest } = manifestFor('full_access');
    expect(agentMode).toBe('bypassPermissions');
    // The pre-fix entry produced `acceptEdits` here.
    expect(manifest.permissionPolicy.mode).toBe('bypassPermissions');
  });

  it('records default for auto, not plan', () => {
    const { agentMode, manifest } = manifestFor('auto');
    expect(agentMode).toBe('auto');
    // The pre-fix entry produced `plan` here. `PERMISSION_MODE_CONFIG.auto`
    // declares its external name to be `default`.
    expect(manifest.permissionPolicy.mode).toBe('default');
  });

  it('agrees with PERMISSION_MODE_CONFIG for every profile, not just the two fixed', () => {
    for (const profile of PROFILES) {
      const { agentMode, manifest } = manifestFor(profile);
      // Oracle read from the table; actual read from the built manifest, via
      // the production seam.
      expect({
        profile,
        recorded: manifest.permissionPolicy.mode,
      }).toEqual({
        profile,
        recorded: PERMISSION_MODE_CONFIG[agentMode]!.external,
      });
    }
  });

  it('never downgrades to a mode stricter than the session asked for', () => {
    // The failure this guards is a STRICTER record than reality, which is the
    // direction that reads as a safety property the run did not have.
    const strictness: Record<string, number> = {
      bypassPermissions: 0,
      default: 1,
      acceptEdits: 2,
      plan: 3,
      dontAsk: 4,
    };
    const recorded = PROFILES.map((p) => strictness[manifestFor(p).manifest.permissionPolicy.mode]);
    // In `PROFILES` order: default -> default (1), auto -> default (1),
    // full_access -> bypassPermissions (0). Nothing records plan (3).
    expect(recorded).toEqual([1, 1, 0]);
  });

  it('keeps hostSwitch at ask, so the record is not read as a standing grant', () => {
    // The composition hardcodes this. It matters to the reading above: a
    // manifest saying `bypassPermissions` with `hostSwitch: 'ask'` is an honest
    // description of a session whose CALLS are still gated, and it is what
    // makes the mode a record rather than the decision.
    expect(manifestFor('full_access').manifest.permissionPolicy.hostSwitch).toBe('ask');
  });
});