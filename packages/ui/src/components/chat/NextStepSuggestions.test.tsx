// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextStepSuggestions } from './NextStepSuggestions';

describe('NextStepSuggestions', () => {
  it('renders one card per suggestion', () => {
    render(
      <NextStepSuggestions
        suggestions={['继续优化性能', '跑一遍测试', '补个文档']}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText('继续优化性能')).not.toBeNull();
    expect(screen.getByText('跑一遍测试')).not.toBeNull();
    expect(screen.getByText('补个文档')).not.toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('forwards the clicked suggestion text to onSelect', () => {
    const onSelect = vi.fn();
    render(
      <NextStepSuggestions suggestions={['first', 'second']} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByText('second'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('second');
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(
      <NextStepSuggestions suggestions={[]} onSelect={() => {}} />,
    );
    expect(container.firstElementChild).toBeNull();
  });
});
