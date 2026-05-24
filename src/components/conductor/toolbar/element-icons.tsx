export const ELEMENT_ICONS = {
  sticky: (
    <svg viewBox="0 0 36 36" fill="none">
      <defs>
        <linearGradient id="noteGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fff9c4"/>
          <stop offset="100%" stopColor="#ffeb3b"/>
        </linearGradient>
        <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="1" dy="1" stdDeviation="1" floodColor="#00000033"/>
        </filter>
      </defs>
      <path d="M4 3 L26 3 L32 9 L32 32 L4 32 Z" fill="url(#noteGrad)" filter="url(#shadow)" stroke="#f9a825" strokeWidth="0.6"/>
      <path d="M26 3 L26 9 L32 9" fill="#e6c220" stroke="#f9a825" strokeWidth="0.4"/>
      <line x1="8" y1="14" x2="28" y2="14" stroke="#d4c94a" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="8" y1="20" x2="28" y2="20" stroke="#d4c94a" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="8" y1="26" x2="22" y2="26" stroke="#d4c94a" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  ),

  card: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="4" y="6" width="28" height="18" rx="3" fill="#1a3a5c"/>
      <rect x="4" y="6" width="28" height="6" rx="3" fill="#2563a8"/>
      <rect x="6" y="8" width="5" height="2" rx="1" fill="rgba(255,255,255,0.6)"/>
      <rect x="6" y="16" width="16" height="1.5" rx="0.75" fill="rgba(255,255,255,0.3)"/>
      <rect x="6" y="19" width="10" height="1.5" rx="0.75" fill="rgba(255,255,255,0.2)"/>
      <rect x="6" y="26" width="24" height="6" rx="3" fill="#1a4a3a"/>
      <rect x="8" y="27.5" width="8" height="1.5" rx="0.75" fill="#2ea87a"/>
    </svg>
  ),

  connector: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="4" y="9" width="28" height="18" rx="3" fill="none"
        stroke="#3a7bd5" strokeWidth="1.5" strokeDasharray="3 2"/>
      <rect x="9" y="15" width="18" height="6" rx="3" fill="#1e4a8a"/>
      <rect x="11" y="17" width="10" height="2" rx="1" fill="#5a9de8"/>
    </svg>
  ),

  mindmap: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="12" y="15" width="12" height="7" rx="3" fill="#1e5c2a"/>
      <text x="18" y="20.5" textAnchor="middle" fontSize="5"
        fill="#4ade80" fontFamily="sans-serif" fontWeight="600">Root</text>
      <line x1="24" y1="18.5" x2="29" y2="14"
        stroke="#2ea84a" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="24" y1="18.5" x2="29" y2="23"
        stroke="#2ea84a" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="29" y="10" width="4" height="8" rx="2" fill="#1e5c2a"/>
      <rect x="29" y="19" width="4" height="8" rx="2" fill="#1e5c2a"/>
      <line x1="33" y1="12" x2="36" y2="10.5"
        stroke="#2ea84a" strokeWidth="1" strokeLinecap="round"/>
      <line x1="33" y1="16" x2="36" y2="17"
        stroke="#2ea84a" strokeWidth="1" strokeLinecap="round"/>
      <line x1="33" y1="21" x2="36" y2="20"
        stroke="#2ea84a" strokeWidth="1" strokeLinecap="round"/>
      <line x1="33" y1="25" x2="36" y2="26"
        stroke="#2ea84a" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),

  frame: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="4" y="6" width="28" height="22" rx="3"
        fill="#2a2040" stroke="#6050b0" strokeWidth="1"/>
      <line x1="4" y1="12" x2="32" y2="12" stroke="#6050b0" strokeWidth="0.8"/>
      <text x="7" y="10.5" fontSize="5" fill="rgba(160,140,240,0.8)"
        fontFamily="sans-serif" fontWeight="600">Frame</text>
      <rect x="7" y="15" width="8" height="5" rx="1.5" fill="#3a2a60"/>
      <rect x="17" y="15" width="11" height="5" rx="1.5" fill="#3a2a60"/>
      <rect x="7" y="22" width="21" height="3" rx="1.5" fill="#2e2250"/>
    </svg>
  ),

  section: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="4" y="6" width="28" height="24" rx="3" fill="none"
        stroke="#7c3a3a" strokeWidth="1.2" strokeDasharray="3 2"/>
      <text x="6" y="12" fontSize="5" fill="rgba(200,120,120,0.8)"
        fontFamily="sans-serif" fontWeight="600">Section</text>
      <line x1="4" y1="14" x2="32" y2="14" stroke="#7c3a3a" strokeWidth="0.8" strokeDasharray="2 1"/>
      <rect x="7" y="17" width="10" height="4" rx="1" fill="#4a2a2a"/>
      <rect x="19" y="17" width="10" height="4" rx="1" fill="#4a2a2a"/>
      <rect x="7" y="23" width="22" height="3" rx="1" fill="#3a2020"/>
    </svg>
  ),

  text: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="6" y="8" width="24" height="20" rx="2" fill="#2a2a3a"/>
      <rect x="9" y="12" width="12" height="2" rx="1" fill="#a0a0b0"/>
      <rect x="9" y="16" width="18" height="1.5" rx="0.75" fill="#707080"/>
      <rect x="9" y="19" width="15" height="1.5" rx="0.75" fill="#707080"/>
      <rect x="9" y="22" width="10" height="1.5" rx="0.75" fill="#505060"/>
      <text x="24" y="14" fontSize="6" fill="#5a9de8" fontFamily="sans-serif" fontWeight="700">T</text>
    </svg>
  ),

  shape: (
    <svg viewBox="0 0 36 36" fill="none">
      <rect x="5" y="7" width="12" height="10" rx="1" fill="#2563a8"/>
      <circle cx="26" cy="12" r="5" fill="#2ea87a"/>
      <rect x="5" y="20" width="10" height="10" rx="5" fill="#7c3aed"/>
      <path d="M26 20 L31 30 L21 30 Z" fill="#dc2626"/>
    </svg>
  ),

  select: (
    <svg viewBox="0 0 36 36" fill="none">
      <path d="M10 8 L10 28 M8 10 L12 10 M8 28 L12 28" stroke="#a0a0b0" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M26 8 L26 28 M24 10 L28 10 M24 28 L28 28" stroke="#a0a0b0" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M14 18 L22 18 M18 14 L18 22" stroke="#5a9de8" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="18" cy="18" r="3" fill="none" stroke="#5a9de8" strokeWidth="1.5"/>
    </svg>
  ),
};
