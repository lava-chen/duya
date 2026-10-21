import type { DeviceCodeInfo } from '../types.js';

export interface DeviceCodeRequest {
  deviceAuthorizationUrl: string;
  clientId: string;
  scope?: string;
}

export interface DeviceCodeResponse extends DeviceCodeInfo {
  deviceCode: string;
  interval: number;
}

/**
 * Kick off a device-code flow: request a device + user code pair from the
 * provider's device-authorization endpoint. The caller surfaces `userCode` /
 * `verificationUri` to the user, then polls for authorization.
 */
export async function requestDeviceCode(
  input: DeviceCodeRequest,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams();
  body.set('client_id', input.clientId);
  if (input.scope) body.set('scope', input.scope);

  const res = await fetch(input.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Device authorization request failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in?: number;
    interval?: number;
  };
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
}

/**
 * Poll the token endpoint until the user approves (or the flow errors).
 * `onPoll` is used to surface progress; returns the token payload on success.
 */
export async function pollDeviceToken(
  input: {
    tokenUrl: string;
    clientId: string;
    deviceCode: string;
    interval: number;
    signal?: AbortSignal;
  },
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const { tokenUrl, clientId, deviceCode, interval, signal } = input;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    if (res.status === 400) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (data?.error === 'authorization_pending' || data?.error === 'slow_down') {
        continue;
      }
      if (data?.error === 'access_denied' || data?.error === 'expired_token') {
        throw new Error(`Device authorization ${data.error}`);
      }
    }
    if (!res.ok) throw new Error(`Token request failed with HTTP ${res.status}`);

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}

/** Generate a random nonce for CSRF protection. Uses the Web Crypto API
 *  (`crypto.getRandomValues`), available in both browsers and Node >= 19,
 *  so this module can be bundled into the renderer without `node:crypto`. */
export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}