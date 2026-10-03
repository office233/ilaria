import { getTranslations } from "next-intl/server";
import { Trophy } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { listOpenMissions } from "@/lib/missions/repo";
import { MissionCard } from "./_components/MissionCard";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("missionsTitle"), description: t("missionsDescription"), alternates: localizedAlternates(locale, "/missions") };
}

export default async function MissionsPage() {
  const t = await getTranslations("missionsHub");
  const missions = await listOpenMissions(50);

  return (
    <main className="min-h-dvh bg-canvas text-fg">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="mx-auto max-w-3xl px-gutter py-4">
        {missions.length === 0 ? (
          <EmptyState icon={Trophy} title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <ul className="space-y-3">
            {missions.map((m) => (
              <li key={m.id}>
                <MissionCard mission={m} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
