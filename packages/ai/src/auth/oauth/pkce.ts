const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 base64url (no padding) encoding of a byte array. */
function base64urlBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) out += B64[b2 & 0x3f];
  }
  return out.replace(/=+$/, '');
}

/**
 * Generate a PKCE verifier/challenge pair per RFC 7636.
 * The verifier is 43-128 chars of [A-Za-z0-9-._~]; the challenge is the
 * base64url SHA-256 of the verifier.
 *
 * Uses the Web Crypto API (`crypto.getRandomValues` / `crypto.subtle.digest`),
 * which is available in both browsers and Node >= 19, so this module can be
 * bundled into the renderer without relying on `node:crypto`.
 */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64urlBytes(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', verifierBytes);
  const challenge = base64urlBytes(new Uint8Array(digest));
  return { verifier, challenge };
}

/** Build the OAuth authorize URL with PKCE params. */
export function buildAuthorizeUrl(input: {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(input.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  if (input.scope) url.searchParams.set('scope', input.scope);
  return url.toString();
}