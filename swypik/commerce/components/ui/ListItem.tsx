import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import { Link } from "@/lib/i18n/navigation";
import { isNonLocalizedPath } from "@/lib/i18n/non-localized";
import { cn } from "@/lib/ui/cn";

export type ListItemProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Iconiță lucide într-un pătrat nuanțat (monocrom). */
  icon?: LucideIcon;
  /** Element custom în stânga (ex. <Avatar>), în locul iconiței. */
  leading?: ReactNode;
  /** Element în dreapta (Badge, Switch, preț). Implicit: chevron când e link. */
  trailing?: ReactNode;
  /** Rută internă (localizată automat). */
  href?: string;
  /** Link extern (target=_blank, rel=noreferrer). */
  externalHref?: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
};

/**
 * Rând de listă (48px+): meniuri, setări, liste de module. Randează <Link>,
 * <a> sau <button> după props; fără href/onClick e un rând static.
 */
export function ListItem({
  title,
  subtitle,
  icon: Icon,
  leading,
  trailing,
  href,
  externalHref,
  onClick,
  active = false,
  className,
}: ListItemProps) {
  const interactive = Boolean(href || externalHref || onClick);
  const classes = cn(
    "flex min-h-12 w-full items-center gap-3 rounded-control px-3 py-2 text-left transition-colors duration-fast",
    interactive && "hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2",
    active && "bg-brand-soft text-brand-soft-fg hover:bg-brand-soft",
    className,
  );
  const content = (
    <>
      {leading ??
        (Icon ? (
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg",
              active && "bg-brand text-brand-fg",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        ) : null)}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{title}</span>
        {subtitle ? <span className="block truncate text-xs text-muted">{subtitle}</span> : null}
      </span>
      {trailing ?? (href || externalHref ? <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden /> : null)}
    </>
  );

  if (href) {
    // /admin, /seller, /creator, /auth… nu au prefix de limbă: link simplu.
    const ItemLink = isNonLocalizedPath(href) ? NextLink : Link;
    return (
      <ItemLink href={href} onClick={onClick} className={classes} aria-current={active ? "page" : undefined}>
        {content}
      </ItemLink>
    );
  }
  if (externalHref) {
    return (
      <a href={externalHref} target="_blank" rel="noreferrer" onClick={onClick} className={classes}>
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }
  return <div className={classes}>{content}</div>;
}
