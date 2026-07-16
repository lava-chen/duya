// @vitest-environment jsdom

import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlashCommandPopover } from './SlashCommandPopover';
import type { PopoverItem } from '@/types/slash-command';

const recapItem: PopoverItem = {
  label: '回顾对话',
  value: '/recap',
  description: '总结当前对话',
  kind: 'settings_action',
  group: 'settings',
};

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
