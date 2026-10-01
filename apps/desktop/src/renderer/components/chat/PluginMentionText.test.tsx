// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PluginMentionText } from './PluginMentionChip';
import type { PluginMentionTarget } from '@/lib/message-input-logic';

const targets: PluginMentionTarget[] = [
  { pluginId: 'wechat-pay', name: 'WeChat Pay', iconUrl: 'duya-file:///icons/wechat.svg' },
];

describe('PluginMentionText', () => {
  it('renders plain text unchanged when there is no mention', () => {
    const { container } = render(<PluginMentionText text="just text" targets={targets} />);
    expect(container.textContent).toBe('just text');
    expect(container.querySelector('[data-plugin-mention]')).toBeNull();
  });

  it('renders a mention as an icon + blue code-font name chip', () => {
    const { container } = render(<PluginMentionText text="use @wechat-pay now" targets={targets} />);
    expect(container.textContent).toBe('use WeChat Pay now');

    const chip = container.querySelector<HTMLElement>('[data-plugin-mention="wechat-pay"]');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe('duya-file:///icons/wechat.svg');

    const label = chip?.querySelector('span');
    expect(label?.textContent).toBe('WeChat Pay');
    expect(label?.style.fontFamily).toContain('Fira Mono');
    expect(label?.style.color.replace(/\s/g, '')).toMatch(/3b82f6|rgb\(59,130,246\)/);
  });

  it('renders the structured link form as a chip', () => {
    const { container } = render(
      <PluginMentionText text="ask [@WeChat Pay](plugin://wechat-pay)" targets={targets} />,
    );
    expect(container.querySelector('[data-plugin-mention="wechat-pay"]')).not.toBeNull();
    expect(container.textContent).toBe('ask WeChat Pay');
  });

  it('leaves bubble text selectable (no composer-only userSelect lock)', () => {
    const { container } = render(<PluginMentionText text="@wechat-pay" targets={targets} />);
    const chip = container.querySelector<HTMLElement>('[data-plugin-mention="wechat-pay"]');
    expect(chip?.style.userSelect).not.toBe('none');
  });
});
