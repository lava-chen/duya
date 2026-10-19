// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Icons barrel pulls in @tabler/icons-react (heap heavy in tests).
vi.mock('@/components/icons', () => ({
  CheckIcon: () => null,
  InfoIcon: () => null,
}));

import { BotAskCard } from '../BotAskCard';
import type { PermissionRequestEvent } from '@/types/stream';

const t = (k: string, params?: Record<string, string | number>) =>
  params && 'count' in params ? `${k}:${params.count}` : k;

function askRequest(overrides: {
  questions?: unknown;
  multiSelect?: boolean;
}): PermissionRequestEvent {
  return {
    id: 'perm-1',
    toolName: 'AskUserQuestion',
    mode: 'ask_user_question',
    expiresAt: Date.now() + 60_000,
    toolInput: {
      questions: overrides.questions ?? [
        {
          question: 'Which database?',
          header: 'Storage',
          multiSelect: overrides.multiSelect ?? false,
          options: [
            { label: 'PostgreSQL' },
            { label: 'SQLite (Recommended)', description: 'Zero-config local file' },
          ],
        },
      ],
    },
  } as PermissionRequestEvent;
}

const baseProps = {
  onSubmit: vi.fn(),
  t: t as never,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BotAskCard', () => {
  it('renders question text, header tag and option rows with letter badges', () => {
    render(<BotAskCard {...baseProps} request={askRequest({})} />);
    expect(screen.getByText('Which database?')).toBeDefined();
    expect(screen.getByText('Storage')).toBeDefined();
    expect(screen.getByText('PostgreSQL')).toBeDefined();
    expect(screen.getByText('SQLite')).toBeDefined();
    expect(screen.getByText('A')).toBeDefined();
    expect(screen.getByText('B')).toBeDefined();
    // Recommended badge derived from "(Recommended)" suffix.
    expect(screen.getByText('bot.ask.recommended')).toBeDefined();
    // Recommended preselect enables submit immediately (second test covers it).
  });

  it('auto-preselects the (Recommended) option for single-select questions', () => {
    const { container } = render(<BotAskCard {...baseProps} request={askRequest({})} />);
    const selected = container.querySelectorAll('.bot-ask-card__option.selected');
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('SQLite');
    // Preselection enables submit immediately.
    expect((screen.getByText('permission.continueHint').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('selects an option and submits { questions, answers }', () => {
    render(<BotAskCard {...baseProps} request={askRequest({})} />);
    // Pick PostgreSQL (overriding the preselected recommended option).
    fireEvent.click(screen.getByText('PostgreSQL'));
    fireEvent.click(screen.getByText('permission.continueHint'));
    expect(baseProps.onSubmit).toHaveBeenCalledTimes(1);
    const payload = baseProps.onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.answers).toEqual({ 'Which database?': 'PostgreSQL' });
    expect(payload.questions).toBeDefined();
    expect((payload as { _dismissed?: boolean })._dismissed).toBeUndefined();
  });

  it('toggles multiple selections for multiSelect questions', () => {
    render(
      <BotAskCard
        {...baseProps}
        request={askRequest({
          multiSelect: true,
          questions: [
            {
              question: 'Pick stacks?',
              multiSelect: true,
              options: [{ label: 'React' }, { label: 'Vue' }],
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByText('React'));
    fireEvent.click(screen.getByText('Vue'));
    fireEvent.click(screen.getByText('permission.continueHint'));
    const payload = baseProps.onSubmit.mock.calls[0][0] as { answers: Record<string, string> };
    expect(payload.answers['Pick stacks?']).toBe('React || Vue');
  });

  it('routes free-text feedback as "User feedback: …"', () => {
    render(<BotAskCard {...baseProps} request={askRequest({})} />);
    fireEvent.click(screen.getByText('permission.tellDuyaWhatToDoDifferently'));
    fireEvent.change(screen.getByPlaceholderText('permission.feedbackPlaceholder'), {
      target: { value: 'use duckdb instead' },
    });
    fireEvent.click(screen.getByText('permission.continueHint'));
    const payload = baseProps.onSubmit.mock.calls[0][0] as { answers: Record<string, string> };
    expect(payload.answers['Which database?']).toBe('User feedback: use duckdb instead');
  });

  it('dismiss submits empty answers with _dismissed flag', () => {
    render(<BotAskCard {...baseProps} request={askRequest({})} />);
    fireEvent.click(screen.getByText('permission.dismissHint'));
    const payload = baseProps.onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.answers).toEqual({});
    expect(payload._dismissed).toBe(true);
  });

  it('expands the option description via the info button', () => {
    const { container } = render(<BotAskCard {...baseProps} request={askRequest({})} />);
    expect(container.querySelector('.bot-ask-card__description')).toBeNull();
    fireEvent.click(screen.getByLabelText('Show description'));
    expect(container.querySelector('.bot-ask-card__description')?.textContent).toBe(
      'Zero-config local file',
    );
  });

  it('renders nothing without parseable questions', () => {
    const request = askRequest({ questions: [] });
    const { container } = render(<BotAskCard {...baseProps} request={request} />);
    expect(container.querySelector('.bot-ask-card')).toBeNull();
  });
});
