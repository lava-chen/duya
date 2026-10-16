/**
 * Contract tests for the host capability vocabulary.
 *
 * ## What would make these worthless
 *
 * A test that asserts `satisfies(...) === true` for a host that provides
 * everything proves nothing. Every case below asserts a CONCRETE value — a
 * message, a list length, a thrown message — against a literal, and the
 * not-provides cases are written so that deleting the check turns them green.
 * That is the discipline `capabilities.ts` already states for
 * `assertCapabilityConsistency`, applied here so the new axis cannot become the
 * one that is quietly unchecked.
 */

import { describe, expect, it } from 'vitest';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_OWNERS,
  assertHostCapabilityConsistency,
  assertHostSatisfies,
  hostLocalOnlyCapabilities,
  hostSatisfies,
  type CapabilityOwner,
  type HostCapabilities,
  type HostCapability,
} from '../src/host-capabilities.js';
import { CURRENT_VERSION } from '../src/version.js';

function host(provides: readonly HostCapability[]): HostCapabilities {
  return {
    protocol: CURRENT_VERSION,
    host: { name: 'test-host', version: '0.0.0', kind: 'desktop' },
    provides,
  };
}

describe('host capability vocabulary', () => {
  it('has an owner for every capability, and no owner for anything else', () => {
    const named = Object.keys(HOST_CAPABILITY_OWNERS).sort();
    expect(named).toEqual([...HOST_CAPABILITIES].sort());
    expect(named.length).toBe(22);
  });

  it('assigns workspace capabilities to the runtime, not the host', () => {
    // The load-bearing pair. 00-contracts §1.2 gives workspace filesystem and
    // shell to the RUNTIME; if these ever read `host-local`, a browser client
    // would offer a file picker that can only open the server's disk.
    expect(HOST_CAPABILITY_OWNERS.workspace_filesystem).toBe('runtime');
    expect(HOST_CAPABILITY_OWNERS.workspace_git).toBe('runtime');
  });

  it('marks only persistence-shaped capabilities as available from both sides', () => {
    const both = HOST_CAPABILITIES.filter((c) => HOST_CAPABILITY_OWNERS[c] === 'both');
    expect([...both].sort()).toEqual(['inbox', 'project_registry', 'session_persistence']);
  });

  it('lists the browser-invisible capabilities as data', () => {
    const local = hostLocalOnlyCapabilities();
    expect(local.length).toBe(17);
    expect(local).toContain('native_dialog');
    expect(local).toContain('os_shell');
    expect(local).toContain('port_discovery');
    // A workspace the client shares with the agent is NOT browser-invisible.
    expect(local).not.toContain('workspace_filesystem');
  });

  it('uses only the three declared owner kinds', () => {
    const owners = new Set<CapabilityOwner>(Object.values(HOST_CAPABILITY_OWNERS));
    expect([...owners].sort()).toEqual(['both', 'host-local', 'runtime']);
  });
});

describe('host satisfies', () => {
  it('accepts a host that provides what the component needs', () => {
    expect(hostSatisfies(host(['native_dialog']), { needs: ['native_dialog'] })).toBe(true);
  });

  it('rejects a capability the host omits, and names it', () => {
    // A browser host with no dialog. This is the case the whole file exists for.
    expect(hostSatisfies(host([]), { needs: ['native_dialog'] })).toBe(false);
    expect(() => assertHostSatisfies(host([]), { needs: ['native_dialog'] })).toThrow(
      /does not provide native_dialog/,
    );
  });

  it('rejects a capability provided by the wrong owner', () => {
    // The subtle one: the capability IS advertised, and the answer is still no,
    // because a component reading the USER's disk cannot be served by the
    // workspace the agent runs in.
    const caps = host(['workspace_filesystem']);
    expect(caps.provides).toContain('workspace_filesystem');
    expect(hostSatisfies(caps, { needs: ['workspace_filesystem'], owner: 'host-local' })).toBe(false);
    expect(() =>
      assertHostSatisfies(caps, { needs: ['workspace_filesystem'], owner: 'host-local' }),
    ).toThrow(/provides workspace_filesystem as runtime, but the requirement is host-local/);
    expect(hostSatisfies(caps, { needs: ['workspace_filesystem'], owner: 'runtime' })).toBe(true);
  });

  it('treats an empty requirement as satisfied by any host', () => {
    expect(hostSatisfies(host([]), {})).toBe(true);
  });
});

describe('host capability consistency', () => {
  it('accepts a declaration that matches the registered channels exactly', () => {
    expect(() =>
      assertHostCapabilityConsistency(host(['skills', 'hooks']), ['skills', 'hooks']),
    ).not.toThrow();
  });

  it('rejects a capability advertised but not registered', () => {
    // The exact gap that produced a file picker that only throws on click.
    expect(() =>
      assertHostCapabilityConsistency(host(['native_dialog']), []),
    ).toThrow(/declares native_dialog but registers no such channel/);
  });

  it('rejects a registered channel that was never advertised', () => {
    // The reverse direction: a client that cannot discover the capability
    // degrades silently even though the host can serve it.
    expect(() => assertHostCapabilityConsistency(host([]), ['skills'])).toThrow(
      /registers skills but does not declare it in provides/,
    );
  });

  it('rejects a channel name that is not a known capability', () => {
    expect(() => assertHostCapabilityConsistency(host(['skills']), ['skills', 'warp_drive'])).toThrow(
      /registers warp_drive, which is not a known HostCapability/,
    );
  });

  it('reports every mismatch at once rather than the first', () => {
    let message = '';
    try {
      assertHostCapabilityConsistency(host(['native_dialog', 'os_shell']), ['cron']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('declares native_dialog but registers no such channel');
    expect(message).toContain('declares os_shell but registers no such channel');
    expect(message).toContain('registers cron but does not declare it in provides');
  });
});
