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
  "sticky" | "connector" | "media" | "select",
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

  media: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="currentColor" fillOpacity="0.13" {...stroke} />
      <circle cx="8.5" cy="10" r="1.6" fill="currentColor" fillOpacity="0.5" />
      <path d="M4 17l4.2-4.2a1.6 1.6 0 0 1 2.3 0L14 16.3" {...stroke} />
      <path d="M13.5 15.5l2.3-2.3a1.6 1.6 0 0 1 2.3 0L20.5 15.5" {...stroke} />
    </svg>
  ),

  select: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M6.3 4.8 18.3 11 13 13.2l-2.2 5z" fill="currentColor" fillOpacity="0.2" {...stroke} />
      <path d="m12.9 13.1 4.2 4.2" {...stroke} />
    </svg>
  ),
};
