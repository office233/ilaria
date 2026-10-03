"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

type Props = {
  label: string;
  icon: ReactNode;
  count?: string | null;
  pressed?: boolean;
  busy?: boolean;
  onClick: () => void;
};

/** Buton din rail-ul feed-ului: iconiță peste video + număr, țintă ≥ 48px. */
export default function RailButton({ label, icon, count, pressed, busy, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={busy}
      className="flex min-h-12 min-w-12 flex-col items-center justify-center gap-0.5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded-control disabled:opacity-70"
    >
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center drop-shadow-md motion-safe:transition-transform motion-safe:duration-fast motion-safe:active:scale-90",
          "[&_svg]:h-7 [&_svg]:w-7",
        )}
      >
        {icon}
      </span>
      {count != null ? <span className="text-xs font-semibold tabular-nums drop-shadow">{count}</span> : null}
    </button>
  );
}
