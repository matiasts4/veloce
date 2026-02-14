"use client";

import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden="true"
      className={cn("text-primary", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="6"
        y="6"
        width="116"
        height="116"
        rx="30"
        fill="hsl(var(--card))"
        className="opacity-95"
      />
      <rect
        x="6"
        y="6"
        width="116"
        height="116"
        rx="30"
        stroke="currentColor"
        strokeOpacity="0.18"
      />

      <path
        d="M24 34H40L64 84L82 52"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M84 55C91 48 99 49 104 55C97 62 91 62 84 55Z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M80 72C86 66 94 66 100 72C94 78 86 78 80 72Z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M74 89C80 83 88 83 94 89"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M84 98C89 95 95 94 101 95"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
