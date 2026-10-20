"use client";

import type { SVGProps } from "react";
import { siCursor, siTrae, siZedindustries } from "simple-icons";

type BrandIconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Brand marks for the external IDEs detected by the file preview "Open"
 * action. Cursor, Zed and Trae use their official vector paths from
 * `simple-icons` (single-color silhouettes). VSCode is not in that
 * collection, so we hand-author a matching silhouette using the same
 * `fill="currentColor"` contract — this keeps VSCode visually aligned
 * with the other IDEs (consistent stroke weight, color comes from
 * the `color` prop / `currentColor`).
 *
 * Cursor has no single brand hue, so it follows `currentColor` to stay
 * visible on both light and dark surfaces. Trae and Zed use their
 * official hues when rendered without an explicit `color` override.
 */

// Hand-authored VSCode silhouette. Mirrors the simple-icons aesthetic
// (single-path monochrome, viewBox 24x24) so the four IDE marks feel
// like one set even though simple-icons itself does not ship a VSCode
// entry. A flat blue is applied via the `color` prop below by default
// (Microsoft's brand blue, in the same family as Tabler's old #007ACC
// but kept consistent with our other panel accents).
function VSCodeIcon({ size = 16, color = "#0066B8", ...rest }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      role="img"
      aria-label="Visual Studio Code"
      {...rest}
    >
      <path d="M23.077 6.185l-2.762-2.764a.833.833 0 0 0-1.18 0L11.46 11.16l-6.487-3.49V4.5L17.5 1.706a.42.42 0 0 0-.013-.776L1.082.014a.418.418 0 0 0-.527.413v22.84c0 .262.232.477.527.413l16.404-4.914a.42.42 0 0 0 .013-.776L4.973 14.49l6.487-3.488 7.674 7.738a.83.83 0 0 0 1.181 0l2.762-2.762a.835.835 0 0 0 0-1.183l-6.622-6.677 6.622-6.752a.835.835 0 0 0 0-1.183z" />
    </svg>
  );
}

function CursorIcon({ size = 16, ...rest }: BrandIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" role="img" {...rest}>
      <path d={siCursor.path} />
    </svg>
  );
}

function TraeIcon({ size = 16, ...rest }: BrandIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#32F08C" role="img" {...rest}>
      <path d={siTrae.path} />
    </svg>
  );
}

function ZedIcon({ size = 16, ...rest }: BrandIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#084CCF" role="img" {...rest}>
      <path d={siZedindustries.path} />
    </svg>
  );
}

/** Render the brand mark for a detected IDE id; falls back to VSCode's mark. */
export function IdeBrandIcon({ id, ...props }: BrandIconProps & { id: string }) {
  switch (id) {
    case 'cursor':
      return <CursorIcon {...props} />;
    case 'trae':
      return <TraeIcon {...props} />;
    case 'zed':
      return <ZedIcon {...props} />;
    case 'vscode':
    default:
      return <VSCodeIcon {...props} />;
  }
}
