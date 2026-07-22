// src/components/layout/DrawerSection.tsx
// Labelled section wrapper used inside the TaskDrawer. Owns only
// presentation (label + children); no state.

'use client';

import React from 'react';

export function DrawerSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="task-card-section">
      <div className="task-card-section-label">{label}</div>
      {children}
    </section>
  );
}