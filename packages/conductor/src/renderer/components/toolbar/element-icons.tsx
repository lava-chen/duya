import type { ReactNode } from "react";

const iconStyle = {
  width: "100%",
  height: "100%",
  color: "currentColor",
} as const;

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const ELEMENT_ICONS: Record<
  "sticky" | "connector" | "mindmap" | "select",
  ReactNode
> = {
  sticky: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M6.5 4.5h8.8l3.2 3.2v11.8h-12z" fill="currentColor" fillOpacity="0.13" {...stroke} />
      <path d="M15.3 4.5v3.2h3.2" fill="currentColor" fillOpacity="0.21" {...stroke} />
      <path d="M9 11h6M9 14h5" {...stroke} />
    </svg>
  ),

  connector: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <circle cx="6.25" cy="16.75" r="2" fill="currentColor" fillOpacity="0.2" />
      <circle cx="17.75" cy="7.25" r="2" fill="currentColor" fillOpacity="0.2" />
      <path d="M8.4 15.9C12 14.9 12 9.2 15.7 8.1" {...stroke} />
      <path d="M14.9 5.8 18.3 7.2l-1.4 3.4" {...stroke} />
    </svg>
  ),

  mindmap: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4" y="9" width="7" height="6" rx="2.1" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <path d="M11 12h3.8M14.8 7.8v8.2" {...stroke} />
      <rect x="15" y="5" width="5" height="4" rx="1.6" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <rect x="15" y="15" width="5" height="4" rx="1.6" fill="currentColor" fillOpacity="0.14" {...stroke} />
    </svg>
  ),

  select: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M6.3 4.8 18.3 11 13 13.2l-2.2 5z" fill="currentColor" fillOpacity="0.2" {...stroke} />
      <path d="m12.9 13.1 4.2 4.2" {...stroke} />
    </svg>
  ),
};
