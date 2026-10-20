'use client';

import type { CSSProperties } from 'react';
import { memo } from 'react';

export interface TextShimmerProps {
  children: string;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  className,
  duration = 1.5,
  spread,
}: TextShimmerProps) => {
  void spread;

  return (
    <span
      className={['shimmer-text inline-block', className].filter(Boolean).join(' ')}
      style={{ animationDuration: `${duration}s` } as CSSProperties}
    >
      {children}
    </span>
  );
};

export const Shimmer = memo(ShimmerComponent);
