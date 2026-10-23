/**
 * manifest-permission-source.test.ts — where a run's permission rules come
 * from, and what the run row is allowed to claim about them.
 *
 * ## The finding this pins
 *
 * `manifest-factory.ts` used to say, in its own header, that no Desktop call
 * site supplied a `PermissionRulesWire` — and the router's merged object was
 * the LEGACY permission-context shape
 * (`{ permissions: { allow, deny, ask, additionalDirectories } }`), not the
 * wire form. The factory therefore recorded every Desktop run's
 * `permissionPolicy` as `synthesised: true`, because converting one shape
 * into the other behind a cast would have put a value in the run row that no
 * reader could interpret.
 *
 * That was the honest state, and it was also a hole: a run that HAD rules
 * recorded a run that had none.
 *
 * ## What is pinned here
 *
 *  1. The wire form is checked, not cast, and it lands on the manifest with
 *     `synthesised: false` — the run row says the policy was resolved.
 *  2. The legacy shape is CONVERTED at the boundary, by a named conversion,
 *     and the result is attributed to `legacy_context_converted` — not to the
 *     chat request, and not to a cast.
 *  3. The conversion keeps the allow / deny / ask split, because the wire
 *     form has no dimension for behaviour and merging the three buckets would
 *     be a silent substitution.
 *  4. The legacy blob's directories become ROOTS, because that is what they
 *     are.
 *  5. The host's own turn path supplies a real wire form today: the turn
 *     overrides resolver validates it, and the manifest carries it.
 */

import { describe, expect, it } from 'vitest';
import { buildRunManifest } from '../src/manifest-factory.js';
import { resolveTurnOverrides } from '../src/run-turn-overrides.js';
import {
  convertLegacyPermissionContext,
  readPermissionRulesInput,
  readPermissionRulesWire,
} from '../src/authorization/permission-rules-source.js';

const BASE = { sessionId: 's-1', workingDirectory: '/repo' } as const;

describe('the wire form is checked, not cast', () => {
  it('records the permission rules on the manifest from a real wire-form source', () => {
    const { manifest } = buildRunManifest({
      ...BASE,
      permissionRules: { settings: ['Bash(git:*)', 'Read'] },
    });

    expect(manifest.permissionPolicy.rules).toEqual({ settings: ['Bash(git:*)', 'Read'] });
    // The run row says the policy was RESOLVED, not invented.
    expect(manifest.provenance.permissionPolicy).toEqual({
      source: 'host_chat_request',
      synthesised: false,
    });
  });

  it('refuses a rule table that is not the wire shape instead of carrying it', () => {
    // A `Map` serialises to `{}`, and a manifest whose rules are `{}` says
    // "no rule allows anything" while looking like "the rules were lost".
    expect(readPermissionRulesWire(new Map())).toBeNull();
    expect(readPermissionRulesWire({ settings: 'Read' })).toBeNull();
    expect(readPermissionRulesWire({ notASource: ['Read'] })).toBeNull();

    const { manifest } = buildRunManifest({
      ...BASE,
      permissionRules: { settings: 'Read' } as never,
    });
    expect(manifest.permissionPolicy.rules).toBeUndefined();
  });

  it('copies the rules, so a later mutation cannot reach a frozen manifest', () => {
    const rules = { settings: ['Read'] };
    const { manifest } = buildRunManifest({ ...BASE, permissionRules: rules });
    rules.settings.push('Bash');
    expect(manifest.permissionPolicy.rules).toEqual({ settings: ['Read'] });
  });
});

describe('the legacy shape is converted at the boundary', () => {
  const LEGACY = {
    permissions: {
      allow: ['Bash(git:*)'],
      deny: ['Bash(rm:*)'],
      ask: ['Write'],
      additionalDirectories: ['/repo/vendor'],
    },
  };

  it('converts the legacy context and attributes it to the conversion', () => {
    const { manifest } = buildRunManifest({ ...BASE, legacyPermissionContext: LEGACY });

    expect(manifest.permissionPolicy.rules).toEqual({
      settings: ['Bash(git:*)', 'Bash(rm:*)', 'Write'],
    });
    // NOT `host_chat_request`: the host did not resolve these, the Control
    // Plane converted them, and the run row says which happened.
    expect(manifest.provenance.permissionPolicy).toEqual({
      source: 'legacy_context_converted',
      synthesised: false,
    });
  });

  it('keeps the allow / deny / ask split, because the wire form cannot', () => {
    const { manifest } = buildRunManifest({ ...BASE, legacyPermissionContext: LEGACY });

    expect(manifest.permissionPolicy.ruleTables).toEqual({
      allow: { settings: ['Bash(git:*)'] },
      deny: { settings: ['Bash(rm:*)'] },
      ask: { settings: ['Write'] },
    });
  });

  it('records the legacy blob\'s directories as roots, not as rule strings', () => {
    const { manifest } = buildRunManifest({ ...BASE, legacyPermissionContext: LEGACY });
    // A directory is not a rule. It is a writable root.
    expect(manifest.roots).toEqual(['/repo', '/repo/vendor']);
  });

  it('tells the two shapes apart by inspection', () => {
    expect(readPermissionRulesInput({ settings: ['Read'] })).toMatchObject({ kind: 'wire' });
    expect(readPermissionRulesInput(LEGACY)).toMatchObject({ kind: 'legacy_context' });
    expect(readPermissionRulesInput(undefined)).toEqual({ kind: 'absent' });
    expect(readPermissionRulesInput('nope')).toMatchObject({ kind: 'invalid' });
  });

  it('lists the keys the conversion did not understand instead of dropping them silently', () => {
    const conversion = convertLegacyPermissionContext({
      permissions: { allow: ['Read'], somethingElse: ['x'] },
      defaultMode: 'default',
      mystery: 1,
    });
    expect(conversion.dropped).toEqual(['mystery', 'permissions.somethingElse']);
  });
});

describe('the host\'s own turn path supplies a real wire form', () => {
  it('carries the turn\'s validated rules onto the manifest', () => {
    // The turn path validates the rules before the manifest is built
    // (`readPermissionRules`), so what reaches the factory is the wire form
    // and not the legacy blob. That is the real source, and it is checked.
    const overrides = resolveTurnOverrides({
      request: { permissionRules: { settings: ['Bash(git:*)'] } },
      standing: {},
      options: {},
    });
    expect(overrides.ok).toBe(true);
    if (!overrides.ok) return;

    const { manifest } = buildRunManifest({
      ...BASE,
      permissionRules: overrides.permissionRules,
    });
    expect(manifest.permissionPolicy.rules).toEqual({ settings: ['Bash(git:*)'] });
    expect(manifest.provenance.permissionPolicy.synthesised).toBe(false);
  });
});

describe('the manifest records the isolation the run\'s commands get', () => {
  it('records the host\'s real isolation level, and never a better one', () => {
    // The sandbox adapter's `wrapCommand` had no production consumer, so the
    // worker announced a sandbox and ran every command without one. A run row
    // that says which level the commands got is worth more than a comment
    // that says the same thing.
    const { manifest } = buildRunManifest(BASE);
    const sandbox = manifest.sandbox;
    expect(sandbox).toBeDefined();
    if (sandbox === undefined) return;

    expect(['bubblewrap', 'none']).toContain(sandbox.provider);
    expect(typeof sandbox.isolated).toBe('boolean');
    // `isolated: true` is a claim about a real sandbox, so it needs a reason.
    expect(sandbox.reason.length).toBeGreaterThan(0);
    if (sandbox.provider === 'none') {
      expect(sandbox.isolated).toBe(false);
    }
  });
});
