import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import MobileDashboardNav from "@/components/dashboard/MobileDashboardNav";
import { PageHeader } from "@/components/ui/PageHeader";
import { isEnabled } from "@/lib/feature-flags";
import { getCreatorUserId, getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import SidebarNav from "./_components/SidebarNav";
import { creatorNavEntries } from "./nav";

export default async function CreatorLayout({ children }: { children: ReactNode }) {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) {
    const userId = await getCreatorUserId();
    redirect(userId ? "/become-a-creator" : "/auth/login?next=/creator");
  }

  const t = await getTranslations("creatorStudio.nav");
  const items = creatorNavEntries({ movies: isEnabled("movies"), music: isEnabled("music") }).map((e) => ({
    href: e.href,
    icon: e.icon,
    label: t(e.labelKey),
  }));

  return (
    <div className="flex min-h-dvh bg-canvas text-fg">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-subtle bg-surface md:flex">
        <div className="flex h-header items-center border-b border-subtle px-5">
          <Link href="/creator" className="text-lg font-bold text-fg">
            {t("studio")}
          </Link>
        </div>
        <SidebarNav items={items} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          className="md:hidden"
          title={t("studio")}
          actions={
            <MobileDashboardNav
              title={t("studio")}
              section=""
              accentClassName="text-brand"
              items={items}
              openMenuLabel={t("openMenu")}
              closeMenuLabel={t("closeMenu")}
              menuLabel={t("menu")}
            />
          }
        />
        <main className="mx-auto w-full max-w-5xl flex-1 px-gutter py-4 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
