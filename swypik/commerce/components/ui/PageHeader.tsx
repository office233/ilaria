"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { cn } from "@/lib/ui/cn";
import { IconButton } from "./IconButton";
import AppMenuButton from "@/components/nav/AppMenuButton";

export type PageHeaderProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  /**
   * Butonul „Înapoi”: `true` = istoric (router.back), string = rută fixă.
   * Paginile de nivel întâi nu au back, ci meniul (vezi `menu`).
   */
  back?: boolean | string;
  /** Butonul ☰ care deschide meniul aplicației (implicit: activ când nu e back). */
  menu?: boolean;
  /** Acțiuni în dreapta (IconButton-uri). */
  actions?: ReactNode;
  /** Rând suplimentar sub titlu (Tabs, căutare, filtre). */
  children?: ReactNode;
  /** `transparent` peste media (hero, video); `surface` implicit. */
  tone?: "surface" | "transparent";
  sticky?: boolean;
  className?: string;
};

/**
 * Header de pagină: sticky, respectă safe-area sus, 56px înălțime.
 * Înlocuiește header-ele scrise de mână (back + titlu + acțiuni).
 */
export function PageHeader({
  title,
  subtitle,
  back,
  menu,
  actions,
  children,
  tone = "surface",
  sticky = true,
  className,
}: PageHeaderProps) {
  const t = useTranslations("ui");
  const router = useRouter();
  const showMenu = menu ?? !back;

  let leading: ReactNode = null;
  if (typeof back === "string") {
    leading = (
      <IconButton asChild label={t("back")} className="-ml-2">
        <Link href={back}>
          <ArrowLeft aria-hidden />
        </Link>
      </IconButton>
    );
  } else if (back) {
    leading = (
      <IconButton label={t("back")} className="-ml-2" onClick={() => router.back()}>
        <ArrowLeft aria-hidden />
      </IconButton>
    );
  } else if (showMenu) {
    leading = <AppMenuButton className="-ml-2" />;
  }

  return (
    <header
      className={cn(
        "z-header w-full pt-safe-t",
        sticky && "sticky top-0",
        tone === "surface" ? "border-b border-subtle bg-surface/90 backdrop-blur-xl" : "bg-transparent",
        className,
      )}
    >
      <div className="mx-auto flex h-header max-w-5xl items-center gap-1 px-gutter">
        {leading}
        <div className="min-w-0 flex-1 px-1">
          {title ? <h1 className="truncate text-lg font-semibold leading-tight text-fg">{title}</h1> : null}
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="-mr-2 flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children ? <div className="mx-auto max-w-5xl">{children}</div> : null}
    </header>
  );
}
