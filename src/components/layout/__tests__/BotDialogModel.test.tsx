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

import { CreateBotDialog } from '../CreateBotDialog';
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

/**
 * Open the model menu and pick a model row. The selector opens in two levels:
 * the root menu lists providers, clicking one opens the model flyout.
 */
async function pickModel(rawModel: string, providerName: string) {
  // The trigger shows the clear option label while nothing is picked.
  const trigger = await waitFor(() => {
    const el = screen.getByText('bot.create.modelDefault').closest('button');
    expect(el).not.toBeNull();
    expect((el as HTMLButtonElement).disabled).toBe(false);
    return el as HTMLButtonElement;
  });
  fireEvent.click(trigger);
  // Root menu → provider row → flyout with models.
  fireEvent.click(await screen.findByText(providerName));
  fireEvent.click(await screen.findByText(rawModel));
}

beforeEach(() => {
  createAgent.mockReset().mockResolvedValue({ id: 'my-bot' });
  updateAgent.mockReset().mockResolvedValue(undefined);
  updateIdentity.mockReset().mockResolvedValue(undefined);
});

describe('CreateBotDialog model selection', () => {
  it('renders the model field with the default option and the provider menu', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} />,
    );
    expect(screen.getByText('bot.create.model')).toBeDefined();
    // While providers load the trigger shows a spinner; the default label
    // appears once loading settles.
    await screen.findByText('bot.create.modelDefault');
    await pickModel('glm-4', 'Zhipu');
  });

  it('passes the picked raw model + provider to createConfigAgent', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} />,
    );
    await pickModel('glm-4', 'Zhipu');
    fireEvent.change(screen.getByPlaceholderText('bot.create.namePlaceholder'), {
      target: { value: 'My Bot' },
    });
    fireEvent.click(screen.getByText('bot.create.create'));
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        'my-bot',
        expect.objectContaining({ model: 'glm-4', provider: 'zhipu' }),
      ),
    );
  });

  it('leaves model unset when nothing is picked', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} />,
    );
    await waitFor(() => {
      const el = screen.getByText('bot.create.modelDefault').closest('button');
      expect((el as HTMLButtonElement | null)?.disabled).toBe(false);
    });
    fireEvent.change(screen.getByPlaceholderText('bot.create.namePlaceholder'), {
      target: { value: 'My Bot' },
    });
    fireEvent.click(screen.getByText('bot.create.create'));
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        'my-bot',
        expect.objectContaining({ model: undefined }),
      ),
    );
  });
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
