/**
 * Plan 587 R2.1 — the input revision, and the refusal it has to be able to make.
 *
 * ## Why this is tested on its own
 *
 * The revision is the thing that lets §C's rule work: "same runId + same
 * manifest/input may return the existing record; different content is
 * refused." Before it existed, the manifest said nothing about the prompt, so
 * two turns of the same session produced two manifests that differed only in
 * `runId` — and there was no value at all that identified "the same input".
 *
 * Two properties are easy to get wrong and impossible to notice:
 *
 *  1. **Attachments must not be hashed by payload.** A turn may carry 50 MB of
 *     base64. Hashing it would make the run layer copy every attachment in
 *     memory for a value the contract says is carried by REFERENCE. And if the
 *     payload were excluded without replacing it with the descriptor, two turns
 *     with different files would collide on the one property the digest exists
 *     to decide.
 *  2. **An unhashable option must fail loudly.** The two convenient
 *     alternatives — drop the field, or coerce it — both produce a silent
 *     collision on a digest whose entire job is detecting collisions.
 *
 * Imports are deliberately relative and protocol-free. This is a managed
 * module (`agent-runtime`), and a new cross-package test import would move the
 * architecture gate's `module-dependency-permitted` count for no benefit: the
 * unit under test needs no protocol types.
 */

import { describe, expect, it } from 'vitest';
import {
  ExecutionDispatchError,
  runInputRevision,
} from '../src/transport/execution-channel.js';

const base = { sessionId: 'session-1', prompt: 'hello', options: {} as Record<string, unknown> };

describe('runInputRevision', () => {
  it('is a pure function of session, prompt and options', () => {
    const first = runInputRevision(base);
    // A separately-constructed but structurally identical input must agree, or
    // a retry of the same turn would look like different content.
    expect(runInputRevision({ sessionId: 'session-1', prompt: 'hello', options: {} })).toBe(first);

    expect(runInputRevision({ ...base, prompt: 'hello!' })).not.toBe(first);
    expect(runInputRevision({ ...base, sessionId: 'session-2' })).not.toBe(first);
    expect(runInputRevision({ ...base, options: { language: 'zh' } })).not.toBe(first);
  });

  it('does not depend on the order the options were written in', () => {
    const a = runInputRevision({ ...base, options: { language: 'zh', effort: 'high' } });
    const b = runInputRevision({ ...base, options: { effort: 'high', language: 'zh' } });
    // Otherwise the digest is a function of the CONSTRUCTION rather than the
    // value, and the same turn hashed differently depending on which code path
    // assembled it.
    expect(a).toBe(b);
  });

  it('ignores attachment payloads but not attachment identity', () => {
    // Two turns carrying the same five attachments must hash identically even
    // though their base64 differs — the contract carries attachments by
    // reference, and the bytes are not what identifies them.
    const withPayload = (base64: string): Record<string, unknown> => ({
      files: [
        { id: 'f1', name: 'a.png', type: 'image/png', url: 'file:///a.png', base64 },
        { id: 'f2', name: 'b.ts', type: 'text/plain' },
      ],
    });
    const a = runInputRevision({ ...base, options: withPayload('QUJD') });
    const b = runInputRevision({ ...base, options: withPayload('WFla') });
    expect(a).toBe(b);

    // Different files are different input. If the payload were simply dropped,
    // this would collide with the pair above and §C's refusal could never fire.
    const differentFiles = runInputRevision({
      ...base,
      options: {
        files: [
          { id: 'f9', name: 'c.png', type: 'image/png', url: 'file:///c.png', base64: 'QUJD' },
          { id: 'f2', name: 'b.ts', type: 'text/plain' },
        ],
      },
    });
    expect(differentFiles).not.toBe(a);

    // And a different COUNT is different input even when no ids are present:
    // dropping an id-less attachment would make this collide.
    const noIds = runInputRevision({ ...base, options: { files: [{ name: 'x' }, { name: 'y' }] } });
    const oneIdless = runInputRevision({ ...base, options: { files: [{ name: 'x' }] } });
    expect(noIds).not.toBe(oneIdless);
  });

  it('drops an absent option rather than refusing to start the turn', () => {
    // `JSON.parse` never produces `undefined`, but a host that spreads an
    // object with a missing optional key does. Refusing a chat over a key with
    // no value would be absurd — and the two inputs must still agree, or an
    // omitted key and an explicit `undefined` would be different turns.
    const absent = runInputRevision({ ...base, options: { language: 'zh', title: undefined } });
    expect(absent).toBe(runInputRevision({ ...base, options: { language: 'zh' } }));
  });

  it('refuses an input it cannot canonicalise, rather than colliding silently', () => {
    // A `Map` serialises to `{}`. Dropping it would make a populated Map and an
    // absent one hash the same; stringifying it would hash a value the run never
    // saw. This is the exact trap `manifest-factory.ts` documents for
    // `permissionPolicy.rules`, and it is the reason the digest throws.
    expect(() =>
      runInputRevision({ ...base, options: { rules: new Map([['Read', 'allow']]) } }),
    ).toThrow(/canonical JSON|runInputRevision/);

    expect(() => runInputRevision({ ...base, options: { retries: Number.NaN } })).toThrow(
      /finite number/,
    );
    expect(() =>
      runInputRevision({ ...base, options: { onDone: () => undefined } }),
    ).toThrow(/not JSON/);
  });
});

describe('ExecutionDispatchError', () => {
  it('carries a code a host can branch on, distinct from a generic throw', () => {
    // The distinction is the whole point: "there is no worker to run this on"
    // is fixed by spawning one, and "the adapter broke" is not. A host that
    // cannot tell them apart retries the wrong thing.
    const error = new ExecutionDispatchError('no worker accepted chat:start');
    expect(error.code).toBe('dispatch_refused');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('no worker accepted chat:start');
  });
});
