/**
 * @vitest-environment jsdom
 *
 * ConnectorAuthRequiredCard state machine tests (Plan 498) + card identity
 * tests (provider catalog resolution):
 *   - waiting → Authorize click → connect resolves → connected + onRetry once
 *   - connect failure → failed state with Retry re-entering the flow
 *   - `authCompleted` prop drives the same connected transition (settings
 *     page reconnect path) and never double-fires onRetry
 *   - the card resolves the provider's display metadata (label/brand icon/
 *     description) from the providers catalog, falling back to the raw
 *     provider id when the catalog is unreachable
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ConnectorAuthRequiredCard } from './ConnectorAuthRequiredCard';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    locale: 'en',
  }),
}));

vi.mock('@/components/icons', () => ({
  ShieldIcon: () => <svg data-testid="shield-icon" />,
  ShieldCheckIcon: () => <svg data-testid="shield-check-icon" />,
}));

const connectMock = vi.fn();
const providersMock = vi.fn();
vi.mock('@/lib/app-connection-ipc', () => ({
  getAppConnectionAPI: () => ({
    connect: (...args: unknown[]) => connectMock(...args),
    providers: (...args: unknown[]) => providersMock(...args),
  }),
}));

const PROVIDER_CATALOG = [
  {
    id: 'notion',
    label: 'Notion',
    monogram: 'N',
    description: 'Notion pages and databases',
    configured: true,
    supportsManualConfiguration: false,
    requiresClientSecret: false,
  },
  {
    id: 'google',
    label: 'Google Drive',
    monogram: 'G',
    description: 'Search and read files from Google Drive with source links.',
    configured: true,
    supportsManualConfiguration: false,
    requiresClientSecret: false,
  },
];

const baseRequest = { provider: 'notion', connectionId: 'conn-1', toolName: 'notion_create_page' };

function renderCard(overrides: Partial<Parameters<typeof ConnectorAuthRequiredCard>[0]> = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <ConnectorAuthRequiredCard
      request={baseRequest}
      onDismiss={onDismiss}
      onRetry={onRetry}
      resolveProviderLabel={(id) => id}
      {...overrides}
    />,
  );
  return { onRetry, onDismiss, ...utils };
}

describe('ConnectorAuthRequiredCard (Plan 498)', () => {
  beforeEach(() => {
    connectMock.mockReset();
    providersMock.mockReset();
    providersMock.mockResolvedValue({ success: true, data: PROVIDER_CATALOG });
  });

  it('renders the waiting state and resumes through connected on successful re-auth', async () => {
    connectMock.mockResolvedValue({ success: true, data: { id: 'conn-1' } });
    const { onRetry } = renderCard();

    // The title/body resolve the brand label from the providers catalog.
    await waitFor(() => {
      expect(
        screen.getByText('connectorAuth.reauthTitleNamed:{"provider":"Notion"}'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('connectorAuth.body:{"provider":"Notion","tool":"notion_create_page"}'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectorAuth.reauthorize' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.reauthorize' }));

    expect(connectMock).toHaveBeenCalledWith({ provider: 'notion' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'connectorAuth.connected:{"provider":"Notion"}',
      );
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lands in the failed state with a Retry button when connect fails', async () => {
    connectMock.mockResolvedValueOnce({ success: false, error: 'popup blocked' });
    const { onRetry } = renderCard();

    await waitFor(() => {
      expect(
        screen.getByText('connectorAuth.reauthTitleNamed:{"provider":"Notion"}'),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.reauthorize' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('popup blocked');
    });
    expect(onRetry).not.toHaveBeenCalled();

    // Retry re-enters the flow and succeeds this time.
    connectMock.mockResolvedValueOnce({ success: true, data: { id: 'conn-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.retry' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('fires onRetry exactly once when authCompleted and the connect race together', async () => {
    let resolveConnect: (value: { success: boolean }) => void = () => {};
    connectMock.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    const { onRetry, rerender } = renderCard();

    await waitFor(() => {
      expect(
        screen.getByText('connectorAuth.reauthTitleNamed:{"provider":"Notion"}'),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.reauthorize' }));

    // Main broadcast arrives while the card is still connecting.
    rerender(
      <ConnectorAuthRequiredCard
        request={baseRequest}
        authCompleted
        onDismiss={vi.fn()}
        onRetry={onRetry}
        resolveProviderLabel={(id) => id}
      />,
    );
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // The in-flight connect resolves afterwards — must not double-resume.
    resolveConnect({ success: true });
    await waitFor(() => {
      expect(connectMock).toHaveBeenCalled();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the plan 503 connect variant copy for a bot-initiated connect', async () => {
    connectMock.mockResolvedValue({ success: true, data: { id: 'conn-2' } });
    const { onRetry } = renderCard({
      request: { provider: 'google', toolName: 'connect_app', variant: 'connect' },
    });

    await waitFor(() => {
      expect(
        screen.getByText('connectorAuth.connectTitleNamed:{"provider":"Google Drive"}'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('connectorAuth.connectBody:{"provider":"Google Drive"}'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectorAuth.authorize' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.authorize' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'connectorAuth.connected:{"provider":"Google Drive"}',
      );
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw provider id when the providers catalog is unavailable', async () => {
    providersMock.mockResolvedValue({ success: false, error: 'not ready' });
    renderCard();

    await waitFor(() => {
      expect(
        screen.getByText('connectorAuth.reauthTitleNamed:{"provider":"notion"}'),
      ).toBeInTheDocument();
    });
    // No brand metadata → generic shield placeholder instead of a brand icon.
    expect(screen.getByTestId('shield-icon')).toBeInTheDocument();
  });

  it('shows the brand icon and description once the catalog resolves', async () => {
    const { container } = renderCard();

    await waitFor(() => {
      // The icon tile is aria-hidden (decorative — the title carries the
      // name), so query the SVG by its aria-label attribute directly.
      expect(container.querySelector('svg[aria-label="Notion"]')).toBeInTheDocument();
    });
    expect(screen.getByText('Notion pages and databases')).toBeInTheDocument();
  });
});
