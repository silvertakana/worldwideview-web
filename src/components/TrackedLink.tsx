"use client";

import { trackEvent } from "@/lib/analytics";

interface TrackedLinkProps {
  href: string;
  className?: string;
  eventName: string;
  eventData?: Record<string, unknown>;
  children: React.ReactNode;
}

export default function TrackedLink({
  href,
  className,
  eventName,
  eventData,
  children,
}: TrackedLinkProps) {
  return (
    <a
      href={href}
      className={className}
      onClick={() => trackEvent(eventName, eventData)}
    >
      {children}
    </a>
  );
}
