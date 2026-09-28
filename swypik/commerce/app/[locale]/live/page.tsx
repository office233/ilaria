import type { Metadata } from "next";
import { Radio } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { LiveCard } from "@/components/live/LiveCard";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAuthSession } from "@/lib/auth/session";
import Link from "next/link";
import { isLiveMediaConfigured } from "@/lib/live/config";
import { getLiveFeedItems, toLiveFeedItem } from "@/lib/live/feed-items";
import { listLiveStreams } from "@/lib/live/queries";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

const LIVE_GRID_LIMIT = 24;
const UPCOMING_LIMIT = 8;
const HOST_ROLES = new Set(["creator", "seller", "admin"]);

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "live.index" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates(locale, "/live") };
}

export default async function LivePage() {
  const [t, format, session] = await Promise.all([
    getTranslations("live.index"),
    getFormatter(),
    getAuthSession().catch(() => null),
  ]);
  const [live, scheduled] = await Promise.all([
    getLiveFeedItems({ limit: LIVE_GRID_LIMIT }).catch(() => []),
    listLiveStreams("scheduled", UPCOMING_LIMIT * 2).catch(() => []),
  ]);
  // Doar programările cu dată viitoare (fără ciorne vechi, niciodată pornite).
  const now = Date.now();
  const upcoming = scheduled
    .filter((s) => s.scheduled_at && new Date(s.scheduled_at).getTime() > now)
    .slice(0, UPCOMING_LIMIT);
  const canHost = Boolean(session && HOST_ROLES.has(session.role ?? ""));
  const configured = isLiveMediaConfigured();
  const goLive = canHost ? (
    <Button asChild>
      <Link href="/creator/live">{t("goLive")}</Link>
    </Button>
  ) : undefined;

  return (
    <ImmersiveSurface>
      <PageHeader title={t("title")} />
      <main className="mx-auto max-w-5xl space-y-6 px-gutter py-4">
        {!configured ? (
          <EmptyState icon={Radio} title={t("unconfiguredTitle")} description={t("unconfiguredDescription")} />
        ) : live.length === 0 ? (
          <EmptyState icon={Radio} title={t("emptyTitle")} description={t("emptyDescription")} action={goLive} />
        ) : (
          <section aria-labelledby="live-now">
            <h2 id="live-now" className="mb-3 text-base font-semibold">{t("liveNow")}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {live.map((item) => (
                <LiveCard key={item.id} item={item} liveLabel={t("liveBadge")} viewersLabel={t("viewers", { count: item.viewerCount })} />
              ))}
            </div>
          </section>
        )}

        {configured && upcoming.length > 0 ? (
          <section aria-labelledby="live-upcoming">
            <h2 id="live-upcoming" className="mb-3 text-base font-semibold">{t("upcoming")}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {upcoming.map((s) => {
                const item = toLiveFeedItem(s);
                const when = format.dateTime(new Date(String(s.scheduled_at)), { dateStyle: "medium", timeStyle: "short" });
                return <LiveCard key={s.id} item={item} liveLabel={t("soonBadge")} subtitle={when} viewersLabel="" />;
              })}
            </div>
          </section>
        ) : null}
      </main>
    </ImmersiveSurface>
  );
}
