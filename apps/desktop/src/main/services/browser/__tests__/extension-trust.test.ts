// Plan 583 / ISS-18: the browser-bridge socket must not grant itself trust.
import { describe, it, expect } from 'vitest';

import { decideExtensionTrust } from '../extension-trust';

const PUBLISHED_ID = 'hpkgmnimcghdnodpoehidjeinnhlnpkd';

describe('decideExtensionTrust', () => {
  it('refuses everything on a fresh profile with an empty allowlist', () => {
    // The regression: the old guard was `allowedExtensionIds.length > 0 && …`,
    // so the FIRST caller on a clean install owned the automation channel.
    const decision = decideExtensionTrust({
      originExtensionId: PUBLISHED_ID,
      claimedExtensionId: PUBLISHED_ID,
      allowedExtensionIds: [],
    });

    expect(decision.trusted).toBe(false);
    expect(decision.rejection).toBe('not_allowlisted');
  });

  it('trusts an origin-proven id that the user or installer allowlisted', () => {
    const decision = decideExtensionTrust({
      originExtensionId: PUBLISHED_ID,
      claimedExtensionId: null,
      allowedExtensionIds: [PUBLISHED_ID],
    });

    expect(decision.trusted).toBe(true);
    expect(decision.rejection).toBeNull();
    expect(decision.trustedExtensionId).toBe(PUBLISHED_ID);
  });

  it('does not honour a self-declared id that is absent from the allowlist', () => {
    // A local process or a `null`-origin page can put any id in the hello
    // frame. Without a browser-set origin there is no identity to authorise.
    const decision = decideExtensionTrust({
      originExtensionId: null,
      claimedExtensionId: PUBLISHED_ID,
      allowedExtensionIds: [PUBLISHED_ID],
    });

    expect(decision.trusted).toBe(false);
    expect(decision.trustedExtensionId).toBeNull();
    expect(decision.rejection).toBe('untrusted_origin');
  });

  it('still shows the claimed id so the approval prompt is not blank', () => {
    const decision = decideExtensionTrust({
      originExtensionId: null,
      claimedExtensionId: PUBLISHED_ID,
      allowedExtensionIds: [],
    });

    expect(decision.displayExtensionId).toBe(PUBLISHED_ID);
  });

  it('reports a client with no identity at all separately', () => {
    const decision = decideExtensionTrust({
      originExtensionId: null,
      claimedExtensionId: null,
      allowedExtensionIds: [],
    });

    expect(decision.trusted).toBe(false);
    expect(decision.rejection).toBe('no_identity');
    expect(decision.displayExtensionId).toBeNull();
  });

  it('rejects a real extension that is not allowlisted', () => {
    const decision = decideExtensionTrust({
      originExtensionId: 'someotherrealchromeextensionid',
      claimedExtensionId: 'someotherrealchromeextensionid',
      allowedExtensionIds: [PUBLISHED_ID],
    });

    expect(decision.trusted).toBe(false);
    expect(decision.rejection).toBe('not_allowlisted');
    // Approvable: the origin proved who it is, the user just has to say yes.
    expect(decision.trustedExtensionId).toBe('someotherrealchromeextensionid');
  });

  it('prefers the origin id over a conflicting claim for display too', () => {
    const decision = decideExtensionTrust({
      originExtensionId: PUBLISHED_ID,
      claimedExtensionId: 'somethingelse',
      allowedExtensionIds: [PUBLISHED_ID],
    });

    expect(decision.trusted).toBe(true);
    expect(decision.displayExtensionId).toBe(PUBLISHED_ID);
  });
});
