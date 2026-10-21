// @vitest-environment jsdom

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandPopover } from './SlashCommandPopover';
import type { PopoverItem } from '@/types/slash-command';

afterEach(cleanup);

const recapItem: PopoverItem = {
  label: '回顾对话',
  value: '/recap',
  description: '总结当前对话',
  kind: 'settings_action',
  group: 'settings',
};

const mcpSubmenuItem: PopoverItem = {
  label: 'MCP',
  value: '/mcp',
  description: 'MCP servers',
  kind: 'settings_submenu',
  group: 'settings',
  submenu: 'mcp',
};

const mcpServers = [
  {
    name: 'test-server',
    description: 'npx -y @modelcontextprotocol/server-test',
    enabled: true,
    writable: true,
    connectionStatus: 'connected' as const,
    toolCount: 2,
    tools: [
      { name: 'read_tool', description: 'Read something' },
      { name: 'write_tool', description: 'Write something', annotations: { destructive: true } },
    ],
  },
  {
    name: 'broken-server',
    enabled: true,
    writable: true,
    connectionStatus: 'error' as const,
    lastIssue: { phase: 'connection' as const, humanMessage: 'Connection closed', severity: 'critical' as const },
  },
];

describe('SlashCommandPopover recap', () => {
  it('keeps the menu open and renders the generated recap in its sub-view', async () => {
    const onRequestRecap = vi.fn().mockResolvedValue({
      success: true,
      recap: '你正在修复技能选择后的输入框交互。',
    });

    render(
      <SlashCommandPopover
        popoverMode="skill"
        popoverRef={createRef<HTMLDivElement>()}
        filteredItems={[recapItem]}
        selectedIndex={0}
        popoverFilter=""
        inputValue=""
        triggerPos={null}
        searchInputRef={createRef<HTMLInputElement>()}
        allDisplayedItems={[recapItem]}
        thinkingEffort={null}
        onSelectThinkingEffort={() => {}}
        responseStyles={[]}
        selectedStyle={null}
        onSelectStyle={() => {}}
        mcpServers={[]}
        onToggleMcpServer={() => {}}
        onAddFiles={() => {}}
        onRequestRecap={onRequestRecap}
        activeModes={new Set()}
        onToggleMode={() => {}}
        onInsertItem={() => {}}
        onSetSelectedIndex={() => {}}
        onSetPopoverFilter={() => {}}
        onSetInputValue={() => {}}
        onClosePopover={() => {}}
        onFocusTextarea={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('回顾对话'));

    expect(onRequestRecap).toHaveBeenCalledOnce();
    expect(await screen.findByText('你正在修复技能选择后的输入框交互。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新生成回顾' })).toBeInTheDocument();
  });
});

describe('SlashCommandPopover mcp sub-view', () => {
  function renderMcp() {
    const onReloadMcp = vi.fn();
    const onToggleMcpServer = vi.fn();
    render(
      <SlashCommandPopover
        popoverMode="context"
        popoverRef={createRef<HTMLDivElement>()}
        filteredItems={[mcpSubmenuItem]}
        selectedIndex={0}
        popoverFilter=""
        inputValue=""
        triggerPos={null}
        searchInputRef={createRef<HTMLInputElement>()}
        allDisplayedItems={[mcpSubmenuItem]}
        thinkingEffort={null}
        onSelectThinkingEffort={() => {}}
        responseStyles={[]}
        selectedStyle={null}
        onSelectStyle={() => {}}
        mcpServers={mcpServers}
        onToggleMcpServer={onToggleMcpServer}
        onReloadMcp={onReloadMcp}
        onAddFiles={() => {}}
        onRequestRecap={() => Promise.resolve({ success: true, recap: null })}
        activeModes={new Set()}
        onToggleMode={() => {}}
        onInsertItem={() => {}}
        onSetSelectedIndex={() => {}}
        onSetPopoverFilter={() => {}}
        onSetInputValue={() => {}}
        onClosePopover={() => {}}
        onFocusTextarea={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('option'));
    return { onReloadMcp, onToggleMcpServer };
  }

  it('shows a reconnect button that triggers onReloadMcp', () => {
    const { onReloadMcp } = renderMcp();
    const reconnect = screen.getByRole('button', { name: 'Reconnect MCP servers' });
    fireEvent.click(reconnect);
    expect(onReloadMcp).toHaveBeenCalledOnce();
  });

  it('surfaces an error message for failed servers', () => {
    renderMcp();
    expect(screen.getByText('Connection closed')).toBeInTheDocument();
  });

  it('expands a server row to list its tools and annotation badges', async () => {
    renderMcp();
    // Row content is not yet expanded.
    expect(screen.queryByText('read_tool')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('test-server'));
    expect(await screen.findByText('read_tool')).toBeInTheDocument();
    expect(screen.getByText('write_tool')).toBeInTheDocument();
    expect(screen.getByText('destructive')).toBeInTheDocument();
  });
});
