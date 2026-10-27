// @vitest-environment jsdom
/**
 * SectionActions — the sidebar section header's trailing action group
 * (Claude parity, 2026-10-22).
 *
 * Pins the two contracts that are easy to break silently:
 *   1. Every button is opt-in: a section that cannot honour a button does
 *      not render it, so no dead control appears in the header.
 *   2. The filter popover shows the *current* mode on the row itself and
 *      writes through the callbacks it is given — it owns no state.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionActions, type SectionFilterModel } from './SectionActions';

// Translation returns the key (suffixed with params) so assertions can match
// i18n keys directly, mirroring ThreadListItem.test.tsx.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

function filterModel(overrides: Partial<SectionFilterModel> = {}): SectionFilterModel {
  return {
    sortBy: 'priority',
    onSortBy: vi.fn(),
    showEmptyGroups: false,
    onShowEmptyGroups: vi.fn(),
    ...overrides,
  };
}

function openFilter(): void {
  fireEvent.click(screen.getByRole('button', { name: 'sidebar.filter.title' }));
}

describe('SectionActions', () => {
  it('renders nothing but the group wrapper when no capability is passed', () => {
    const { container } = render(<SectionActions />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('omits the create button when the section cannot host new items', () => {
    render(<SectionActions onToggleSearch={() => {}} />);
    expect(screen.queryByRole('button', { name: 'project.newProject' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'sidebar.section.searchInGroup' }),
    ).toBeTruthy();
  });

  it('wires the create button to its label and handler', () => {
    const onCreate = vi.fn();
    render(<SectionActions onCreate={onCreate} createLabel="project.newProject" />);
    fireEvent.click(screen.getByRole('button', { name: 'project.newProject' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('marks the search button pressed while the group search is open', () => {
    render(<SectionActions onToggleSearch={() => {}} searchActive />);
    expect(
      screen.getByRole('button', { name: 'sidebar.section.searchInGroup' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the current sort mode on the filter row instead of hiding it in the flyout', () => {
    render(<SectionActions filter={filterModel({ sortBy: 'manual' })} />);
    openFilter();
    expect(screen.getByText('sidebar.filter.sortBy')).toBeTruthy();
    expect(screen.getByText('project.manualSort')).toBeTruthy();
  });

  it('only offers 分组方式 where the section has both layouts', () => {
    const { unmount } = render(<SectionActions filter={filterModel()} />);
    openFilter();
    expect(screen.queryByText('sidebar.filter.groupBy')).toBeNull();
    unmount();

    render(
      <SectionActions
        filter={filterModel({
          groupBy: 'byDate',
          onGroupBy: vi.fn(),
        })}
      />,
    );
    openFilter();
    expect(screen.getByText('sidebar.filter.groupBy')).toBeTruthy();
    // Claude parity (2026-10-26): two grouping modes only — the flat
    // "all sessions" mode was removed.
    fireEvent.mouseEnter(screen.getByText('sidebar.filter.groupBy'));
    expect(screen.getAllByText('project.byDate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('project.byProject').length).toBeGreaterThan(0);
    expect(screen.queryByText('project.inOneList')).toBeNull();
  });

  it('reports the "显示空分组" switch as an inverted toggle', () => {
    // Stateless component: it must send the *next* value, not the current one.
    const onShowEmptyGroups = vi.fn();
    render(
      <SectionActions filter={filterModel({ showEmptyGroups: false, onShowEmptyGroups })} />,
    );
    openFilter();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /sidebar\.filter\.showEmptyGroups/ }));
    expect(onShowEmptyGroups).toHaveBeenCalledWith(true);
  });

  it('writes the picked sort mode through the callback', () => {
    const onSortBy = vi.fn();
    render(<SectionActions filter={filterModel({ sortBy: 'priority', onSortBy })} />);
    openFilter();
    // The submenu row writes the choice, so the mode is never local state.
    fireEvent.mouseEnter(screen.getByText('sidebar.filter.sortBy'));
    fireEvent.click(screen.getAllByText('project.lastUpdated').at(-1)!);
    expect(onSortBy).toHaveBeenCalledWith('lastActivity');
  });
});
