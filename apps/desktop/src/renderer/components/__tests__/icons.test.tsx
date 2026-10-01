/**
 * icons.test.tsx — guards the icon wrapper contracts.
 *
 * Two regressions this file exists to prevent:
 *  1. `stroke` on a lucide icon is the SVG *color* attribute, not the line
 *     weight. Passing a width there silently killed `currentColor`, so icons
 *     kept the light-theme color on dark themes. Weight must land in
 *     `stroke-width`.
 *  2. Semantic aliases drifting into the wrong glyph (e.g. SearchIcon
 *     resolving to a chat bubble instead of a magnifier).
 *
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ChatCircleIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  SearchIcon,
} from '@/components/icons';

function renderSvg(element: React.ReactElement): SVGSVGElement {
  const { container } = render(element);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('icon did not render an svg');
  return svg as SVGSVGElement;
}

function glyphOf(element: React.ReactElement): string {
  return renderSvg(element).innerHTML;
}

describe('icon wrapper — stroke/color contract', () => {
  it('keeps currentColor on the lucide wrapper', () => {
    const svg = renderSvg(<SearchIcon size={16} />);
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });

  it('maps the stroke prop onto stroke-width, not onto stroke', () => {
    const svg = renderSvg(<SearchIcon size={16} stroke={2.5} />);
    expect(svg.getAttribute('stroke-width')).toBe('2.5');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });

  it('defaults the line weight to 1.25', () => {
    const svg = renderSvg(<SearchIcon size={16} />);
    expect(svg.getAttribute('stroke-width')).toBe('1.25');
  });

  it('keeps currentColor on the tabler wrapper too', () => {
    const svg = renderSvg(<ChatCircleIcon size={16} />);
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });

  it('accepts strokeWidth as a line-weight alias on tabler icons', () => {
    const svg = renderSvg(<ChatCircleIcon size={16} strokeWidth={2.5} />);
    expect(svg.getAttribute('stroke-width')).toBe('2.5');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('icon semantics', () => {
  it('SearchIcon renders a magnifier, not a chat bubble', () => {
    expect(glyphOf(<SearchIcon size={16} />)).toBe(
      glyphOf(<MagnifyingGlassIcon size={16} />),
    );
    expect(glyphOf(<SearchIcon size={16} />)).not.toBe(
      glyphOf(<ChatCircleIcon size={16} />),
    );
  });

  it('NotePencilIcon is a distinct edit glyph', () => {
    expect(glyphOf(<NotePencilIcon size={16} />)).not.toBe(
      glyphOf(<ChatCircleIcon size={16} />),
    );
  });
});
