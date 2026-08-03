import { describe, expect, it } from 'vitest';
import { getProviderConfig, getProviderReadiness } from '../providers/registry.js';

describe('app connection provider registry', () => {
  it('keeps Google Drive on the Duya-managed OAuth path', () => {
    const google = getProviderConfig('google');

    expect(google.supportsManualConfiguration).toBe(false);
    expect(google.requiresClientSecret).toBe(false);
    expect(google.defaultScopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
      'email',
      'profile',
    ]);
  });

  it('ships a ready official Google Desktop OAuth client', () => {
    expect(getProviderConfig('google').clientId).toMatch(/\.apps\.googleusercontent\.com$/);

    const readiness = getProviderReadiness('google');
    expect(readiness).toEqual({ configured: true });
  });

  it('keeps Slack manual setup available for self-hosted deployments', () => {
    expect(getProviderConfig('slack').supportsManualConfiguration).toBe(true);
  });
});
