// @vitest-environment jsdom
/**
 * RemoveProjectConfirm tests (Plan 547 Phase 4b).
 *
 * Verifies the shared confirm modal:
 *   - Renders project name + paths count + session count.
 *   - Checkbox unchecked → onConfirm-callback path calls project-actions
 *     `deleteProject` but NOT `deleteSessionsUnderProject`.
 *   - Checkbox checked → both calls fire in order.
 *   - Cancel button → no IPC fired.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  deleteProject: vi.fn().mockResolvedValue(true),
  deleteSessionsUnderProject: vi.fn().mockResolvedValue(0),
  deleteProjectAndSessions: vi.fn().mockResolvedValue({ sessionsDeleted: 0, projectDeleted: true }),
  invalidate: vi.fn(),
  getSessionIdsUnderProject: vi.fn().mockReturnValue(['t-1', 't-2']),
}));

vi.mock('@/lib/project-actions', () => ({
  getSessionIdsUnderProject: mocks.getSessionIdsUnderProject,
  deleteProject: mocks.deleteProject,
  deleteSessionsUnderProject: mocks.deleteSessionsUnderProject,
  deleteProjectAndSessions: mocks.deleteProjectAndSessions,
}));

vi.mock('@/stores/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({ invalidate: mocks.invalidate }),
  },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

import { RemoveProjectConfirm } from '../RemoveProjectConfirm';
import type { ProjectEntity } from '@/stores/projects-store';

const PROJECT: ProjectEntity = {
  project_id: 'uuid-a',
  canonical_root: 'E:/Projects/duya',
  name: 'duya',
  description: null,
  paths: [
    { path: 'E:/Projects/duya', description: null },
    { path: 'E:/Projects/duya-website', description: 'website' },
  ],
  icon: null,
  color: null,
  created_at: 0,
  last_seen_at: 0,
};

beforeEach(() => {
  mocks.deleteProject.mockClear();
  mocks.deleteSessionsUnderProject.mockClear();
  mocks.deleteProjectAndSessions.mockClear();
  mocks.invalidate.mockClear();
  mocks.getSessionIdsUnderProject.mockReturnValue(['t-1', 't-2']);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RemoveProjectConfirm — Plan 547', () => {
  it('renders project name, paths count, and session count', () => {
    render(
      <RemoveProjectConfirm open project={PROJECT} onCancel={() => {}} />,
    );
    // Title is interpolated with name + pathsCount + sessionsCount.
    expect(
      screen.getByText(/projects\.removeProjectConfirm duya 2 2/),
    ).toBeTruthy();
    // Checkbox label.
    expect(screen.getByText('projects.removeProjectDeleteSessions')).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <RemoveProjectConfirm open={false} project={PROJECT} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders nothing when project is null', () => {
    const { container } = render(
      <RemoveProjectConfirm open project={null} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('confirm without checkbox → calls deleteProject only', async () => {
    render(
      <RemoveProjectConfirm
        open
        project={PROJECT}
        onCancel={() => {}}
        onSuccess={(n) => {
          expect(n).toBe(0);
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText('projects.removeProject'));
    });
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProject).toHaveBeenCalledWith(PROJECT);
    expect(mocks.deleteSessionsUnderProject).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it('confirm with checkbox → calls deleteProjectAndSessions', async () => {
    mocks.deleteProjectAndSessions.mockResolvedValueOnce({
      sessionsDeleted: 2,
      projectDeleted: true,
    });
    render(
      <RemoveProjectConfirm
        open
        project={PROJECT}
        onCancel={() => {}}
        onSuccess={(n) => {
          expect(n).toBe(2);
        }}
      />,
    );
    fireEvent.click(screen.getByText('projects.removeProjectDeleteSessions'));
    await act(async () => {
      fireEvent.click(screen.getByText('projects.removeProject'));
    });
    expect(mocks.deleteProjectAndSessions).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProjectAndSessions).toHaveBeenCalledWith(PROJECT);
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it('cancel button does not fire IPC', () => {
    const onCancel = vi.fn();
    render(
      <RemoveProjectConfirm open project={PROJECT} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });
});