// @vitest-environment jsdom

// PluginInstallDialog — focused tests for the "What's included" section
// added on top of the existing "Try it with" examples.
//
// We verify:
//   1. capabilities provided by the catalog render under a typed group header
//      (skill / connector / mcp);
//   2. when both usageExamples and capabilities are present, a segmented
//      control switches between the two panels;
//   3. when only capabilities are present, the segmented control is hidden
//      and the "What's included" header is shown directly;
//   4. when neither is present, no bottom panel renders.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/icons', () => ({
  // Rendered icons become text labels for stable test selectors.
  SpinnerGapIcon: () => null,
  XIcon: () => null,
  CheckIcon: () => null,
  ChatCircleIcon: () => null,
  LightningIcon: () => null,
  WrenchIcon: () => null,
  PlugIcon: () => null,
  ServerIcon: () => null,
  TerminalIcon: () => null,
}));

// Stub ConnectorIcon to assert provider id wiring if needed.
vi.mock('../connector-icons', () => ({
  ConnectorIcon: ({ provider, monogram }: { provider: string; monogram?: string }) => (
    <span data-testid={`connector-${provider}`}>{monogram ?? provider}</span>
  ),
}));

vi.mock('../MarketplacePage', () => ({
  CardIcon: () => null,
}));

vi.mock('@/lib/plugin-ipc', () => ({
  getPluginAPI: () => null,
}));

vi.mock('@/lib/app-connection-ipc', () => ({
  getAppConnectionAPI: () => null,
}));

vi.mock('@/lib/prefill-chat-input-event', () => ({
  dispatchPrefillChatInput: vi.fn(),
}));

// Translation: pass keys through so tests can match `marketplace.dialog.*`.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const buildPlugin = (
  overrides: Partial<Parameters<typeof getPlugin>[0]> = {},
) => {
  return {
    id: 'sample-plugin',
    name: 'Sample Plugin',
    version: '1.0.0',
    description: 'Sample plugin description',
    shortDescription: 'Sample short description',
    author: { name: 'acme' },
    icon: undefined,
    source: 'marketplace',
    category: 'productivity',
    marketplace: 'official',
    authPolicy: 'on_use',
    installPolicy: 'available',
    capabilityCounts: {
      skills: 2,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 0,
    },
    capabilities: [],
    usageExamples: [],
    manifest: undefined,
    ...overrides,
  };
};

// Helper that mirrors what ExtensionCard does — keep this typed loosely so
// we can drop a richer object without the test file importing the full type.
function getPlugin<T>(plugin: T) {
  return plugin;
}

describe('PluginInstallDialog — capabilities section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders capability groups with the catalog-supplied items', async () => {
    const plugin = buildPlugin({
      capabilities: [
        {
          id: 'summarize-unread',
          name: 'summarize_unread',
          type: 'skill',
          description: 'Summarize unread channel messages',
          required: false,
          enabled: true,
        },
        {
          id: 'slack',
          name: 'slack',
          type: 'connector',
          description: 'Read and post Slack workspace messages',
          required: false,
          enabled: true,
        },
        {
          id: 'grep',
          name: 'grep',
          type: 'mcp',
          description: 'Local grep MCP server',
          required: false,
          enabled: true,
        },
      ],
    });

    const { PluginInstallDialog } = await import('../PluginInstallDialog');
    render(
      <PluginInstallDialog
        plugin={plugin as never}
        providers={[]}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    );

    // Group headers (translation keys — see useTranslation stub).
    expect(
      screen.getByText('marketplace.dialog.capabilityType.skill'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('marketplace.dialog.capabilityType.connector'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('marketplace.dialog.capabilityType.mcp'),
    ).toBeInTheDocument();

    // Items render with name + description.
    expect(screen.getByText('summarize_unread')).toBeInTheDocument();
    expect(
      screen.getByText('Summarize unread channel messages'),
    ).toBeInTheDocument();
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('grep')).toBeInTheDocument();
  });

  it('shows the segmented tab control when both examples and capabilities exist', async () => {
    const plugin = buildPlugin({
      usageExamples: [{ prompt: 'Summarize unread messages' }],
      capabilities: [
        {
          id: 'summarize-unread',
          name: 'summarize_unread',
          type: 'skill',
          description: 'Summarize unread channel messages',
          required: false,
          enabled: true,
        },
      ],
    });

    const { PluginInstallDialog } = await import('../PluginInstallDialog');
    const user = userEvent.setup();
    render(
      <PluginInstallDialog
        plugin={plugin as never}
        providers={[]}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    );

    // Both tab buttons render.
    expect(
      screen.getByRole('button', { name: 'marketplace.dialog.tabTryIt' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'marketplace.dialog.tabIncluded' }),
    ).toBeInTheDocument();

    // The skill item is hidden behind the "included" tab until clicked.
    expect(screen.queryByText('summarize_unread')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'marketplace.dialog.tabIncluded' }),
    );

    expect(screen.getByText('summarize_unread')).toBeInTheDocument();
  });

  it('skips the segmented control when only capabilities exist', async () => {
    const plugin = buildPlugin({
      capabilities: [
        {
          id: 'summarize-unread',
          name: 'summarize_unread',
          type: 'skill',
          description: 'Summarize unread channel messages',
          required: false,
          enabled: true,
        },
      ],
    });

    const { PluginInstallDialog } = await import('../PluginInstallDialog');
    render(
      <PluginInstallDialog
        plugin={plugin as never}
        providers={[]}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'marketplace.dialog.tabTryIt' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'marketplace.dialog.tabIncluded' }),
    ).not.toBeInTheDocument();
    // Static header is shown instead.
    expect(screen.getByText('marketplace.dialog.included')).toBeInTheDocument();
    expect(screen.getByText('summarize_unread')).toBeInTheDocument();
  });

  it('renders nothing in the bottom panel when both are empty', async () => {
    const plugin = buildPlugin();

    const { PluginInstallDialog } = await import('../PluginInstallDialog');
    const { container } = render(
      <PluginInstallDialog
        plugin={plugin as never}
        providers={[]}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    );

    // Nothing in the dialog references tryThese or included labels.
    expect(screen.queryByText('marketplace.dialog.tryThese')).not.toBeInTheDocument();
    expect(screen.queryByText('marketplace.dialog.included')).not.toBeInTheDocument();
    // The dialog itself still renders (it has a confirm button).
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('falls back to v2 manifest components when capabilities is empty', async () => {
    const plugin = buildPlugin({
      manifest: {
        schemaVersion: 'duya.plugin.v2',
        id: 'sample-plugin',
        name: 'Sample Plugin',
        version: '1.0.0',
        description: '',
        author: { name: 'acme' },
        engines: { duya: '>=0.1.0' },
        components: {
          skills: ['alpha-skill'],
          appConnections: ['slack'],
          mcpServers: ['local-grep'],
          workflows: [],
        },
      },
    });

    const { PluginInstallDialog } = await import('../PluginInstallDialog');
    render(
      <PluginInstallDialog
        plugin={plugin as never}
        providers={[]}
        onSuccess={() => {}}
        onClose={() => {}}
      />,
    );

    // All three groups should still render from the manifest fallback.
    expect(
      screen.getByText('marketplace.dialog.capabilityType.skill'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('marketplace.dialog.capabilityType.connector'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('marketplace.dialog.capabilityType.mcp'),
    ).toBeInTheDocument();
    expect(screen.getByText('alpha-skill')).toBeInTheDocument();
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('local-grep')).toBeInTheDocument();
  });
});
