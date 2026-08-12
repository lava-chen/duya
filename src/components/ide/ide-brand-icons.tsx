"use client";

import { IconBrandVscode } from "@tabler/icons-react";
import { siCursor, siTrae, siZedindustries } from "simple-icons";
import type { SVGProps } from "react";

type BrandIconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Brand marks for the external IDEs detected by the file preview "Open"
 * action. Cursor, Zed and Trae use their official vector paths from
 * `simple-icons`; VSCode is not in that collection, so it uses Tabler's
 * brand icon. Cursor has no single brand hue (black/white logo), so it
 * follows `currentColor` to stay visible on both light and dark surfaces.
 */

function VSCodeIcon({ size = 16, ...rest }: BrandIconProps) {
  return <IconBrandVscode size={size} stroke={1.25} color="#007ACC" {...rest} />;
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