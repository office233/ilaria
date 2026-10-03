import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/ui/cn";

/** Container + titlu standard pentru paginile consolei (server-compatible). */
export function AdminPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-gutter py-5 md:px-8 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-fg">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export type LinkTab = { id: string; label: string; href: string; count?: number | null };

/** Filtre ca link-uri (stare în URL, funcționează fără JS). Scroll orizontal pe mobil. */
export function LinkTabs({ tabs, active, label }: { tabs: LinkTab[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-gutter overflow-x-auto px-gutter md:mx-0 md:px-0">
      <ul className="flex w-max gap-2">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
                  isActive ? "border-transparent bg-brand text-brand-fg" : "border-subtle bg-surface text-fg hover:bg-surface-2",
                )}
              >
                {tab.label}
                {tab.count != null ? <span className="tabular-nums opacity-80">{tab.count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Paginare simplă prin link-uri. */
export function Pager({
  page,
  totalPages,
  hrefFor,
  labels,
}: {
  page: number;
  totalPages: number;
  hrefFor: (page: number) => string;
  labels: { previous: string; next: string; status: string };
}) {
  if (totalPages <= 1) return null;
  const btn = "inline-flex min-h-11 items-center rounded-control border border-subtle bg-surface px-4 text-sm font-medium hover:bg-surface-2";
  return (
    <div className="flex items-center justify-between gap-2">
      {page > 1 ? <Link className={btn} href={hrefFor(page - 1)}>{labels.previous}</Link> : <span />}
      <span className="text-sm text-muted">{labels.status}</span>
      {page < totalPages ? <Link className={btn} href={hrefFor(page + 1)}>{labels.next}</Link> : <span />}
    </div>
  );
}
