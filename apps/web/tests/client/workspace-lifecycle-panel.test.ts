// @vitest-environment jsdom
/**
 * What the shared workspace-lifecycle panel shows on the Web surface.
 *
 * The panel is shared by every surface, and its first duty is to keep three
 * answers apart: "this session is not inside a managed checkout", "this
 * surface cannot observe checkouts", and "the Host could not answer". The
 * Web contributes the first and the third; the middle one is what a surface
 * WITHOUT an adapter has to say.
 *
 * The Web installs its adapter in `src/main.tsx`, so the registry is empty
 * until it does — and that is what the panel renders in the meantime. The
 * test reads the panel's copy, not the port's shape, because the copy is
 * what the user acts on.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceLifecyclePanel } from '@/components/workspace/WorkspaceLifecyclePanel';
import { WorkspaceLifecycleProvider } from '@/hooks/useWorkspaceLifecycle';
import { peekWorkspaceLifecycle } from '@/services/workspace-lifecycle';
import { createWebWorkspaceLifecycle } from '../../src/client/ui-services-adapter.js';
import { createLifecycleBff, integrationRecord, jsonResponse } from './lifecycle-bff.js';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(' ')}` : key,
  }),
}));

// Without cleanup the rendered panels pile up in the document, and every
// `getByText` then finds the previous test's DOM as well.
afterEach(cleanup);

function renderPanel(port: ReturnType<typeof peekWorkspaceLifecycle>): void {
  render(
    React.createElement(
      WorkspaceLifecycleProvider,
      { port },
      React.createElement(WorkspaceLifecyclePanel, { sessionId: 'session-1' }),
    ),
  );
}

describe('the shared panel on the Web surface', () => {
  it('says the surface cannot answer while no adapter is installed', async () => {
    renderPanel(peekWorkspaceLifecycle());

    await waitFor(() => {
      expect(screen.getByText('wsl.checkout.cannotAnswer')).toBeTruthy();
    });
    expect(screen.getByText('wsl.integrations.cannotAnswer')).toBeTruthy();
    // The dangerous shape: an empty checkout the user then acts on.
    expect(screen.queryByText('wsl.checkout.none')).toBeNull();
  });

  it('shows what the Host answered once the Web installs its adapter', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse({
        checkout: { sessionId: 'session-1', checkout: null, isOwner: false },
      }),
      '/api/integrations?sessionId=session-1': () => jsonResponse({
        records: [integrationRecord({ state: 'unknown', observedError: 'gh: not authenticated' })],
      }),
    });
    renderPanel(createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl }));

    // "We could not look" is rendered as `unknown`, with the reason — never
    // as `open`.
    expect(await screen.findByText('unknown')).toBeTruthy();
    expect(screen.getByText('wsl.integrations.unknown gh: not authenticated')).toBeTruthy();
    expect(screen.queryByText('open')).toBeNull();
    expect(screen.queryByText('wsl.integrations.cannotAnswer')).toBeNull();
  });
});
