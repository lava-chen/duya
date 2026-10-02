// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/icons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/icons')>()),
  XIcon: () => null,
}));

// Providers come from the preload IPC bridge, absent in jsdom — stub it with
// a keyed provider exposing one enabled model.
vi.mock('@/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-client')>();
  return {
    ...actual,
    listProvidersIPC: () =>
      Promise.resolve([
        {
          id: 'zhipu',
          name: 'Zhipu',
          providerType: 'openai',
          baseUrl: '',
          apiKey: '',
          hasApiKey: true,
          options: JSON.stringify({ enabled_models: ['glm-4'] }),
        },
      ]),
  };
});

const createAgent = vi.fn();
const updateAgent = vi.fn();
const updateIdentity = vi.fn();
vi.mock('@/lib/agent-profile-ipc', () => ({
  createConfigAgent: (...args: unknown[]) => createAgent(...args),
  updateConfigAgent: (...args: unknown[]) => updateAgent(...args),
  updateBotIdentity: (...args: unknown[]) => updateIdentity(...args),
}));

import { EditBotDialog } from '../EditBotDialog';
import type { BotContact } from '../sidebar/bot-contacts';

const contact: BotContact = {
  agentId: 'test1',
  name: '测试 Bot',
  title: '',
  description: '',
  model: 'glm-4',
  provider: 'zhipu',
  avatarColor: 'blue',
  boundThreadId: 'bot:test1:abc',
  lastActivity: 0,
};

beforeEach(() => {
  createAgent.mockReset().mockResolvedValue({ id: 'my-bot' });
  updateAgent.mockReset().mockResolvedValue(undefined);
  updateIdentity.mockReset().mockResolvedValue(undefined);
});

describe('EditBotDialog model selection', () => {
  it('prefills the configured model and saves it with its provider', async () => {
    render(
      <EditBotDialog isOpen contact={contact} onCancel={() => {}} onSaved={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('glm-4')).toBeDefined());
    fireEvent.click(screen.getByText('bot.edit.save'));
    await waitFor(() => {
      expect(updateIdentity).toHaveBeenCalledTimes(1);
      expect(updateAgent).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ model: 'glm-4', provider: 'zhipu' }),
      );
    });
  });

  it('preserves a configured model not exposed by any provider', async () => {
    const stale = { ...contact, model: 'legacy-model', provider: undefined };
    render(
      <EditBotDialog isOpen contact={stale} onCancel={() => {}} onSaved={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('legacy-model')).toBeDefined());
    fireEvent.click(screen.getByText('bot.edit.save'));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ model: 'legacy-model' }),
      ),
    );
  });

  it('clearing the selection saves model undefined', async () => {
    render(
      <EditBotDialog isOpen contact={contact} onCancel={() => {}} onSaved={() => {}} />,
    );
    // Wait for the model groups to load, then open the menu and clear.
    await waitFor(() => expect(screen.getByText('glm-4')).toBeDefined());
    fireEvent.click(screen.getByText('glm-4').closest('button') as HTMLButtonElement);
    // Both the trigger and the clear row carry the label; the clear row is
    // the one rendered inside the portal menu (role=option).
    const clearRow = await screen.findByRole('option', { name: 'bot.create.modelDefault' });
    fireEvent.click(clearRow);
    fireEvent.click(screen.getByText('bot.edit.save'));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ model: undefined, provider: undefined }),
      ),
    );
  });
});
