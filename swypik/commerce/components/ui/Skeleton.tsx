import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

/** Bloc placeholder animat. Dimensionează-l cu clase (`h-4 w-32`, `aspect-video`). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("animate-pulse rounded-control bg-surface-2", className)} {...props} />;
}

/** N rânduri de text placeholder. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
