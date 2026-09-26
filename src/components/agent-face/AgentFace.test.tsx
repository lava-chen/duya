// @vitest-environment jsdom

/**
 * AgentFace.test.tsx — restoration stub contract tests.
 *
 * The props surface is fixed by the three surviving call sites
 * (BotCharacterAvatar / WorkflowGraph / stage-columns). These tests
 * pin: status→orb-state mapping, hex→palette mapping, tile geometry,
 * and className pass-through, so a future swap to the upstream
 * author's original file cannot silently change them.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentFace, nearestColorId } from './AgentFace';

describe('nearestColorId', () => {
  it('maps hexes to the exact palette id when present', () => {
    expect(nearestColorId('#7c3aed')).toBe('duya');
    expect(nearestColorId('#e8483f')).toBe('rouge');
    expect(nearestColorId('#3ecf8e')).toBe('vert');
  });

  it('snaps unknown hexes to the nearest palette entry', () => {
    expect(nearestColorId('#7c3ae0')).toBe('duya'); // brand violet ±ε
    expect(nearestColorId('#ff0000')).toBe('rouge');
    expect(nearestColorId('#000000')).toBe('encre');
  });

  it('falls back to the brand colour for non-hex input', () => {
    expect(nearestColorId('not-a-color')).toBe('duya');
    expect(nearestColorId('')).toBe('duya');
  });
});

describe('AgentFace', () => {
  it('renders a fixed superellipse tile at the requested size with className', () => {
    const { container } = render(<AgentFace size={38} color="#7c3aed" className="bot-character-avatar" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toBe('bot-character-avatar');
    expect(tile.style.width).toBe('38px');
    expect(tile.style.height).toBe('38px');
    expect(tile.style.borderRadius).toBe('38%');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the orb engine inside the tile for every status', () => {
    for (const status of [undefined, 'pending', 'running', 'done', 'failed'] as const) {
      const { container, unmount } = render(<AgentFace size={20} color="#3b93f0" status={status} />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  it('paints the tile with the paper colour so the eye sockets match', () => {
    const { container } = render(<AgentFace size={24} color="#7c3aed" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.style.background).toBe('rgb(243, 238, 255)'); // #f3eeff
  });
});
