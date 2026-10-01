import { describe, expect, it } from 'vitest';
import {
  clearClientSecret,
  getProviderConfig,
  getProviderReadiness,
  overrideClientId,
  registerProviderConfig,
  setClientSecret,
  unregisterProviderConfig,
} from '../providers/registry.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

const GOOGLE = asAppConnectorId('google');
const SLACK = asAppConnectorId('slack');

describe('app connection provider registry', () => {
  it('keeps Google Drive on the Duya-managed OAuth path', () => {
    const google = getProviderConfig(GOOGLE);

    expect(google?.supportsManualConfiguration).toBe(false);
    expect(google?.requiresClientSecret).toBe(false);
    expect(google?.defaultScopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
      'email',
      'profile',
    ]);
  });

  it('ships a ready official Google Desktop OAuth client', () => {
    expect(getProviderConfig(GOOGLE)?.clientId).toMatch(/\.apps\.googleusercontent\.com$/);

    const readiness = getProviderReadiness(GOOGLE);
    expect(readiness).toEqual({ configured: true });
  });

  it('keeps Slack manual setup available for self-hosted deployments', () => {
    expect(getProviderConfig(SLACK)?.supportsManualConfiguration).toBe(true);
  });

  it('registers Gmail and Calendar as manual-config providers (not ready by default)', () => {
    const gmail = getProviderConfig(asAppConnectorId('gmail'));
    const calendar = getProviderConfig(asAppConnectorId('calendar'));

    expect(gmail?.label).toBe('Gmail');
    expect(gmail?.defaultScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(gmail?.defaultScopes).toContain('https://www.googleapis.com/auth/gmail.compose');
    expect(gmail?.defaultScopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(gmail?.redirectPath).toBe('/callback/gmail');
    // Gmail/Calendar are NOT shipped a shared client: the user supplies their
    // own Google Cloud Desktop OAuth client (ID + Secret).
    expect(gmail?.supportsManualConfiguration).toBe(true);
    expect(gmail?.requiresClientSecret).toBe(true);
    expect(gmail?.clientId).toBe('');
    expect(getProviderReadiness(asAppConnectorId('gmail')).configured).toBe(false);

    expect(calendar?.label).toBe('Google Calendar');
    expect(calendar?.defaultScopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(calendar?.redirectPath).toBe('/callback/calendar');
    expect(calendar?.supportsManualConfiguration).toBe(true);
    expect(calendar?.clientId).toBe('');
    expect(getProviderReadiness(asAppConnectorId('calendar')).configured).toBe(false);
  });

  it('treats Gmail as configured once the user supplies a client id+secret at runtime', () => {
    const gmail = asAppConnectorId('gmail');
    expect(getProviderReadiness(gmail).configured).toBe(false);

    // Mirrors configureProvider: overrideClientId + setClientSecret drive
    // readiness (env vars are only read at boot for the baked clientId).
    overrideClientId(gmail, 'acme.apps.googleusercontent.com');
    setClientSecret(gmail, 'GOCSPX-acme-secret');
    try {
      expect(getProviderReadiness(gmail).configured).toBe(true);
    } finally {
      clearClientSecret(gmail);
      if (getProviderConfig(gmail)) {
        // Reset the in-memory clientId override back to empty so later
        // tests keep Gmail unconfigured.
        overrideClientId(gmail, process.env.DUYA_APP_CONNECTION_GMAIL_CLIENT_ID ?? '');
      }
    }
  });

  it('registers QQ Mail as a custom-credential provider that is always connectable', () => {
    const qq = getProviderConfig(asAppConnectorId('qq-mail'));
    expect(qq?.label).toBe('QQ 邮箱');
    expect(qq?.requiresOAuthClient).toBe(false);
    expect(qq?.supportsManualConfiguration).toBe(true);
    expect(getProviderReadiness(asAppConnectorId('qq-mail'))).toEqual({ configured: true });
  });

  // --- Plan 455: the catalog is open ---

  it('returns undefined for unregistered ids instead of throwing', () => {
    expect(getProviderConfig(asAppConnectorId('plugin-acme-tasks'))).toBeUndefined();
    expect(getProviderReadiness(asAppConnectorId('plugin-acme-tasks')).configured).toBe(false);
  });

  it('accepts plugin-declared connector configs and unregisters them', () => {
    const declared = {
      id: asAppConnectorId('plugin-acme-tasks'),
      label: 'Acme Tasks',
      authUrl: '',
      tokenUrl: '',
      redirectPath: '/callback/mcp/plugin-acme-tasks',
      defaultScopes: [],
      requiresClientSecret: false,
      supportsManualConfiguration: false,
      clientId: '',
      remoteMcpUrl: 'https://mcp.acme.example/mcp',
      monogram: 'A',
      description: 'Acme task tracking (plugin-declared)',
    };

    expect(registerProviderConfig(declared)).toEqual({ ok: true });
    expect(getProviderConfig(declared.id)?.remoteMcpUrl).toBe('https://mcp.acme.example/mcp');
    expect(getProviderReadiness(declared.id)).toEqual({ configured: true });

    expect(unregisterProviderConfig(declared.id)).toBe(true);
    expect(getProviderConfig(declared.id)).toBeUndefined();
  });

  it('rejects duplicate registration (builtin ids are reserved)', () => {
    const duplicate = {
      id: GOOGLE,
      label: 'Fake Google',
      authUrl: '',
      tokenUrl: '',
      redirectPath: '/callback/fake',
      defaultScopes: [],
      requiresClientSecret: false,
      supportsManualConfiguration: false,
      clientId: '',
      monogram: 'F',
      description: 'collision attempt',
    };
    const result = registerProviderConfig(duplicate);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already registered');
    // The builtin entry is untouched.
    expect(getProviderConfig(GOOGLE)?.label).toBe('Google Drive');
  });
});
