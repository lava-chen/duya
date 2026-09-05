// @vitest-environment jsdom
/**
 * bot-direct-cards — Plan 489 P2.4 bot-card UI smoke tests.
 *
 * The card family is pure presentational (no state, no i18n, no electronAPI),
 * so these are minimal rendering checks: each component renders, and the key
 * prop branches behave (BotDirectCard kind, RoomRoundMark agentName fallback,
 * RoomPassNote optional reason, BotBroadcastCard collapsed/non-collapsed).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  BotDirectCard,
  RoomRoundMark,
  RoomPassNote,
  BotBroadcastCard,
} from '../index';

describe('BotDirectCard', () => {
  it('renders a readable note envelope with title and children', () => {
    render(
      <BotDirectCard kind="readable note" title="Handout">
        Hello from the agent.
      </BotDirectCard>,
    );
    const card = screen.getByTestId('bot-direct-card');
    expect(card.getAttribute('data-kind')).toBe('readable note');
    expect(screen.getByText('Handout')).toBeDefined();
    expect(screen.getByText('Hello from the agent.')).toBeDefined();
  });

  it('renders an event envelope without a title', () => {
    render(<BotDirectCard kind="event">State changed.</BotDirectCard>);
    const card = screen.getByTestId('bot-direct-card');
    expect(card.getAttribute('data-kind')).toBe('event');
    expect(screen.getByText('State changed.')).toBeDefined();
  });
});

describe('RoomRoundMark', () => {
  it('shows the agent name badge when agentName is provided', () => {
    render(
      <RoomRoundMark agentName="Alice" previousParticipants={['Bob']} />,
    );
    const badge = screen.getByText('Alice');
    expect(badge.getAttribute('data-badge-agent')).toBe('true');
  });

  it('falls back to the round label when agentName is missing', () => {
    render(<RoomRoundMark label="round" />);
    const badge = screen.getByText('round');
    expect(badge.getAttribute('data-badge-agent')).toBeNull();
  });

  it('renders a horizontal rule separator', () => {
    render(<RoomRoundMark agentName="Alice" />);
    // The divider span sits between the badge and any participant list.
    expect(screen.getByTestId('room-round-mark')).toBeDefined();
    expect(screen.getByText('Alice')).toBeDefined();
  });
});

describe('RoomPassNote', () => {
  it('shows agent name when provided', () => {
    render(<RoomPassNote agentName="Eve" />);
    expect(
      screen.getByText(/Eve was mentioned but chose not to speak/),
    ).toBeDefined();
  });

  it('falls back to a generic subject and shows the reason', () => {
    render(<RoomPassNote reason="defers to lead" />);
    expect(
      screen.getByText(/This member was mentioned but chose not to speak \(defers to lead\)/),
    ).toBeDefined();
  });
});

describe('BotBroadcastCard', () => {
  const agents = [
    { name: 'Alice', avatarInitial: 'A', text: 'need the nightly report' },
    { name: 'Bob', avatarInitial: 'B', text: 'can you sanity-check' },
  ];

  it('lists every agent header + text when expanded', () => {
    render(<BotBroadcastCard agents={agents} />);
    expect(screen.getByTestId('bot-broadcast-card').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('need the nightly report')).toBeDefined();
    expect(screen.getByText('Bob')).toBeDefined();
    expect(screen.getByText('can you sanity-check')).toBeDefined();
  });

  it('collapses to an "n agents" chip', () => {
    render(<BotBroadcastCard agents={agents} collapsed />);
    expect(screen.getByTestId('bot-broadcast-card').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByText('2 agents')).toBeDefined();
    // Member bodies are hidden when collapsed.
    expect(screen.queryByText('need the nightly report')).toBeNull();
  });

  it('uses the singular label for a single agent', () => {
    render(<BotBroadcastCard agents={[agents[0]]} collapsed />);
    expect(screen.getByText('1 agent')).toBeDefined();
  });
});