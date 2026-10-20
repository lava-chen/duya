// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/lib/agent-profile-ipc', () => ({
  listBots: () => listBotsMock(),
  updateBotIdentity: (...args: unknown[]) => updateIdentity(...args),
  updateConfigAgent: (...args: unknown[]) => updateConfig(...args),
}));

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
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
}));

vi.mock('@/lib/bot-channels-ipc', () => ({
  listBotChannelManifests: () => Promise.resolve([]),
  listBotChannels: () => Promise.resolve([]),
  connectBotChannel: vi.fn(),
  disconnectBotChannel: vi.fn(),
}));

vi.mock('../BotRoutinesSection', () => ({
  BotRoutinesSection: () => <div data-testid="routines-section" />,
}));

import { BotSettingsPanel } from '../BotSettingsPanel';
import type { BotListItem } from '@/lib/agent-profile-ipc';

const listBotsMock = vi.fn();
const updateIdentity = vi.fn();
const updateConfig = vi.fn();

const botItem: BotListItem = {
  id: 'test1',
  name: '测试 Bot',
  title: '',
  description: '旧的描述',
  model: 'glm-4',
  provider: 'zhipu',
  avatarColor: 'blue',
};

function renderPanel() {
  return render(
    <BotSettingsPanel
      tab={{ id: 'bot-settings', title: 'Bot 设置', params: { agentId: 'test1' } } as never}
      embedded
    />,
  );
}

beforeEach(() => {
  listBotsMock.mockReset().mockResolvedValue([botItem]);
  updateIdentity.mockReset().mockResolvedValue(undefined);
  updateConfig.mockReset().mockResolvedValue(undefined);
});

describe('BotSettingsPanel two-view layout', () => {
  it('landing view shows channels + routines and the gear entry, not the identity form', async () => {
    const { container } = renderPanel();
    await screen.findByTestId('routines-section');
    expect(screen.getByLabelText('panel.botSettings.identity')).toBeDefined();
    expect(screen.queryByText('bot.create.name')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('gear opens the identity sub-view; back returns to the landing view', async () => {
    renderPanel();
    await screen.findByTestId('routines-section');
    fireEvent.click(screen.getByLabelText('panel.botSettings.identity'));
    expect(await screen.findByText('bot.create.name')).toBeDefined();
    expect(screen.queryByTestId('routines-section')).toBeNull();
    fireEvent.click(screen.getByText('common.back'));
    await screen.findByTestId('routines-section');
  });

  it('identity edits persist live without a save button', async () => {
    renderPanel();
    await screen.findByTestId('routines-section');
    fireEvent.click(screen.getByLabelText('panel.botSettings.identity'));
    const nameInput = (await screen.findByText('bot.create.name').then(() =>
      screen.getByPlaceholderText('bot.create.namePlaceholder'),
    )) as HTMLInputElement;
    expect(nameInput.value).toBe('测试 Bot');
    expect(screen.queryByText('bot.edit.save')).toBeNull();

    fireEvent.change(nameInput, { target: { value: '新名字' } });
    await waitFor(
      () => expect(updateIdentity).toHaveBeenCalled(),
      { timeout: 2000 },
    );
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith(
        'test1',
        expect.objectContaining({ name: '新名字', model: 'glm-4', provider: 'zhipu' }),
      ),
    );
    expect(updateIdentity).toHaveBeenCalledWith(
      'test1',
      expect.objectContaining({ name: '新名字', description: '旧的描述', avatarColor: 'blue' }),
    );
  });

  it('skips the live write while fields mirror the loaded contact', async () => {
    renderPanel();
    await screen.findByTestId('routines-section');
    fireEvent.click(screen.getByLabelText('panel.botSettings.identity'));
    await screen.findByPlaceholderText('bot.create.namePlaceholder');
    await new Promise((r) => setTimeout(r, 750));
    expect(updateIdentity).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
