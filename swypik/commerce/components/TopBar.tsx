"use client";

import { Inbox, Search, ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import Logo from "@/components/Logo";
import AppMenuButton from "@/components/nav/AppMenuButton";
import { IconBadge, IconButton } from "@/components/ui/IconButton";
import { formatBadgeCount, useCartCount, useUnreadCount } from "@/lib/nav/useShellCounts";
import { cn } from "@/lib/ui/cn";

/**
 * TopBar — header-ul principal al paginilor de nivel întâi: ☰ meniu, logo,
 * căutare, coș, inbox (notificări + mesaje necitite). Tokenuri → light/dark
 * automat; în <ImmersiveSurface> devine întunecat.
 *
 * Pentru pagini interne folosește <PageHeader back title="…" /> din components/ui.
 */
export default function TopBar({ className }: { className?: string }) {
  const t = useTranslations("topBar");
  const cartBadge = formatBadgeCount(useCartCount());
  const unreadBadge = formatBadgeCount(useUnreadCount());

  return (
    <header
      className={cn(
        "sticky top-0 z-header border-b border-subtle bg-surface/90 pt-safe-t text-fg backdrop-blur-xl",
        className,
      )}
    >
      <div className="mx-auto flex h-header max-w-5xl items-center gap-1 px-gutter">
        <AppMenuButton className="-ml-2" />
        <Logo href="/" />
        <div className="-mr-2 ml-auto flex items-center gap-0.5">
          <IconButton asChild label={t("search")}>
            <Link href="/search">
              <Search aria-hidden />
            </Link>
          </IconButton>
          <IconButton asChild label={cartBadge ? t("cartWithCount", { count: cartBadge }) : t("cart")}>
            <Link href="/cart">
              <ShoppingBag aria-hidden />
              {cartBadge ? <IconBadge>{cartBadge}</IconBadge> : null}
            </Link>
          </IconButton>
          <IconButton asChild label={unreadBadge ? t("inboxWithCount", { count: unreadBadge }) : t("inbox")}>
            <Link href="/inbox">
              <Inbox aria-hidden />
              {unreadBadge ? <IconBadge>{unreadBadge}</IconBadge> : null}
            </Link>
          </IconButton>
        </div>
      </div>
    </header>
  );
}
