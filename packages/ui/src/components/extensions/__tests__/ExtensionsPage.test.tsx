// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub LobeHub icons so tests don't fail on Windows module resolution.
vi.mock('@lobehub/icons/es/Anthropic', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/OpenRouter', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Zhipu', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Kimi', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Moonshot', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Minimax', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Bedrock', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Google', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Volcengine', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Bailian', () => ({ default: () => null }));
vi.mock('@lobehub/icons/es/Ollama', () => ({ default: () => null }));

// Heavy renderer chains — stubbed out of the extensions page tests.
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: () => null,
}));
vi.mock('../MarketplacePage', () => ({
  MarketplacePage: () => <div data-testid="marketplace-page-stub" />,
}));
vi.mock('../InstalledPage', () => ({
  InstalledPage: () => <div data-testid="installed-page-stub" />,
}));
vi.mock('../PluginInstallDialog', () => ({
  PluginInstallDialog: () => <div data-testid="install-dialog-stub" />,
}));

// Mock settings hook.
vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: { mcpServers: [] },
    save: vi.fn().mockResolvedValue(undefined),
    loading: false,
  }),
}));

// Mock translation so tests can match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock conversation store selectors used by ExtensionsPage.
vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      createThread: vi.fn().mockResolvedValue(null),
      setActiveThread: vi.fn(),
      setCurrentView: vi.fn(),
    }),
}));

const mockPluginRegistry = {
  list: vi.fn().mockResolvedValue({ success: true, data: [] }),
  install: vi.fn().mockResolvedValue({ success: true }),
  enable: vi.fn().mockResolvedValue({ success: true }),
  disable: vi.fn().mockResolvedValue({ success: true }),
  remove: vi.fn().mockResolvedValue({ success: true }),
};

const mockPluginCatalog = {
  list: vi.fn().mockResolvedValue({ success: true, data: [] }),
};

const mockAppConnection = {
  list: vi.fn().mockResolvedValue({ success: true, data: [] }),
  connect: vi.fn().mockResolvedValue({ success: true }),
  disconnect: vi.fn().mockResolvedValue({ success: true }),
  status: vi.fn().mockResolvedValue({ success: true }),
};

const mockSkills = {
  list: vi.fn().mockResolvedValue({ success: true, skills: [] }),
  getFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
  readFile: vi.fn().mockResolvedValue({ success: true, content: '' }),
};

describe('ExtensionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis.window, {
      electronAPI: {
        plugin: {
          catalog: mockPluginCatalog,
          registry: mockPluginRegistry,
        },
        appConnection: mockAppConnection,
        skills: { ...mockSkills, uploadSkill: vi.fn() },
      },
    });
  });

  it('renders the two main tabs and counts', async () => {
    const { ExtensionsPage } = await import('../ExtensionsPage');
    render(<ExtensionsPage />);

    await waitFor(() => {
      expect(screen.getByText(/extensions\.tabs\.marketplace/i)).toBeInTheDocument();
    }, { timeout: 20000 });

    expect(screen.getByText(/extensions\.tabs\.installed/i)).toBeInTheDocument();
  }, 60000);

  it('renders the marketplace as a sibling page (not a modal)', async () => {
    const user = userEvent.setup();
    const { ExtensionsPage } = await import('../ExtensionsPage');
    render(<ExtensionsPage />);

    const tab = await screen.findByText(/extensions\.tabs\.marketplace/i, {}, { timeout: 20000 });
    await user.click(tab);

    await waitFor(() => {
      expect(screen.getByTestId('marketplace-page-stub')).toBeInTheDocument();
    });
  }, 60000);

  it('switches to the installed view when the tab is clicked', async () => {
    const user = userEvent.setup();
    const { ExtensionsPage } = await import('../ExtensionsPage');
    render(<ExtensionsPage />);

    const tab = await screen.findByText(/extensions\.tabs\.installed/i, {}, { timeout: 20000 });
    await user.click(tab);

    await waitFor(() => {
      expect(screen.getByTestId('installed-page-stub')).toBeInTheDocument();
    });
  }, 60000);
});
