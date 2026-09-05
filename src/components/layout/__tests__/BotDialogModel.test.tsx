// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/icons', () => ({
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
  avatarShape: 'blob',
  avatarColor: 'blue',
  boundThreadId: 'bot:test1:abc',
  lastActivity: 0,
};

function modelSelect(): HTMLSelectElement {
  return screen.getByRole('combobox') as HTMLSelectElement;
}

beforeEach(() => {
  createAgent.mockReset().mockResolvedValue({ id: 'my-bot' });
  updateAgent.mockReset().mockResolvedValue(undefined);
  updateIdentity.mockReset().mockResolvedValue(undefined);
});

describe('CreateBotDialog model selection', () => {
  it('renders the provider option with the default option', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} existingIds={[]} />,
    );
    expect(screen.getByText('bot.create.model')).toBeDefined();
    expect(screen.getByText('bot.create.modelDefault')).toBeDefined();
    expect(await screen.findByText('glm-4')).toBeDefined();
  });

  it('passes the selected raw model to createConfigAgent', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} existingIds={[]} />,
    );
    await screen.findByText('glm-4');
    await waitFor(() => expect(modelSelect().disabled).toBe(false));
    fireEvent.change(modelSelect(), { target: { value: 'glm-4' } });
    fireEvent.change(screen.getByPlaceholderText('bot.create.namePlaceholder'), {
      target: { value: 'My Bot' },
    });
    fireEvent.click(screen.getByText('bot.create.create'));
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        'my-bot',
        expect.objectContaining({ model: 'glm-4' }),
      ),
    );
  });

  it('leaves model unset when nothing is picked', async () => {
    render(
      <CreateBotDialog isOpen onCancel={() => {}} onCreated={() => {}} existingIds={[]} />,
    );
    await screen.findByText('glm-4');
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
  it('prefills the configured model and saves it via updateConfigAgent', async () => {
    render(
      <EditBotDialog isOpen contact={contact} onCancel={() => {}} onSaved={() => {}} />,
    );
    await screen.findByText('glm-4');
    const select = modelSelect();
    await waitFor(() => expect(select.value).toBe('glm-4'));
    fireEvent.click(screen.getByText('bot.edit.save'));
    await waitFor(() => {
      expect(updateIdentity).toHaveBeenCalledTimes(1);
      expect(updateAgent).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ model: 'glm-4' }),
      );
    });
  });

  it('preserves a configured model not exposed by any provider', async () => {
    const stale = { ...contact, model: 'legacy-model' };
    render(
      <EditBotDialog isOpen contact={stale} onCancel={() => {}} onSaved={() => {}} />,
    );
    await screen.findByText('glm-4');
    const select = modelSelect();
    await waitFor(() => expect(select.value).toBe('legacy-model'));
    fireEvent.click(screen.getByText('bot.edit.save'));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ model: 'legacy-model' }),
      ),
    );
  });
});
