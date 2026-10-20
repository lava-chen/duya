/**
 * run-turn-overrides.test.ts — the Host's adjudication of one turn's
 * configuration.
 *
 * ## What this file is for
 *
 * The Host decides what a turn runs under. Before this rule existed, the
 * decision was the CALLER's: `StartAgentRunInput.options` was a free bag, so
 * a caller could name the permission mode in it and the bag's value would
 * travel to the worker as if the Host had resolved it.
 *
 * So this file pins three things, and each one is a way the bypass could come
 * back:
 *
 *  1. A value the Host cannot honour REFUSES the turn. It does not fall back
 *     to a default, because a run under a mode the caller did not ask for is
 *     a run the caller believes it asked for.
 *  2. The bag may not state what the Host decides. The adjudicated keys are
 *     taken out of it, and the Host's resolved values are what go on the wire.
 *  3. A delegated turn is held to its parent's recorded policy. A child may
 *     ask for a NARROWER mode and never a wider one.
 *
 * ## Why it is a separate file from the run-execution tests
 *
 * Every case here is a pure function over values. The end-to-end path — the
 * manifest, the worker command, the durable run row — is pinned in
 * `run-execution-turn-contract.test.ts`. Splitting them means a failure here
 * names the RULE that broke, and a failure there names the PATH.
 */

import { describe, expect, it } from 'vitest';
import { resolveTurnOverrides } from '../src/run-turn-overrides.js';

const NO_CONTEXT = {
  standing: {},
  options: {},
} as const;

describe('the Host resolves a turn\'s permission mode', () => {
  it('accepts a mode the protocol has, and carries it into the bag it hands on', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 'acceptEdits' },
      ...NO_CONTEXT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.permissionMode).toBe('acceptEdits');
    // The worker reads the turn's options, so the resolved value has to be
    // in them: a mode recorded on the manifest and a mode the worker never
    // sees are two different runs.
    expect(resolved.options['permissionMode']).toBe('acceptEdits');
  });

  it('REFUSES a mode the protocol does not have, and names the field', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 'auto' },
      ...NO_CONTEXT,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // 'auto' is the AGENT's mode, not the protocol's. A caller that sends it
    // must be told, not silently given 'default'.
    expect(resolved.field).toBe('permissionMode');
    expect(resolved.reason).toContain('bypassPermissions');
  });

  it('REFUSES a mode that is not a string at all', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 7 },
      ...NO_CONTEXT,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('permissionMode');
  });

  it('falls back to the session\'s own mode when the turn asks for none', () => {
    const resolved = resolveTurnOverrides({
      request: {},
      standing: { permissionMode: 'plan' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.permissionMode).toBe('plan');
  });
});

describe('the free option bag may not state what the Host decides', () => {
  it('takes the adjudicated keys out of the bag', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 'acceptEdits' },
      standing: {},
      options: {
        permissionMode: 'bypassPermissions',
        permissionModeOverride: 'bypassPermissions',
        agentProfileId: 'smuggled',
        displayContent: 'kept',
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options).not.toHaveProperty('permissionModeOverride');
    expect(resolved.options['permissionMode']).toBe('acceptEdits');
    expect(resolved.options['agentProfileId']).toBeUndefined();
    // Everything the Host does not decide still travels.
    expect(resolved.options['displayContent']).toBe('kept');
    expect(resolved.strippedOptionKeys).toEqual(
      expect.arrayContaining(['permissionMode', 'permissionModeOverride', 'agentProfileId']),
    );
  });

  it('refuses a bag that tries to carry the legacy agent-space override alone', () => {
    // The bag's `permissionModeOverride` is the AGENT's mode vocabulary. It
    // is stripped rather than honoured, so the only way to state a mode is
    // the typed field the Host resolves.
    const resolved = resolveTurnOverrides({
      request: {},
      standing: { permissionMode: 'default' },
      options: { permissionModeOverride: 'bypassPermissions' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options).not.toHaveProperty('permissionModeOverride');
    expect(resolved.permissionMode).toBe('default');
  });

  it('keeps the bag\'s own effort when the turn names none, and lifts it into the typed field', () => {
    const resolved = resolveTurnOverrides({
      request: {},
      standing: {},
      options: { effort: 'high' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.effort).toBe('high');
    expect(resolved.options['effort']).toBe('high');
  });

  it('lets the typed effort win over the bag\'s copy', () => {
    const resolved = resolveTurnOverrides({
      request: { effort: 'max' },
      standing: {},
      options: { effort: 'low' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.effort).toBe('max');
  });

  it('REFUSES an effort that is not a non-empty string', () => {
    const resolved = resolveTurnOverrides({
      request: { effort: '  ' },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('effort');
  });
});

describe('the per-turn agent profile', () => {
  it('overrides the session\'s profile and travels in the bag', () => {
    const resolved = resolveTurnOverrides({
      request: { agentProfileId: 'coder' },
      standing: { agentProfileId: 'researcher' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.agentProfileId).toBe('coder');
    expect(resolved.options['agentProfileId']).toBe('coder');
  });

  it('falls back to the session\'s profile when the turn names none', () => {
    const resolved = resolveTurnOverrides({
      request: {},
      standing: { agentProfileId: 'researcher' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.agentProfileId).toBe('researcher');
  });

  it('treats an explicit null as "no profile", not as "unset"', () => {
    const resolved = resolveTurnOverrides({
      request: { agentProfileId: null },
      standing: { agentProfileId: 'researcher' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.agentProfileId).toBeNull();
  });

  it('REFUSES a profile that is neither a non-empty string nor null', () => {
    const resolved = resolveTurnOverrides({
      request: { agentProfileId: '' },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('agentProfileId');
  });
});

describe('a delegated turn is held to its parent\'s policy', () => {
  it('refuses to run WIDER than the parent', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 'bypassPermissions' },
      standing: { permissionMode: 'default' },
      parent: { permissionMode: 'default' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The parent's mode is the ceiling: the child's request is answered with
    // the parent's mode, not with the child's.
    expect(resolved.permissionMode).toBe('default');
    expect(resolved.options['permissionMode']).toBe('default');
  });

  it('lets the child NARROW below the parent', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionMode: 'plan' },
      standing: { permissionMode: 'bypassPermissions' },
      parent: { permissionMode: 'bypassPermissions' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.permissionMode).toBe('plan');
  });

  it('holds a child that asked for nothing to the parent\'s mode', () => {
    const resolved = resolveTurnOverrides({
      request: {},
      standing: { permissionMode: 'bypassPermissions' },
      parent: { permissionMode: 'default' },
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.permissionMode).toBe('default');
  });

  it('reads the parent\'s mode as a ceiling, not as a floor', () => {
    // 'plan' is the narrowest mode there is. A parent in 'plan' cannot be
    // widened by a child, and a child in 'plan' is not lifted to its
    // parent's 'default'.
    const narrowed = resolveTurnOverrides({
      request: { permissionMode: 'bypassPermissions' },
      standing: {},
      parent: { permissionMode: 'plan' },
      options: {},
    });
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.permissionMode).toBe('plan');
  });
});

describe('the turn\'s declarations', () => {
  it('carries the declared modes and tools', () => {
    const resolved = resolveTurnOverrides({
      request: { modes: ['plan-task'], tools: ['read', 'bash'] },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.modes).toEqual(['plan-task']);
    expect(resolved.tools).toEqual(['read', 'bash']);
  });

  it('REFUSES a mode list that is not a list of names', () => {
    const resolved = resolveTurnOverrides({
      request: { modes: ['plan-task', ''] },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('modes[1]');
  });

  it('REFUSES a tool list that is not a list', () => {
    const resolved = resolveTurnOverrides({
      request: { tools: 'bash' },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('tools');
  });

  it('carries the permission rules in the protocol\'s wire form', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionRules: { workspace: ['read'], cli: ['bash'] } },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.permissionRules).toEqual({ workspace: ['read'], cli: ['bash'] });
  });

  it('REFUSES a rule table that is not a record of tool names', () => {
    const resolved = resolveTurnOverrides({
      request: { permissionRules: { workspace: 'read' } },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('permissionRules.workspace');
  });

  it('takes the declared fields out of the bag', () => {
    const resolved = resolveTurnOverrides({
      request: {},
      standing: {},
      options: {
        modes: ['smuggled'],
        tools: ['smuggled'],
        permissionRules: { workspace: ['smuggled'] },
        hostSwitch: 'always',
        displayContent: 'kept',
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // `hostSwitch` is the HOST's value: there is no request field for it,
    // and a bag that carried one would let the caller state it.
    expect(resolved.options).not.toHaveProperty('hostSwitch');
    expect(resolved.options).not.toHaveProperty('modes');
    expect(resolved.options).not.toHaveProperty('tools');
    expect(resolved.options).not.toHaveProperty('permissionRules');
    expect(resolved.options['displayContent']).toBe('kept');
  });
});

describe('the turn\'s attachments', () => {
  it('travel in the existing `files` carrier the worker already reads', () => {
    const files = [{ id: 'a1', name: 'shot.png', type: 'image/png', url: 'file:///shot.png', size: 10 }];
    const resolved = resolveTurnOverrides({
      request: { attachments: files },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.attachments).toEqual(files);
    expect(resolved.options['files']).toEqual(files);
  });

  it('replaces a stale copy of itself in the bag', () => {
    const resolved = resolveTurnOverrides({
      request: { attachments: [{ id: 'new', name: 'n', type: 'text/plain', url: '', size: 1 }] },
      standing: {},
      options: { files: [{ id: 'old', name: 'o', type: 'text/plain', url: '', size: 1 }] },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options['files']).toEqual([
      { id: 'new', name: 'n', type: 'text/plain', url: '', size: 1 },
    ]);
  });

  it('keeps the bag\'s own files when the turn names none', () => {
    const files = [{ id: 'a1', name: 'shot.png', type: 'image/png', url: 'file:///shot.png', size: 10 }];
    const resolved = resolveTurnOverrides({
      request: {},
      standing: {},
      options: { files },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.attachments).toEqual(files);
    expect(resolved.options['files']).toEqual(files);
  });

  it('REFUSES an attachment with no id', () => {
    // The id IS the attachment's identity: the turn is digested by the ids
    // of its attachments, so two attachments without ids would digest the
    // same however different their contents are.
    const resolved = resolveTurnOverrides({
      request: { attachments: [{ name: 'shot.png', type: 'image/png', url: '', size: 10 }] },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('attachments[0].id');
  });

  it('REFUSES attachments that are not a list', () => {
    const resolved = resolveTurnOverrides({
      request: { attachments: 'shot.png' },
      standing: {},
      options: {},
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe('attachments');
  });
});
