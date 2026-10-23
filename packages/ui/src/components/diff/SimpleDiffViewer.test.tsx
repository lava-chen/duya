/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SimpleDiffViewer } from './SimpleDiffViewer';

describe('SimpleDiffViewer', () => {
  it('renders plain text when no language is given', () => {
    const { container } = render(
      <SimpleDiffViewer oldContent="const a = 1;" newContent="const a = 2;" />,
    );
    expect(container.querySelector('.diff-syn-keyword')).toBeNull();
    expect(container.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('const a = 2;');
  });

  it('highlights the changed lines when a language is given', () => {
    const { container } = render(
      <SimpleDiffViewer
        oldContent="const a = 1;"
        newContent="const a = 2;"
        language="typescript"
      />,
    );
    expect(container.querySelectorAll('.diff-syn-keyword').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('const a = 2;');
  });

  it('takes the removed line from the old source and the added line from the new one', () => {
    const { container } = render(
      <SimpleDiffViewer
        oldContent={'const a = 1;\nconst b = 2;'}
        newContent={'const b = 2;\nconst c = 3;'}
        language="typescript"
      />,
    );
    // The old source line belongs to the removal, the new one to the addition.
    // Mixing them up would swap these two strings.
    expect(container.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('const c = 3;');
    expect(container.textContent).not.toContain('const b = 2;');
  });

  it('falls back to plain text for an unknown language', () => {
    const { container } = render(
      <SimpleDiffViewer
        oldContent="const a = 1;"
        newContent="const a = 2;"
        language="not-a-real-language"
      />,
    );
    expect(container.querySelector('.diff-syn-keyword')).toBeNull();
    expect(container.textContent).toContain('const a = 1;');
  });
});
