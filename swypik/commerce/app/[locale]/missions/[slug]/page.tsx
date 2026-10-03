import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CalendarClock, ChevronRight, Coins, Trophy, Users, Video } from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getOpenMissionBySlug } from "@/lib/missions/repo";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { MissionThumb } from "../_components/MissionThumb";
import { formatDate, formatRon, remainingLabel } from "../_components/format";
import { SubmitExistingClip } from "./_components/SubmitExistingClip";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Params) {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: "missionsHub" });
  const mission = await getOpenMissionBySlug(slug).catch(() => null);
  if (!mission) return { title: t("meta.fallbackTitle") };
  return {
    alternates: localizedAlternates(locale, `/missions/${slug}`),
    title: t("meta.title", { title: mission.title }),
    description: mission.brief?.slice(0, 160) ?? t("subtitle"),
  };
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-control bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1 font-semibold text-fg">{value}</p>
    </div>
  );
}

export default async function MissionDetailPage({ params }: Params) {
  const { slug } = await params;
  const [t, locale, mission, creator] = await Promise.all([
    getTranslations("missionsHub"),
    getLocale(),
    getOpenMissionBySlug(slug),
    getCreatorUserIdWithRoleCheck().catch(() => null),
  ]);
  if (!mission) notFound();

  const prize = formatRon(mission.prizeCents, locale);
  const icon = "h-3.5 w-3.5";

  return (
    <main className="min-h-dvh bg-canvas text-fg">
      <PageHeader back="/missions" title={t("detail.heading")} subtitle={t("detail.subheading")} />
      <article className="mx-auto max-w-3xl space-y-4 px-gutter py-4">
        <Card padding="lg" className="space-y-5">
          <div className="flex items-start gap-3">
            <MissionThumb
              image={mission.product?.image ?? null}
              alt={mission.product?.title ?? mission.title}
              className="h-24 w-24"
            />
            <h2 className="min-w-0 flex-1 text-2xl font-bold leading-tight">{mission.title}</h2>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Fact icon={<Coins className={icon} aria-hidden />} label={t("detail.prizeLabel")} value={prize} />
            <Fact
              icon={<Trophy className={icon} aria-hidden />}
              label={t("detail.winnersLabel")}
              value={mission.maxWinners ? t("winnersCount", { count: mission.maxWinners }) : t("detail.winnersOpen")}
            />
            <Fact
              icon={<CalendarClock className={icon} aria-hidden />}
              label={t("detail.deadlineLabel")}
              value={mission.endsAt ? formatDate(mission.endsAt, locale) : t("remaining.none")}
            />
            <Fact
              icon={<Users className={icon} aria-hidden />}
              label={t("detail.submissionsLabel")}
              value={t("submissionsCount", { count: mission.submissionsCount })}
            />
          </div>
          {mission.endsAt ? <p className="text-sm text-muted">{remainingLabel(t, mission.endsAt)}</p> : null}

          {mission.brief ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("detail.briefHeading")}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-fg">{mission.brief}</p>
            </section>
          ) : null}

          {mission.formatHint ? (
            <section className="rounded-control border border-subtle bg-surface-2 p-4">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                <Video className="h-4 w-4" aria-hidden /> {t("detail.formatHeading")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-fg">{mission.formatHint}</p>
            </section>
          ) : null}
        </Card>

        {mission.product ? (
          <Link
            href={`/product/${mission.product.id}`}
            className="flex min-h-11 items-center gap-3 rounded-card border border-subtle bg-surface p-3 transition-shadow duration-base hover:shadow-elev-2"
          >
            <MissionThumb image={mission.product.image} alt={mission.product.title ?? ""} className="h-14 w-14" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">{t("detail.productLabel")}</p>
              <p className="truncate font-semibold">{mission.product.title ?? t("detail.viewProduct")}</p>
            </div>
            <ChevronRight className="h-5 w-5 text-subtle" aria-hidden />
          </Link>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild size="lg" className="flex-1">
            <Link href={`/upload?mission=${mission.id}`}>{t("detail.joinNew")}</Link>
          </Button>
          {creator ? (
            <SubmitExistingClip slug={mission.slug} prizeLabel={prize} />
          ) : (
            <Button asChild variant="secondary" size="lg" className="flex-1">
              <Link href="/become-a-creator">{t("detail.becomeCreator")}</Link>
            </Button>
          )}
        </div>
        {creator ? null : <p className="text-center text-xs text-muted">{t("detail.creatorsOnly")}</p>}
      </article>
    </main>
  );
}
