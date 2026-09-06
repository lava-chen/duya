/**
 * @vitest-environment jsdom
 *
 * ConnectorAuthRequiredCard state machine tests (Plan 498):
 *   - waiting → Authorize click → connect resolves → connected + onRetry once
 *   - connect failure → failed state with Retry re-entering the flow
 *   - `authCompleted` prop drives the same connected transition (settings
 *     page reconnect path) and never double-fires onRetry
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
}));

const connectMock = vi.fn();
vi.mock('@/lib/app-connection-ipc', () => ({
  getAppConnectionAPI: () => ({
    connect: (...args: unknown[]) => connectMock(...args),
  }),
}));

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
  });

  it('renders the waiting state and resumes through connected on successful re-auth', async () => {
    connectMock.mockResolvedValue({ success: true, data: { id: 'conn-1' } });
    const { onRetry } = renderCard();

    expect(screen.getByText('connectorAuth.body:{"provider":"notion","tool":"notion_create_page"}'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectorAuth.reauthorize' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'connectorAuth.reauthorize' }));

    expect(connectMock).toHaveBeenCalledWith({ provider: 'notion' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'connectorAuth.connected:{"provider":"notion"}',
      );
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lands in the failed state with a Retry button when connect fails', async () => {
    connectMock.mockResolvedValueOnce({ success: false, error: 'popup blocked' });
    const { onRetry } = renderCard();

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
});
