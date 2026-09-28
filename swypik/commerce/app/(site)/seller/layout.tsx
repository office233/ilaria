import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { SELLER_NAV_SECTIONS, visibleSellerNav } from "@/lib/seller/nav";
import MobileDashboardNav from "@/components/dashboard/MobileDashboardNav";
import DashboardSidebarNav from "@/components/dashboard/DashboardSidebarNav";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";

// Sesiunea seller (cookie) decide chrome-ul: fără încercări de prerandare statică.
export const dynamic = "force-dynamic";

/**
 * Panoul seller-ului: sidebar desktop + meniu mobil din ACEEAȘI listă
 * (lib/seller/nav.ts). Fără sesiune (pagina de login) → doar conținutul.
 */
export default async function SellerLayout({ children }: { children: ReactNode }) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return <div className="min-h-dvh bg-canvas text-fg">{children}</div>;

  const t = await getTranslations("sellerPanel");
  const { rows } = await dbQuery<{ name: string | null; is_verified: boolean }>(
    `SELECT name, is_verified FROM sellers WHERE id = $1`,
    [sellerId],
  );
  const seller = rows[0];

  const items = visibleSellerNav(isEnabled);
  const flat = items.map((i) => ({ href: i.href, icon: i.icon, label: t(`nav.${i.id}`) }));
  const groups = SELLER_NAV_SECTIONS.map((section) => ({
    id: section,
    title: t(`navSection.${section}`),
    items: items.filter((i) => i.section === section).map((i) => ({ href: i.href, icon: i.icon, label: t(`nav.${i.id}`) })),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-dvh bg-canvas text-fg">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-subtle bg-surface md:flex">
        <div className="flex h-header items-center gap-2 border-b border-subtle px-5">
          <Link href="/seller" className="text-lg font-bold text-fg">
            {t("title")}
          </Link>
          {seller?.is_verified ? <Badge tone="success">{t("verified")}</Badge> : null}
        </div>
        <DashboardSidebarNav groups={groups} />
        {seller?.name ? (
          <p className="truncate border-t border-subtle px-5 py-3 text-sm font-semibold text-muted">{seller.name}</p>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          className="md:hidden"
          title={t("title")}
          actions={
            <MobileDashboardNav
              title={t("title")}
              section={seller?.name ?? ""}
              items={flat}
              openMenuLabel={t("openMenu")}
              menuLabel={t("menu")}
            />
          }
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-gutter py-4 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
