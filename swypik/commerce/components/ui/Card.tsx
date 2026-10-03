import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui/cn";

export const cardVariants = cva("rounded-card text-fg", {
  variants: {
    variant: {
      /** Card standard pe canvas: suprafață + bordură fină. */
      default: "border border-subtle bg-surface",
      /** Card ridicat (umbră, fără bordură) — elemente interactive/promovate. */
      elevated: "bg-elevated shadow-elev-2",
      /** Zonă secundară, fără bordură. */
      muted: "bg-surface-2",
      /** Doar conturul. */
      outline: "border border-strong bg-transparent",
    },
    padding: { none: "", sm: "p-3", md: "p-4", lg: "p-6" },
    interactive: {
      true: "cursor-pointer transition-shadow duration-base ease-out hover:shadow-elev-2 active:scale-[0.99]",
    },
  },
  defaultVariants: { variant: "default", padding: "md" },
});

export type CardProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>;

/** Container de conținut (rază lg). Pentru un card-link, pune <Link> în interior sau folosește ListItem. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, padding, interactive, ...props },
  ref,
) {
  return <div ref={ref} className={cn(cardVariants({ variant, padding, interactive }), className)} {...props} />;
});

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3 flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold leading-tight text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}
