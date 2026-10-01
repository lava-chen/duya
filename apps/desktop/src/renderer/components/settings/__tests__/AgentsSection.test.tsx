// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Stable settings object. AgentsSection has an effect keyed on
// `settings.favoriteAgentIds`; if the mock returned a fresh array on every
// render, that effect would re-run forever (infinite render loop → OOM).
const mocks = vi.hoisted(() => ({
  settings: { favoriteAgentIds: [] as string[], agentLanguage: '' },
}));

// Mock settings hook.
vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: mocks.settings,
    save: vi.fn().mockResolvedValue(undefined),
    loading: false,
    saving: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock translation so tests can match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock output-styles IPC so the Output Styles section doesn't hit real IPC.
vi.mock('@/lib/ipc-client', () => ({
  listOutputStylesIPC: vi.fn().mockResolvedValue([]),
  upsertOutputStyleIPC: vi.fn().mockResolvedValue(undefined),
  deleteOutputStyleIPC: vi.fn().mockResolvedValue(undefined),
  getAllSettingsIPC: vi.fn().mockResolvedValue({}),
}));

// Mock AgentModeSelector: it pulls in framer-motion which is heavy and can
// exhaust the JS heap during module transform in this test environment.
vi.mock('@/components/chat/AgentModeSelector', () => ({
  AGENT_ICON_MAP: {},
  FALLBACK_AGENT_ICON: () => null,
}));

// Mock the icons barrel: it re-exports a huge set from @tabler/icons-react
// which exhausts the JS heap during module transform here.
vi.mock('@/components/icons', () => {
  const stub = () => null;
  return {
    SpinnerGapIcon: stub,
    XIcon: stub,
    CheckCircleIcon: stub,
    PlusIcon: stub,
    TrashIcon: stub,
    NotePencilIcon: stub,
    CheckIcon: stub,
    FeatherIcon: stub,
    RobotIcon: stub,
  };
});

// Mock the settings UI primitives: SettingsSelectRow pulls in `antd` (via
// SettingsSelect), whose huge module graph exhausts the JS heap during
// transform in this environment. Stub the row with a plain <select>.
vi.mock('@/components/settings/ui', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsCardFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSelectRow: ({
    value,
    onValueChange,
    options,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

// Belt-and-suspenders: never let the real `antd` module load.
vi.mock('antd', () => ({ Select: () => null }));

const configAgentsMock = {
  list: vi.fn(),
  create: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(true),
};

describe('AgentsSection Config Agents CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configAgentsMock.list.mockResolvedValue({
      'frontend-expert': {
        name: 'Frontend Expert',
        description: 'React/TS expert',
        model: 'anthropic/claude-sonnet-4',
      },
    });
    Object.assign(globalThis.window, {
      electronAPI: {
        configAgents: configAgentsMock,
        agentProfile: {
          list: vi.fn().mockResolvedValue([]),
        },
      },
    });
  });

  it('renders the custom agent list from configAgents.list', async () => {
    const { AgentsSection } = await import('../AgentsSection');
    render(<AgentsSection />);

    await waitFor(() => {
      expect(configAgentsMock.list).toHaveBeenCalled();
    });
    expect(await screen.findByText('Frontend Expert')).toBeInTheDocument();
    expect(screen.getByText('frontend-expert')).toBeInTheDocument();
  });

  it('creates a new agent: entering a name and saving calls create with a slug id', async () => {
    const { AgentsSection } = await import('../AgentsSection');
    render(<AgentsSection />);

    // Wait for list to load, then open the create form.
    const newButton = await screen.findByText('settings.agents.configAgentsCreate');
    fireEvent.click(newButton);

    const nameInput = screen.getByPlaceholderText('settings.agents.configAgentsNamePlaceholder');
    fireEvent.change(nameInput, { target: { value: 'Frontend Expert' } });

    fireEvent.click(screen.getByText('common.save'));

    await waitFor(() => {
      expect(configAgentsMock.create).toHaveBeenCalledWith('frontend-expert', {
        name: 'Frontend Expert',
        description: undefined,
        workspace: undefined,
        model: undefined,
        agents_md: undefined,
        tools: undefined,
      });
    });
  });

  it('edit mode save calls updateConfigAgent', async () => {
    const { AgentsSection } = await import('../AgentsSection');
    render(<AgentsSection />);

    const editButton = await screen.findByLabelText('settings.agents.configAgentsEdit');
    fireEvent.click(editButton);

    const nameInput = screen.getByPlaceholderText('settings.agents.configAgentsNamePlaceholder');
    fireEvent.change(nameInput, { target: { value: 'Frontend Expert v2' } });

    fireEvent.click(screen.getByText('common.save'));

    await waitFor(() => {
      expect(configAgentsMock.update).toHaveBeenCalledWith('frontend-expert', {
        name: 'Frontend Expert v2',
        description: 'React/TS expert',
        workspace: undefined,
        model: 'anthropic/claude-sonnet-4',
        agents_md: undefined,
        tools: undefined,
      });
    });
  });

  it('delete (after confirm) calls configAgents.delete', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { AgentsSection } = await import('../AgentsSection');
    render(<AgentsSection />);

    const deleteButton = await screen.findByLabelText('settings.agents.configAgentsDelete');
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(configAgentsMock.delete).toHaveBeenCalledWith('frontend-expert');
    });
    confirmSpy.mockRestore();
  });
});