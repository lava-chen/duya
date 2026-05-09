'use client';

import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { memo, useMemo } from 'react';

const MotionP = motion.create('p');

export interface TextShimmerProps {
  children: string;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return (
    <MotionP
      animate={{ backgroundPosition: '0% center' }}
      className="relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--muted),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]"
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--muted), var(--muted))',
        } as CSSProperties
      }
      transition={{
        duration,
        ease: 'linear',
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionP>
  );
};

export const Shimmer = memo(ShimmerComponent);
