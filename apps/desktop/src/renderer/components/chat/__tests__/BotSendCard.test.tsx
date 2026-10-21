// @vitest-environment jsdom
/**
 * BotSendCard — Plan 489 P2.2 minimal card rendering tests.
 *
 * Dispatch by msgType: attachment chip, widget option buttons
 * (click → onOptionClick), cursor-agent badge, secret-request
 * descriptor, text + image strip. No electronAPI needed — the card is
 * a pure function of the Message.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BotSendCard, BotSendImageView } from '../BotSendCard';
import type { Message } from '@/types/message';

function cardMessage(overrides: Partial<Message>): Message {
  return {
    id: 'card-1',
    role: 'assistant',
    content: '',
    timestamp: 1725500000000,
    msgType: 'attachment',
    ...overrides,
  } as Message;
}

describe('BotSendCard', () => {
  it('renders an attachment chip with alt label linking the url', () => {
    render(
      <BotSendCard
        message={cardMessage({
          content: 'see attached',
          sendMessageMeta: { url: 'https://example.com/report.pdf', alt: 'report.pdf' },
        })}
      />,
    );
    expect(screen.getByText('see attached')).toBeDefined();
    const chip = screen.getByText('report.pdf').closest('a');
    expect(chip?.getAttribute('href')).toBe('https://example.com/report.pdf');
  });

  it('renders widget options and reports clicks', () => {
    const onOptionClick = vi.fn();
    render(
      <BotSendCard
        message={cardMessage({
          msgType: 'widget',
          content: '',
          sendMessageMeta: {
            widget: { prompt: 'Which night?', options: ['the 12th', 'the 14th'] },
          },
        })}
        onOptionClick={onOptionClick}
      />,
    );
    expect(screen.getByText('Which night?')).toBeDefined();
    fireEvent.click(screen.getByText('the 14th'));
    expect(onOptionClick).toHaveBeenCalledWith('the 14th');
  });

  it('renders object widget options (SendMessageTool schema) and sends value', () => {
    const onOptionClick = vi.fn();
    render(
      <BotSendCard
        message={cardMessage({
          msgType: 'widget',
          content: '',
          sendMessageMeta: {
            widget: {
              prompt: 'Deploy to production?',
              options: [
                { label: 'Deploy', value: 'Yes, deploy now', style: 'primary' },
                { label: 'Cancel', value: 'No, hold off', description: 'keep it running' },
                { label: 'Later' }, // value defaults to label
              ],
            },
          },
        })}
        onOptionClick={onOptionClick}
      />,
    );
    const cancel = screen.getByText('Cancel');
    expect(cancel.getAttribute('title')).toBe('keep it running');
    fireEvent.click(cancel);
    expect(onOptionClick).toHaveBeenCalledWith('No, hold off');
    fireEvent.click(screen.getByText('Later'));
    expect(onOptionClick).toHaveBeenCalledWith('Later');
  });

  it('renders cursor-agent badge with bcId', () => {
    render(
      <BotSendCard
        message={cardMessage({
          msgType: 'cursor-agent',
          content: 'run started',
          sendMessageMeta: { bcId: 'bc-abcdef1234567890' },
        })}
      />,
    );
    expect(screen.getByText('Cursor Agent')).toBeDefined();
    expect(screen.getByText('bc-abcdef123')).toBeDefined(); // truncated to 12 chars
  });

  it('renders secret-request descriptor without any input field', () => {
    render(
      <BotSendCard
        message={cardMessage({
          msgType: 'secret-request',
          content: 'need a token',
          sendMessageMeta: {
            secret: { label: 'Slack token', connector: 'slack', field: 'bot_token' },
          },
        })}
      />,
    );
    expect(screen.getByText('Slack token')).toBeDefined();
    expect(screen.getByText('slack / bot_token')).toBeDefined();
    // Minimal scope: no credential input in the card yet.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByDisplayValue(/slack/i)).toBeNull();
  });

  it('renders caption only for text kind with images (images split into standalone bubbles)', () => {
    render(
      <BotSendCard
        message={cardMessage({
          msgType: 'text',
          content: 'look at this',
          sendMessageMeta: { images: [{ url: 'file:///tmp/a.png', alt: 'chart' }] },
        })}
      />,
    );
    // The image is NOT embedded in the card — BotSendCard renders just the text;
    // BotDirectChatView splits image(s) into their own standalone bubbles.
    expect(screen.getByText('look at this')).toBeDefined();
    expect(screen.queryByAltText('chart')).toBeNull();
  });

  it('renders an attachment that points at an image as a borderless preview', () => {
    render(
      <BotSendCard
        message={cardMessage({
          content: 'see attached',
          sendMessageMeta: { url: 'file:///tmp/shot.png', alt: 'shot' },
        })}
      />,
    );
    // `file://` images are proxied through the app's `duya-file://` protocol.
    const img = screen.getByAltText('shot');
    expect(img?.getAttribute('src')).toBe('duya-file:///tmp/shot.png');
  });

  it('BotSendImageView opens a lightbox on click', () => {
    render(
      <BotSendImageView image={{ url: 'https://example.com/a.png', alt: 'pic' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'pic' }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});
