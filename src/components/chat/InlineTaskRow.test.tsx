/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineTaskRow } from './InlineTaskRow';

const mockGitStatus = {
  isGitRepo: false,
  fileChanges: [] as Array<{ path: string; additions: number; removals: number }>,
  totals: { additions: 0, removals: 0, fileCount: 0 },
};

const mockOpenOrActivatePage = vi.fn();

vi.mock('@/components/icons', () => ({
  CheckIcon: ({ size }: { size?: number }) => <span data-testid="check-icon" style={{ fontSize: size }} />,
  CircleIcon: ({ size }: { size?: number }) => <span data-testid="circle-icon" style={{ fontSize: size }} />,
  SpinnerIcon: ({ size }: { size?: number }) => <span data-testid="spinner-icon" style={{ fontSize: size }} />,
  ListChecksIcon: ({ size }: { size?: number }) => <span data-testid="list-icon" style={{ fontSize: size }} />,
  GitBranchIcon: ({ size }: { size?: number }) => <span data-testid="git-icon" style={{ fontSize: size }} />,
}));

vi.mock('@/hooks/usePanel', () => ({
  useOptionalPanel: () => ({
    openOrActivatePage: mockOpenOrActivatePage,
  }),
}));

describe('InlineTaskRow', () => {
  const onToggleStatus = vi.fn();

  beforeEach(() => {
    onToggleStatus.mockReset();
    mockOpenOrActivatePage.mockReset();
    mockGitStatus.isGitRepo = false;
    mockGitStatus.fileChanges = [];
    mockGitStatus.totals = { additions: 0, removals: 0, fileCount: 0 };
  });

  it('returns null when there are no tasks and no file changes', () => {
    const { container } = render(
      <InlineTaskRow tasks={[]} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders only the file-change segment when there are no tasks', () => {
    const gitStatus = {
      isGitRepo: true,
      fileChanges: [{ path: 'README.md', additions: 5, removals: 1 }],
      totals: { additions: 5, removals: 1, fileCount: 1 },
    };
    const { container } = render(
      <InlineTaskRow tasks={[]} gitStatus={gitStatus} onToggleStatus={onToggleStatus} />
    );

    expect(container.querySelector('.inline-task-row-git')).toBeInTheDocument();
    expect(screen.getByText('1 个文件已更改')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    // Task segment absent.
    expect(container.querySelector('.inline-task-row-main')).not.toBeInTheDocument();
  });

  it('renders only the task segment when there are no file changes', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Write tests',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    const { container } = render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    expect(container.querySelector('.inline-task-row-main')).toBeInTheDocument();
    expect(screen.getByText(/Write tests/)).toBeInTheDocument();
    // Git segment absent.
    expect(container.querySelector('.inline-task-row-git')).not.toBeInTheDocument();
    expect(screen.queryByText(/个文件已更改/)).not.toBeInTheDocument();
  });

  it('renders the row with active subject and (completed/total) progress', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Design API',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'completed' as const,
      },
      {
        id: 't2',
        subject: 'Implement endpoint',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'in_progress' as const,
      },
      {
        id: 't3',
        subject: 'Write docs',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    // Active subject and progress are rendered inline.
    expect(screen.getByText(/Implement endpoint/)).toBeInTheDocument();
    expect(screen.getByText(/\(1\/3\)/)).toBeInTheDocument();
    // 进行中 prefix is present.
    expect(screen.getByText('进行中:')).toBeInTheDocument();
  });

  it('keeps the row and switches to a completed prefix when all tasks are done', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Design API',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'completed' as const,
      },
      {
        id: 't2',
        subject: 'Implement endpoint',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'completed' as const,
      },
    ];
    render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    // Row stays visible with a completed prefix and N/N progress.
    expect(screen.getByText('已完成:')).toBeInTheDocument();
    expect(screen.getByText(/\(2\/2\)/)).toBeInTheDocument();
    expect(screen.queryByText('进行中:')).not.toBeInTheDocument();
  });

  it('opens popover when the row is clicked', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Write tests',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    const { container } = render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    expect(container.querySelector('.inline-task-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /展开任务列表/ }));

    expect(container.querySelector('.inline-task-popover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark task done' })).toBeInTheDocument();
  });

  it('calls onToggleStatus when a status icon in the popover is clicked', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Refactor',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    fireEvent.click(screen.getByRole('button', { name: /展开任务列表/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark task done' }));

    expect(onToggleStatus).toHaveBeenCalledWith(tasks[0]);
  });

  it('opens the code review panel when the git segment is clicked', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Update docs',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'completed' as const,
      },
    ];
    const gitStatus = {
      isGitRepo: true,
      fileChanges: [{ path: 'README.md', additions: 12, removals: 3 }],
      totals: { additions: 12, removals: 3, fileCount: 1 },
    };
    render(
      <InlineTaskRow
        tasks={tasks}
        gitStatus={gitStatus}
        onToggleStatus={onToggleStatus}
        workingDirectory="/workspace/project"
      />
    );

    expect(screen.getByText('+12')).toBeInTheDocument();
    expect(screen.getByText('-3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开代码审查' }));

    expect(mockOpenOrActivatePage).toHaveBeenCalledWith('review', {
      workingDirectory: '/workspace/project',
    });
  });

  it('hides the git segment when showFileChanges is false', () => {
    const gitStatus = {
      isGitRepo: true,
      fileChanges: [{ path: 'README.md', additions: 5, removals: 1 }],
      totals: { additions: 5, removals: 1, fileCount: 1 },
    };
    const { container } = render(
      <InlineTaskRow
        tasks={[]}
        gitStatus={gitStatus}
        onToggleStatus={onToggleStatus}
        showFileChanges={false}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/个文件已更改/)).not.toBeInTheDocument();
  });

  it('closes the popover when clicking outside', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Ship it',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    const { container } = render(
      <div data-testid="outside">
        <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: /展开任务列表/ }));
    expect(container.querySelector('.inline-task-popover')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(container.querySelector('.inline-task-popover')).not.toBeInTheDocument();
  });

  it('closes the popover when Escape is pressed', () => {
    const tasks = [
      {
        id: 't1',
        subject: 'Ship it',
        description: '',
        blocks: [] as string[],
        blockedBy: [] as string[],
        status: 'pending' as const,
      },
    ];
    const { container } = render(
      <InlineTaskRow tasks={tasks} gitStatus={mockGitStatus} onToggleStatus={onToggleStatus} />
    );

    fireEvent.click(screen.getByRole('button', { name: /展开任务列表/ }));
    expect(container.querySelector('.inline-task-popover')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.inline-task-popover')).not.toBeInTheDocument();
  });
});