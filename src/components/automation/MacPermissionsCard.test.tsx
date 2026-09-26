// @vitest-environment jsdom

/**
 * MacPermissionsCard.test.tsx — plan 572 Phase 1 UI gate.
 *
 * Drives the card through the real `window.electronAPI.
 * computerUsePermissions` bridge shape the preload exposes:
 * granted / partially-granted states, the helper-missing state, the
 * System Settings deep links, and the hidden-on-non-darwin contract.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MacPermissionsCard } from './MacPermissionsCard';

type PermissionsSnapshot = {
  platform: string;
  helperAvailable: boolean;
  accessibility: 'granted' | 'denied' | 'not-determined' | 'unknown';
  screen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  listen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  secureInputPid: number | null;
};

const baseSnapshot: PermissionsSnapshot = {
  platform: 'darwin',
  helperAvailable: true,
  accessibility: 'granted',
  screen: 'granted',
  listen: 'granted',
  secureInputPid: null,
};

const getMock = vi.fn<[], Promise<PermissionsSnapshot>>();
const openPaneMock = vi.fn<[], Promise<boolean>>();

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  writable: true,
  value: {
    computerUsePermissions: {
      get: (...args: unknown[]) => (getMock as unknown as (...a: unknown[]) => Promise<PermissionsSnapshot>)(...args),
      openPane: (...args: unknown[]) => (openPaneMock as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    },
  },
});

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(baseSnapshot);
  openPaneMock.mockReset().mockResolvedValue(true);
});

describe('MacPermissionsCard', () => {
  it('renders all three permission rows granted without settings buttons', async () => {
    const { container } = render(<MacPermissionsCard />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toContain('macPermissions.title'));
    const text = container.textContent ?? '';
    expect(text).toContain('辅助功能');
    expect(text).toContain('屏幕录制');
    expect(text).toContain('输入监控');
    // All granted → no deep-link buttons at all.
    expect(text).not.toContain('macPermissions.openSettings');
    expect(container.querySelectorAll('button').length).toBe(1); // only Re-check
  });

  it('shows deep links for denied permissions and opens the matching pane', async () => {
    getMock.mockResolvedValue({ ...baseSnapshot, accessibility: 'denied', listen: 'denied' });
    const { container } = render(<MacPermissionsCard />);
    await waitFor(() => expect(container.textContent).toContain('辅助功能'));
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'macPermissions.openSettings',
    );
    expect(buttons).toHaveLength(2); // accessibility + listen denied
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(openPaneMock).toHaveBeenCalledWith('accessibility'),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('macPermissions.grantHint');
  });

  it('surfaces the helper-missing state', async () => {
    getMock.mockResolvedValue({ ...baseSnapshot, helperAvailable: false });
    const { container } = render(<MacPermissionsCard />);
    await waitFor(() =>
      expect(container.textContent).toContain('macPermissions.helperMissing'),
    );
  });

  it('renders nothing when the platform is not darwin', async () => {
    getMock.mockResolvedValue({ ...baseSnapshot, platform: 'win32' });
    const { container } = render(<MacPermissionsCard />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="mac-permissions-card"]')).toBeNull();
  });

  it('renders nothing when the bridge is absent (browser-only Vite)', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
    const { container } = render(<MacPermissionsCard />);
    expect(container.querySelector('[data-testid="mac-permissions-card"]')).toBeNull();
    if (original) Object.defineProperty(window, 'electronAPI', original);
  });
});
