// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  setConfig: vi.fn(),
  ragRebuildMemoryIPC: vi.fn(),
  providers: [] as { id: string; name: string; sortOrder: number }[],
}));

vi.mock('@/lib/config-port-bus', () => ({
  getConfigValue: mocks.getConfigValue,
  setConfig: mocks.setConfig,
}));

vi.mock('@/lib/ipc-client', () => ({
  ragRebuildMemoryIPC: mocks.ragRebuildMemoryIPC,
}));

vi.mock('@/lib/providers/hooks/useProvidersQuery', () => ({
  useProvidersQuery: () => ({ data: mocks.providers }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Stub the settings UI primitives (SettingsSelectRow pulls in `antd`).
vi.mock('@/components/settings/ui', () => ({
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsToggle: ({
    label,
    checked,
    onCheckedChange,
    disabled,
  }: {
    label: string;
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
      {label}
    </label>
  ),
  SettingsSelectRow: ({
    value,
    onValueChange,
    options,
    disabled,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    options: { value: string; label: string }[];
    disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  SettingsInputRow: ({
    value,
    onChange,
    onBlur,
    placeholder,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <input
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  ),
}));

vi.mock('antd', () => ({ Select: () => null }));

const fixture = {
  enabled: true,
  index_path: '',
  scan_paths: ['~/notes'],
  embedding_enabled: true,
  embedding_provider: '',
  embedding_model: '',
};

describe('MemoryRagCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigValue.mockResolvedValue({ ...fixture });
    mocks.providers = [
      { id: 'ollama', name: 'Ollama', sortOrder: 1 },
      { id: 'openai', name: 'OpenAI', sortOrder: 2 },
    ];
  });

  it('renders the current config after load (toggle, paths, provider options)', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);

    expect(await screen.findByLabelText('settings.memory.ragEnabled')).toBeChecked();
    expect(screen.getByText('~/notes')).toBeInTheDocument();

    // Provider options are inline: the card has no collapsed "advanced"
    // disclosure (that toggle and its orphaned i18n keys are gone).
    expect(screen.getByText('Ollama')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
  });

  it('toggling enable writes the whole memoryRag object', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    const toggle = await screen.findByLabelText('settings.memory.ragEnabled');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith('memoryRag', expect.objectContaining({ enabled: false }));
    });
  });

  it('adds a scan path (dedup) and writes scan_paths', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    const addInput = screen.getByPlaceholderText('settings.memory.ragAddPath');
    fireEvent.change(addInput, { target: { value: 'E:/Projects/duya/docs' } });
    fireEvent.click(screen.getByText('common.add'));

    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith(
        'memoryRag',
        expect.objectContaining({ scan_paths: ['~/notes', 'E:/Projects/duya/docs'] }),
      );
    });
    expect(screen.getByText('E:/Projects/duya/docs')).toBeInTheDocument();
  });

  it('rejects a duplicate scan path', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    const addInput = screen.getByPlaceholderText('settings.memory.ragAddPath');
    fireEvent.change(addInput, { target: { value: '~/notes' } });
    fireEvent.click(screen.getByText('common.add'));

    expect(await screen.findByText('settings.memory.ragPathExists')).toBeInTheDocument();
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it('removes a scan path', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    fireEvent.click(screen.getByText('common.remove'));
    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith('memoryRag', expect.objectContaining({ scan_paths: [] }));
    });
  });

  // The native folder picker (`settings.memory.ragBrowse` + electronAPI
  // dialog.openFolder) was removed: scan paths are typed into the add input
  // and committed with the Add button, which "adds a scan path" above covers.
  // What still matters is that the card has no native-dialog dependency at
  // all, so a headless renderer can never hang on a picker.
  it('adds a path without any native folder dialog', async () => {
    const openFolder = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { dialog: { openFolder } };

    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    // No browse affordance is rendered any more.
    expect(screen.queryByRole('button', { name: 'settings.memory.ragBrowse' })).toBeNull();
    expect(screen.queryByRole('button', { name: /settings.memory.ragAdvanced/ })).toBeNull();

    const addInput = screen.getByPlaceholderText('settings.memory.ragAddPath');
    fireEvent.change(addInput, { target: { value: 'D:/archives' } });
    fireEvent.click(screen.getByText('common.add'));

    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith(
        'memoryRag',
        expect.objectContaining({ scan_paths: ['~/notes', 'D:/archives'] }),
      );
    });
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('changing the provider writes embedding_provider', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'ollama' } });
    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith('memoryRag', expect.objectContaining({ embedding_provider: 'ollama' }));
    });
  });

  it('blurring the model input writes embedding_model', async () => {
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    await screen.findByLabelText('settings.memory.ragEnabled');

    const modelInput = screen.getByPlaceholderText('bge-m3 / text-embedding-3-small');
    fireEvent.change(modelInput, { target: { value: 'bge-m3' } });
    fireEvent.blur(modelInput);
    await waitFor(() => {
      expect(mocks.setConfig).toHaveBeenCalledWith('memoryRag', expect.objectContaining({ embedding_model: 'bge-m3' }));
    });
  });

  it('rebuild button triggers the IPC and shows the result', async () => {
    mocks.getConfigValue.mockResolvedValue({
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: true,
      embedding_provider: '',
      embedding_model: '',
    });
    mocks.ragRebuildMemoryIPC.mockResolvedValue({
      ok: true,
      documents: 12,
      embedded: 9,
      scanRoots: ['/tmp/mem'],
      durationMs: 40,
    });
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    const button = await screen.findByRole('button', { name: 'settings.memory.ragRebuild' });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.ragRebuildMemoryIPC).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/settings\.memory\.ragRebuildDone/)).toBeTruthy(),
    );
  });

  it('rebuild button shows the error when the IPC fails', async () => {
    mocks.getConfigValue.mockResolvedValue({
      enabled: true,
      index_path: '',
      scan_paths: [],
      embedding_enabled: true,
      embedding_provider: '',
      embedding_model: '',
    });
    mocks.ragRebuildMemoryIPC.mockResolvedValue({ ok: false, error: 'boom' });
    const { MemoryRagCard } = await import('../MemoryRagCard');
    render(<MemoryRagCard />);
    const button = await screen.findByRole('button', { name: 'settings.memory.ragRebuild' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
