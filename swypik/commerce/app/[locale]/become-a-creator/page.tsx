import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowRight, DollarSign, Store, TrendingUp, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { CREATOR_CATEGORIES, getApplicationState } from "@/lib/creator/application";
import { CreatorApplyFlow, type ApplyFlowState } from "./_components/CreatorApplyFlow";
import { loadSuggestedHandle } from "./_components/data";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "becomeacreator" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates(locale, "/become-a-creator") };
}

export default async function BecomeACreatorPage() {
  const [t, tf] = await Promise.all([getTranslations("becomeacreator"), getTranslations("becomeCreatorForm")]);
  const auth = await getAuthUser();
  if (auth.role === "creator" || auth.role === "admin") redirect("/creator");

  const benefits = [
    { icon: Video, title: t("benefit1Title"), body: t("benefit1Body") },
    { icon: DollarSign, title: t("benefit2Title"), body: t("benefit2Body") },
    { icon: TrendingUp, title: t("benefit3Title"), body: t("benefit3Body") },
    { icon: Users, title: t("benefit4Title"), body: t("benefit4Body") },
  ];

  let action: ReactNode;
  if (auth.role === "seller") {
    action = <SellerNotice title={tf("sellerTitle")} body={tf("sellerBody")} />;
  } else if (!auth.userId) {
    action = (
      <Button asChild block size="lg">
        <Link href="/auth/login?next=/become-a-creator">
          {t("logheazateCaSaContinui")}
          <ArrowRight className="h-5 w-5" aria-hidden />
        </Link>
      </Button>
    );
  } else {
    const [state, defaultHandle] = await Promise.all([getApplicationState(auth.userId), loadSuggestedHandle(auth.userId)]);
    if (state.state === "creator") redirect("/creator");
    if (state.state === "seller") {
      action = <SellerNotice title={tf("sellerTitle")} body={tf("sellerBody")} />;
    } else {
      const initial: ApplyFlowState =
        state.state === "pending" || state.state === "rejected"
          ? { state: state.state, application: state.application }
          : { state: "none" };
      action = <CreatorApplyFlow initial={initial} categories={CREATOR_CATEGORIES} defaultHandle={defaultHandle} />;
    }
  }

  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <PageHeader back title={t("metaTitle")} />
      <div className="mx-auto max-w-2xl px-gutter pb-safe-b">
        <section className="py-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t("devinoCreatorPeSwypik")}</h1>
          <p className="mx-auto mt-3 max-w-xl text-base text-muted">{t("transformatiPasiuneaPentruShopping")}</p>
        </section>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {benefits.map(({ icon: Icon, title, body }) => (
            <li key={title}>
              <Card className="flex h-full gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-soft-fg">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-fg">{title}</h2>
                  <p className="mt-1 text-sm text-muted">{body}</p>
                </div>
              </Card>
            </li>
          ))}
        </ul>

        <section className="py-8">{action}</section>
        <p className="pb-8 text-center text-xs text-muted">{t("tePotiIntoarceOricand")}</p>
      </div>
    </div>
  );
}

function SellerNotice({ title, body }: { title: string; body: string }) {
  return (
    <Card padding="lg" role="status">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info-soft text-info">
          <Store className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <p className="mt-1 text-sm text-muted">{body}</p>
        </div>
      </div>
    </Card>
  );
}
