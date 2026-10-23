/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { DiffStatBadge } from './DiffStatBadge';

describe('DiffStatBadge', () => {
  it('shows both numbers, including a zero removal count', () => {
    // The reference transcripts read "+28 -0" — a zero removal count
    // still tells the reader the file was touched without losing a
    // line, so the badge never drops a side.
    const { container } = render(<DiffStatBadge additions={28} removals={0} />);
    expect(container.querySelector('[data-testid="diff-stat"]')?.textContent).toBe('+28-0');
  });

  it('shows the removal count next to the additions', () => {
    const { container } = render(<DiffStatBadge additions={1} removals={1} />);
    expect(container.querySelector('[data-testid="diff-stat"]')?.textContent).toBe('+1-1');
  });

  it('renders nothing when the group changed no line at all', () => {
    const { container } = render(<DiffStatBadge additions={0} removals={0} />);
    expect(container.querySelector('[data-testid="diff-stat"]')).toBeNull();
  });
});
