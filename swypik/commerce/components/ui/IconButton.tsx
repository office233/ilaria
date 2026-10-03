import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui/cn";

export const iconButtonVariants = cva(
  // `before:` extinde zona de atingere la minimum 44×44 și pentru mărimea sm.
  "relative inline-flex shrink-0 select-none items-center justify-center rounded-full transition-colors duration-fast ease-out before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 active:scale-95",
  {
    variants: {
      variant: {
        ghost: "text-fg hover:bg-surface-2",
        secondary: "border border-subtle bg-surface text-fg hover:bg-surface-2",
        primary: "bg-brand text-brand-fg hover:bg-brand-hover",
        /** Peste video/imagini: fundal translucid, text alb indiferent de temă. */
        overlay: "bg-black/40 text-white backdrop-blur-md hover:bg-black/55",
      },
      size: {
        sm: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4",
        md: "h-11 w-11 [&_svg]:h-5 [&_svg]:w-5",
        lg: "h-12 w-12 [&_svg]:h-6 [&_svg]:w-6",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> &
  VariantProps<typeof iconButtonVariants> & {
    /** Obligatoriu: textul accesibil (tradus) al butonului. */
    label: string;
    asChild?: boolean;
    /** Număr/etichetă mică în colț (ex. coș, notificări). */
    badge?: ReactNode;
  };

/** Buton doar cu iconiță; `label` devine aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, label, asChild = false, badge, children, type, ...props },
  ref,
) {
  const classes = cn(iconButtonVariants({ variant, size }), className);
  const badgeNode = badge !== undefined && badge !== null && badge !== false ? <IconBadge>{badge}</IconBadge> : null;
  if (asChild) {
    return (
      <Slot ref={ref} aria-label={label} className={classes} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button ref={ref} type={type ?? "button"} aria-label={label} className={classes} {...props}>
      {children}
      {badgeNode}
    </button>
  );
});

/** Badge de colț pentru IconButton folosit cu `asChild` (pune-l în interiorul Link-ului). */
export function IconBadge({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-xs font-semibold leading-none text-brand-fg ring-2 ring-surface">
      {children}
    </span>
  );
}
