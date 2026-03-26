'use client';

import { useInView } from '@/hooks/useInView';
import { CSSProperties, ReactNode } from 'react';

interface AnimateInProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  animation?: 'fadeInUp' | 'scaleIn';
}

/** Wrapper that triggers a CSS entrance animation when scrolled into view. */
export default function AnimateIn({
  children,
  className = '',
  delay = 0,
  animation = 'fadeInUp',
}: AnimateInProps) {
  const { ref, isVisible } = useInView(0.1);

  const style: CSSProperties = isVisible
    ? {
        animation: `${animation} 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${delay}s forwards`,
      }
    : {};

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement | null>}
      className={className}
      style={{
        opacity: 0,
        transform: animation === 'scaleIn' ? 'scale(0.92)' : 'translateY(30px)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
