/**
 * The pure-TS SHA-256 and canonical JSON, pinned against an independent oracle.
 *
 * Design source: 07-agent-protocol-spec.md §3 (fingerprint) and §15 (#1, which
 * is the rule that makes this file necessary).
 *
 * ## Why a hand-rolled hash carries real risk
 *
 * drift test #1 forbids `node:*` in `src/`, and `node:crypto` is both the
 * obvious way to hash and the one thing that is forbidden. So `src/hash.ts`
 * implements FIPS 180-4 by hand. A hand-rolled hash that is subtly wrong fails
 * in the worst possible way: it is deterministic, it never throws, and it
 * rejects legitimate resumes with a mismatch nobody can reproduce. "It
 * returned a string" is not a passing bar.
 *
 * ## What makes this a real test rather than a self-consistency check
 *
 * The implementation cannot validate itself. This file validates it against
 * three outside sources:
 *
 *  1. Published FIPS 180-4 / NIST CAVP vectors, transcribed here. These pin the
 *     algorithm, not this implementation.
 *  2. `node:crypto`, on randomised inputs. A hash that agrees with the
 *     reference on `""` and on a million bytes but disagrees somewhere in
 *     between is a hash that shipped a bug. Tests may use `node:crypto`;
 *     only `src/` may not.
 *  3. Structural properties that the canonical form is supposed to have —
 *     key order must not matter, array order must, undefined optional keys
 *     must not.
 *
 * The same "two implementations must agree or neither is trusted" stance
 * appears in `test/02-cycle-budget.test.ts` and in
 * `scripts/architecture/validate-scc.mjs`. It is the only way a guard against
 * its own blind spot is worth anything.
 */

import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex, type JsonValue } from '../src/hash.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS, manifestFingerprint, type RunManifest } from '../src/index.js';

const nodeSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Published vectors. Source: FIPS 180-4 examples and NIST CAVP SHAVS. */
const PUBLISHED_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

describe('hash: SHA-256 against published vectors', () => {
  it.each(PUBLISHED_VECTORS)('sha256(%j)', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('handles every padding boundary length', () => {
    // The bug class: off-by-one in the 0x80 pad, or in the 64-bit length field.
    // Block boundaries are at 55/56 and 119/120 bytes for single/double pad
    // blocks; a length in between is where an off-by-one changes the output.
    const boundaries = [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129];
    for (const len of boundaries) {
      const input = 'a'.repeat(len);
      expect(sha256Hex(input), `length ${len}`).toBe(nodeSha256(input));
    }
  });

  it('agrees with node:crypto on 400 random inputs', () => {
    // Seeded shapes, not seeded values: the point is width and multibyte text,
    // not reproducibility. `randomBytes` gives non-UTF8 bytes, which this test
    // must NOT feed in — sha256Hex takes a string and encodes it. So the
    // randomness is drawn as codepoints, including astral-plane ones, which is
    // where a surrogate-pair or TextEncoder bug would surface.
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(Math.random() * 300);
      let s = '';
      for (let j = 0; j < len; j++) {
        s += String.fromCodePoint(Math.floor(Math.random() * 0x10ffff));
      }
      expect(sha256Hex(s), `random input ${i} (length ${len})`).toBe(nodeSha256(s));
    }
  });

  it('handles multibyte text that changes the byte length', () => {
    // "é" is 2 UTF-8 bytes and "𝄞" is 4. Hashing by JS string length instead of
    // byte length is the classic hand-rolled-hash bug, and it is invisible to
    // the ASCII vectors above.
    for (const s of ['é', '𝄞', 'é𝄞', '汉字测试', '👍🏽👎🏻']) {
      expect(sha256Hex(s), JSON.stringify(s)).toBe(nodeSha256(s));
    }
  });

  it('hashes a 1 MiB payload identically to the reference', () => {
    // Past a single 64-byte block by four orders of magnitude: exercises the
    // message-schedule carry across many blocks.
    const big = randomBytes(1024 * 1024).toString('base64');
    expect(sha256Hex(big)).toBe(nodeSha256(big));
  });
});

describe('hash: canonicalJson has the properties the fingerprint depends on', () => {
  it('is independent of object key insertion order', () => {
    const a: JsonValue = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const b: JsonValue = { m: { b: 4, y: 3 }, a: 2, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"m":{"b":4,"y":3},"z":1}');
  });

  it('is sensitive to array order', () => {
    // The complement of the property above. If arrays were sorted too, two runs
    // that emitted tools in a different order would be treated as the same run.
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
  });

  it('round-trips through JSON.parse to the same canonical form', () => {
    const value: JsonValue = { tools: ['bash', 'read'], limits: { bytes: 16_777_216 } };
    expect(canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue)).toBe(canonicalJson(value));
  });

  it('agrees with JSON.stringify on structure, differing only in key order', () => {
    const value: JsonValue = { a: 1, b: [1, 2, { c: true }], d: null, e: 'x' };
    const mine = canonicalJson(value);
    const theirs = JSON.stringify(value);
    expect(JSON.parse(mine)).toEqual(JSON.parse(theirs));
    expect(mine).toBe('{"a":1,"b":[1,2,{"c":true}],"d":null,"e":"x"}');
  });

  it('refuses non-finite numbers instead of emitting invalid JSON', () => {
    // JSON.stringify turns NaN and Infinity into `null`, which would make a
    // NaN budget silently equal a null budget in every future comparison.
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => canonicalJson(bad as unknown as JsonValue)).toThrow(TypeError);
    }
    expect(() => canonicalJson({ n: Number.NaN } as unknown as JsonValue)).toThrow(TypeError);
  });

  it('escapes strings the way JSON does, including the delimiter characters', () => {
    const tricky: JsonValue = { k: 'quote " backslash \\ newline \n tab \t unicode \u0000' };
    expect(canonicalJson(tricky)).toBe(JSON.stringify(tricky));
    expect(JSON.parse(canonicalJson(tricky))).toEqual(tricky);
  });
});

describe('manifest: the fingerprint is a function of value, not construction', () => {
  const base: RunManifest = {
    version: 1,
    runId: 'run-1',
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/repo'],
    cwd: '/repo',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS },
    capabilities: { profiles: ['default'], modes: ['plan-task'], tools: ['bash'] },
    connectorBindings: [],
    env: { ref: 'envref_abc', hash: 'deadbeef' },
    budget: {},
    deterministic: false,
  } as RunManifest;

  it('is a 64-char lowercase hex digest', () => {
    expect(base).toBeTruthy();
    expect(manifestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores how the object was built', () => {
    // Every field is readonly in RunManifest, so "same value, different key
    // order" has to be produced by rebuilding the object, not by mutation.
    const rebuilt: RunManifest = {
      deterministic: false,
      budget: {},
      env: { hash: 'deadbeef', ref: 'envref_abc' },
      connectorBindings: [],
      capabilities: { tools: ['bash'], modes: ['plan-task'], profiles: ['default'] },
      permissionPolicy: { defaultTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS, hostSwitch: 'ask', mode: 'default' },
      cwd: '/repo',
      roots: ['/repo'],
      workspaceId: 'ws-1',
      projectId: null,
      runId: 'run-1',
      version: 1,
    } as RunManifest;

    expect(manifestFingerprint(rebuilt)).toBe(manifestFingerprint(base));
  });

  it('ignores optional keys that were never set', () => {
    // `JSON.parse(JSON.stringify(...))` drops undefined-valued keys, so a
    // manifest carrying `goalId: undefined` must match one that omits it.
    // Without this, a host that explicitly sets a field to undefined would be
    // rejected on resume for a manifest that is semantically identical.
    const withUndefined: RunManifest = { ...base, goalId: undefined } as RunManifest;
    expect(manifestFingerprint(withUndefined)).toBe(manifestFingerprint(base));
  });

  it('changes when any load-bearing field changes', () => {
    // Each of these must invalidate a resume. A field that silently does not
    // reach the digest is a field the runtime can diverge on without the
    // handshake noticing.
    const mutations: ReadonlyArray<readonly [string, Partial<RunManifest>]> = [
      ['runId', { runId: 'run-2' }],
      ['workspaceId', { workspaceId: 'ws-2' }],
      ['cwd', { cwd: '/other' }],
      ['deterministic', { deterministic: true }],
      ['roots emptied', { roots: [] }],
      ['capabilities', { capabilities: { profiles: [], modes: ['plan-task'], tools: ['bash'] } }],
      ['permissionPolicy', { permissionPolicy: { mode: 'plan', hostSwitch: 'ask', defaultTimeoutMs: 1 } }],
      ['env ref', { env: { ref: 'envref_xyz', hash: 'deadbeef' } }],
      ['version', { version: 2 as unknown as 1 }],
    ];

    const expected = manifestFingerprint(base);
    for (const [label, patch] of mutations) {
      expect(manifestFingerprint({ ...base, ...patch } as RunManifest), label).not.toBe(expected);
    }
  });

  it('is sensitive to array order inside the manifest', () => {
    // The complement of the key-order independence above. Object keys are
    // sorted; arrays are NOT. `roots` and `capabilities.tools` are sets the
    // caller controls, so two manifests naming the same roots in a different
    // order are different constructions and must not share a digest — a host
    // that reordered a list between the original run and a resume would
    // otherwise be accepted into a run it does not match.
    const swapped: RunManifest = {
      ...base,
      roots: ['/repo', '/other'],
    } as RunManifest;
    const forward: RunManifest = { ...base, roots: ['/other', '/repo'] } as RunManifest;
    expect(manifestFingerprint(swapped)).not.toBe(manifestFingerprint(forward));
  });

  it('a manifest is a stable, publishable golden value', () => {
    // Cross-host reproducibility is the whole point: the main process and the
    // HTTP+SSE gateway must mint the same digest for the same run, or resume
    // cannot cross a transport boundary. A hard-coded value here is what makes
    // that checkable from a second implementation in another language. Any
    // change is a wire-format change and must be a deliberate edit.
    //
    // The literal below is proven, not recorded: it is also derived here from
    // `node:crypto`, so the assertion cannot be satisfied by a bug that is
    // self-consistent. If the two ever diverge, the implementation is wrong,
    // not the golden value.
    const wire = JSON.parse(JSON.stringify(base)) as JsonValue;
    expect(nodeSha256(canonicalJson(wire))).toBe(
      '623eb085c2dd65c655a35441cde377de5f6c1e717dfa3ea1e1be042bad77c46f',
    );
    expect(manifestFingerprint(base)).toBe(
      '623eb085c2dd65c655a35441cde377de5f6c1e717dfa3ea1e1be042bad77c46f',
    );
  });
});
