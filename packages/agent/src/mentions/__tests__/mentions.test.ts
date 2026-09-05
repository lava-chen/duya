import { describe, it, expect } from 'vitest';
import {
  buildAppsSystemSection,
  collectConnectorActivationInjection,
  type AppToolSummary,
} from '../index';

const descriptors: AppToolSummary[] = [
  { provider: 'notion', providerLabel: 'Notion', name: 'remote_notion_search' },
  { provider: 'notion', providerLabel: 'Notion', name: 'remote_notion_fetch' },
  { provider: 'github', providerLabel: 'GitHub', name: 'remote_github_list_issues' },
];

describe('collectConnectorActivationInjection', () => {
  it('returns null when no providers are selected', () => {
    expect(collectConnectorActivationInjection([], descriptors)).toBeNull();
    expect(collectConnectorActivationInjection(['', '  '], descriptors)).toBeNull();
  });

  it('lists tool names for a provider with cached descriptors', () => {
    const injection = collectConnectorActivationInjection(['notion'], descriptors);
    expect(injection?.envelope).toBe('connector-activation');
    expect(injection?.body).toContain('[Notion](app://notion)');
    expect(injection?.body).toContain('2 tool(s) available this run');
    expect(injection?.body).toContain('remote_notion_search, remote_notion_fetch');
  });

  it('stays neutral (never "not connected") when a mentioned provider has no cached tools', () => {
    const injection = collectConnectorActivationInjection(['linear'], descriptors);
    expect(injection?.body).toContain('[linear](app://linear)');
    expect(injection?.body).toContain('no tools exposed this run');
    expect(injection?.body).toContain('may need re-authorization');
    expect(injection?.body.toLowerCase()).not.toContain('not connected');
  });

  it('uses the provider id as label when no descriptor carries a label', () => {
    const injection = collectConnectorActivationInjection(['linear'], [
      { provider: 'linear', name: 'x' },
    ]);
    expect(injection?.body).toContain('[linear](app://linear)');
  });
});

describe('buildAppsSystemSection', () => {
  it('returns null when there are no descriptors (prompt unchanged)', () => {
    expect(buildAppsSystemSection([])).toBeNull();
  });

  it('renders the codex-style Apps section grouped by provider', () => {
    const section = buildAppsSystemSection(descriptors) ?? '';
    expect(section).toContain('## Apps (Connectors)');
    expect(section).toContain('[@App-Name](app://<provider-id>)');
    expect(section).toContain('tool_search');
    expect(section).toContain('- [Notion](app://notion): remote_notion_search, remote_notion_fetch');
    expect(section).toContain('- [GitHub](app://github): remote_github_list_issues');
  });

  it('falls back to the provider id as label', () => {
    const section = buildAppsSystemSection([{ provider: 'linear', name: 't1' }]) ?? '';
    expect(section).toContain('- [linear](app://linear): t1');
  });

  it('teaches the help-the-user-connect contract (Plan 498, grok-bot parity)', () => {
    const section = buildAppsSystemSection(descriptors) ?? '';
    // Prefer connectors over browser workarounds.
    expect(section).toContain('Prefer them over browser or computer-use tools');
    // Missing service: name it plainly, point at the real connect path,
    // never fabricate authorization URLs.
    expect(section).toContain('NOT in the list above');
    expect(section).toContain('Settings → Extensions → Connections');
    expect(section).toContain('Never compose or paste an install or authorization URL');
    // Pending authorization: no workarounds, end turn and wait for resume.
    expect(section).toContain('while its authorization is pending');
    expect(section).toContain('finish unrelated work, then end your turn');
    // Proactive surfacing of unconnected services.
    expect(section).toContain('surface that connector to the user');
  });
});
