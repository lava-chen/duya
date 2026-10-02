// electron/services/browser/extension-trust.ts
// Plan 583 / ISS-18: the single decision for "may this socket drive the
// user's browser?".

export type ExtensionTrustRejection =
  /** No `chrome-extension://` origin, so no id the browser vouched for. */
  | 'untrusted_origin'
  /** Neither an origin id nor a usable claim — nothing to show or allow. */
  | 'no_identity'
  /** A real extension, but not one the user or installer has vouched for. */
  | 'not_allowlisted';

export interface ExtensionTrustInput {
  /**
   * Extension id taken from the `chrome-extension://<id>` request origin.
   * The browser sets this header and a client cannot forge it, so it is the
   * only id that may authorise anything.
   */
  originExtensionId: string | null;
  /** Id the socket sent in its `hello` payload. Attacker-controlled. */
  claimedExtensionId: string | null;
  /** Ids the user approved, or that `autoApproveInstalledExtensionId` vouched for. */
  allowedExtensionIds: readonly string[];
}

export interface ExtensionTrustDecision {
  /** True only when the allowlist contains the ORIGIN-derived id. */
  trusted: boolean;
  /** The id to store in the allowlist on approval. Null when untrusted_origin. */
  trustedExtensionId: string | null;
  /** What the approval prompt should display; may be a self-declared id. */
  displayExtensionId: string | null;
  rejection: ExtensionTrustRejection | null;
}

/**
 * Decide whether a WebSocket that just said `hello` may become the verified
 * browser-automation channel.
 *
 * The rule the daemon used to get wrong, in two independent ways:
 *
 *  1. An empty allowlist was treated as "trust the first caller" (the guard
 *     read `allowedExtensionIds.length > 0 && …`), so on a fresh profile every
 *     socket was waved through and the approval flow was unreachable exactly
 *     when it mattered. An empty allowlist means nothing is trusted yet.
 *
 *  2. The identity check accepted a self-declared id from the `hello` payload.
 *     Any local process, or any page whose origin is `null` (sandboxed iframe,
 *     `file://`), can put the published bridge id in a hello frame and land in
 *     the allowlist — and that write was persisted, making the compromise
 *     survive restarts.
 *
 * Trust is therefore granted only by an id the browser proved via the origin
 * AND that appears in the allowlist. A claim can be displayed, never allowed.
 */
export function decideExtensionTrust(input: ExtensionTrustInput): ExtensionTrustDecision {
  const displayExtensionId = input.originExtensionId ?? input.claimedExtensionId;

  if (input.originExtensionId === null) {
    return {
      trusted: false,
      trustedExtensionId: null,
      displayExtensionId,
      rejection: displayExtensionId === null ? 'no_identity' : 'untrusted_origin',
    };
  }

  const allowed = input.allowedExtensionIds.includes(input.originExtensionId);
  return {
    trusted: allowed,
    trustedExtensionId: input.originExtensionId,
    displayExtensionId,
    rejection: allowed ? null : 'not_allowlisted',
  };
}
