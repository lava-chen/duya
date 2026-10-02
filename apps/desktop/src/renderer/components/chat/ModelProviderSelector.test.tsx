// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelProviderSelector } from './ModelProviderSelector';
import type { ProviderModelGroup } from './ModelProviderSelector';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'messageInput.selectModel': '选择模型',
        'messageInput.provider': '服务商',
        'messageInput.model': '模型',
        'messageInput.effort': '推理力度',
        'messageInput.manageProviders': '管理服务商',
        'messageInput.effortAuto': '自动',
        'messageInput.noModelsAvailable': '暂无可用模型',
      })[key] ?? key,
  }),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: () => ({
    setCurrentView: () => {},
    setSettingsTab: () => {},
  }),
}));

const groups: ProviderModelGroup[] = [
  {
    id: 'p1',
    name: 'Anthropic',
    models: [
      { id: '[Anthropic] claude-sonnet', display_name: 'claude-sonnet' },
      { id: '[Anthropic] claude-opus', display_name: 'claude-opus' },
    ],
  },
  {
    id: 'p2',
    name: 'OpenAI',
    models: [
      { id: '[OpenAI] gpt-4o', display_name: 'gpt-4o' },
      { id: '[OpenAI] gpt-4-turbo', display_name: 'gpt-4-turbo' },
    ],
  },
];

const effortOptions = [
  { value: '', label: 'Auto' },
  { value: 'high', label: 'High' },
];

function setup(overrides?: Partial<React.ComponentProps<typeof ModelProviderSelector>>) {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  render(
    <ModelProviderSelector
      providerGroups={groups}
      selectedModelId="[Anthropic] claude-sonnet"
      onSelectModel={onSelectModel}
      effortValue=""
      effortOptions={effortOptions}
      onSelectEffort={onSelectEffort}
      {...overrides}
    />,
  );
  return { onSelectModel, onSelectEffort };
}

describe('ModelProviderSelector', () => {
  it('renders trigger showing "<model> <effort>"', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /claude-sonnet/ });
    expect(trigger.textContent).toMatch(/claude-sonnet/);
    expect(trigger.textContent).toMatch(/Auto/);
  });

  it('opens root menu listing providers directly plus Effort / Manage rows', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet/ }));
    // All providers are listed in the first-level menu.
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    // Thinking + Manage rows remain at the bottom.
    expect(screen.getByText('推理力度')).toBeInTheDocument();
    expect(screen.getByText('管理服务商')).toBeInTheDocument();
    // The separate "Model" row is gone — models live in the provider flyout.
    expect(screen.queryByText('模型')).not.toBeInTheDocument();
  });

  it('clicking a provider opens a side flyout with its models; selecting applies it', () => {
    const { onSelectModel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet/ }));
    // Root stays visible while the OpenAI flyout shows its models.
    fireEvent.click(screen.getByText('OpenAI'));
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('gpt-4-turbo')).toBeInTheDocument();
    // Anthropic's models are not in the OpenAI flyout.
    expect(screen.queryByText('claude-opus')).not.toBeInTheDocument();
    // Selecting a model applies it with the matching provider id.
    fireEvent.click(screen.getByText('gpt-4-turbo'));
    expect(onSelectModel).toHaveBeenCalledWith('[OpenAI] gpt-4-turbo', 'p2');
  });

  it('Effort row opens an effort flyout and selects the option', () => {
    const { onSelectEffort } = setup({ effortValue: '' });
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet/ }));
    fireEvent.click(screen.getByText('推理力度'));
    fireEvent.click(screen.getByText('High'));
    expect(onSelectEffort).toHaveBeenCalledWith('high');
  });

  it('portal mode: menu rows survive the mousedown that precedes a real click', () => {
    const { onSelectModel } = setup({ portal: true });
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet/ }));
    const providerRow = screen.getByText('OpenAI');
    // Real browsers fire mousedown before click; the outside-click guard
    // must not tear the portal menu down between the two.
    fireEvent.mouseDown(providerRow);
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    fireEvent.click(providerRow);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    const modelRow = screen.getByText('gpt-4-turbo');
    fireEvent.mouseDown(modelRow);
    fireEvent.click(modelRow);
    expect(onSelectModel).toHaveBeenCalledWith('[OpenAI] gpt-4-turbo', 'p2');
  });

  it('clearOption renders a clear row and reports an empty selection', () => {
    const { onSelectModel } = setup({ clearOption: '跟随全局默认' });
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet/ }));
    fireEvent.click(screen.getByText('跟随全局默认'));
    expect(onSelectModel).toHaveBeenCalledWith('');
  });

  it('empty effortOptions hide the effort surface', () => {
    setup({ effortOptions: [] });
    const trigger = screen.getByRole('button', { name: /claude-sonnet/ });
    expect(trigger.textContent).not.toMatch(/Auto/);
    fireEvent.click(trigger);
    expect(screen.queryByText('推理力度')).not.toBeInTheDocument();
  });
});
