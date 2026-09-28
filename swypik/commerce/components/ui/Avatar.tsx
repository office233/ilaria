"use client";

import { useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui/cn";
import { initialsOf } from "@/lib/ui/initials";

const avatarVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft font-semibold text-brand-soft-fg",
  {
    variants: {
      size: {
        xs: "h-6 w-6 text-xs",
        sm: "h-8 w-8 text-xs",
        md: "h-10 w-10 text-sm",
        lg: "h-14 w-14 text-lg",
        xl: "h-20 w-20 text-2xl",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type AvatarProps = VariantProps<typeof avatarVariants> & {
  src?: string | null;
  /** Numele persoanei: alt text + inițiale ca fallback. */
  name?: string | null;
  className?: string;
};

/** Avatar rotund cu fallback la inițiale când imaginea lipsește sau nu se încarcă. */
export function Avatar({ src, name, size, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;
  return (
    <span className={cn(avatarVariants({ size }), className)}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatare din domenii arbitrare (R2/OAuth)
        <img
          src={src ?? undefined}
          alt={name ?? ""}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden={name ? undefined : true}>{initialsOf(name)}</span>
      )}
    </span>
  );
}
