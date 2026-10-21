import type { ReactElement } from 'react';

/**
 * The product mark, drawn as inline SVG so the page can render without any
 * external asset.
 *
 * The shape is a green seal the way a Chinese document carries one: a square
 * stamp with a small margin and a single character of body type. There is no
 * animation, no gradient, nothing that depends on a font the browser does not
 * already have.
 */
export function BrandMark(): ReactElement {
  return (
    <svg className="topbar__mark" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="1.5" y="1.5" width="19" height="19" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 7.5 L6.5 14.5 M6.5 11 L10.5 11 M10.5 7.5 L15.5 7.5 M10.5 11 L15.5 11 M10.5 14.5 L15.5 14.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

