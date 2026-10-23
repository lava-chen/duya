// @vitest-environment jsdom
/**
 * ProjectGroupItem subscription scope.
 *
 * This component is rendered once per project group, so a whole-store
 * subscription multiplied the re-render cost by the number of groups on
 * every unrelated conversation-store write. The composer persists the
 * new-chat draft to the store on every keystroke, so "unrelated write" is
 * the common case while typing, not a rare one.
 *
 * The contract pinned here: a write to a slice the sidebar does not display
 * must not re-render the group (and therefore must not re-render its
 * session rows).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const threadItemRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The session row is the observable proxy for "the group re-rendered": the
// group hands it a fresh element on every render.
vi.mock('@/components/shared/ThreadListItem', () => ({
  ThreadListItem: () => {
    threadItemRenders.count += 1;
    return <div data-testid="thread-item" />;
  },
}));

vi.mock('@/lib/project-actions', () => ({
  archiveSessionsUnderProject: vi.fn(async () => undefined),
  deleteSessionsUnderProject: vi.fn(async () => undefined),
  openProjectFolder: vi.fn(async () => undefined),
  copyProjectPath: vi.fn(async () => undefined),
}));

vi.mock('@/components/projects/RemoveProjectConfirm', () => ({
  RemoveProjectConfirm: () => null,
}));

vi.mock('@/components/ui/DropdownMenu', () => ({
  DropdownMenu: () => null,
}));

vi.mock('@/components/ui/InputDialog', () => ({
  InputDialog: () => null,
}));

import { ProjectGroupItem } from './ProjectGroupItem';
import { useConversationStore } from '@/stores/conversation-store';
import { useSidebarSectionsStore } from '@/stores/sidebar-sections-store';
import type { ProjectGroup, Thread } from '@/stores/conversation-store';

const project: ProjectGroup = {
  workingDirectory: 'C:/work/demo',
  projectName: 'demo',
  threadCount: 1,
  lastActivity: 1,
  createdAt: 1,
  isExpanded: true,
};

const thread = {
  id: 'thread-1',
  title: 'A session',
  workingDirectory: 'C:/work/demo',
  projectName: 'demo',
  createdAt: 1,
  updatedAt: 2,
} as unknown as Thread;

function renderGroup() {
  return render(
    <ProjectGroupItem
      project={project}
      threads={[thread]}
      activeThreadId={null}
      sortBy="lastActivity"
    />,
  );
}

describe('ProjectGroupItem subscription scope', () => {
  beforeEach(() => {
    threadItemRenders.count = 0;
    useConversationStore.setState({ collapsedProjects: new Set<string>() });
  });

  it('renders the session row once on mount', () => {
    renderGroup();
    expect(threadItemRenders.count).toBe(1);
  });

  it('does not re-render when the new-chat draft changes', () => {
    renderGroup();
    const before = threadItemRenders.count;
    act(() => {
      // What the composer writes on every keystroke.
      useConversationStore.setState({
        newChatDraft: { text: 'h', attachments: [], hasContent: true },
      });
    });
    expect(threadItemRenders.count).toBe(before);
  });

  it('does not re-render when an unrelated conversation-store slice changes', () => {
    renderGroup();
    const before = threadItemRenders.count;
    act(() => {
      useConversationStore.setState({ noProjectWorkspace: 'C:/elsewhere' });
    });
    expect(threadItemRenders.count).toBe(before);
  });

  it('does not re-render when the sections store hydration flag changes', () => {
    renderGroup();
    const before = threadItemRenders.count;
    act(() => {
      useSidebarSectionsStore.setState({ hydrated: true });
    });
    expect(threadItemRenders.count).toBe(before);
  });

  it('reacts to the project collapse state changing', () => {
    const { container } = renderGroup();
    expect(container.querySelectorAll('[data-testid="thread-item"]')).toHaveLength(1);
    act(() => {
      useConversationStore.setState({
        collapsedProjects: new Set<string>([project.workingDirectory]),
      });
    });
    // Collapsing the group hides its session rows, which only happens if the
    // group re-rendered against the new collapse state.
    expect(container.querySelectorAll('[data-testid="thread-item"]')).toHaveLength(0);
  });

  it('does re-render when a user section is added', () => {
    renderGroup();
    const before = threadItemRenders.count;
    act(() => {
      useSidebarSectionsStore.setState({
        sections: [
          {
            id: 'section-1',
            name: 'Section',
            icon: null,
            color: null,
            sortOrder: 0,
            collapsed: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
    });
    expect(threadItemRenders.count).toBeGreaterThan(before);
  });
});
