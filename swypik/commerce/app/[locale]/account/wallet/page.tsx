import type { Metadata } from "next";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getWalletSnapshot, type WalletActivity } from "@/lib/wallet/read-model";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Link } from "@/lib/i18n/navigation";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "walletPage" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

function activityKey(refType: string): string {
  if (/^(ride|driver_referral)/.test(refType)) return "mobility";
  if (/^(order|commission_order)/.test(refType)) return "orders";
  if (/^stay_/.test(refType)) return "stays";
  if (/^(mission_|creator_|fund_)/.test(refType)) return "creator";
  if (/^music_/.test(refType)) return "music";
  if (/^movie/.test(refType)) return "movies";
  if (/^payout/.test(refType)) return "payout";
  if (/refund|reversal|clawback/.test(refType)) return "adjustment";
  return "other";
}

function ActivityRow({
  item,
  currency,
  locale,
  label,
  date,
}: {
  item: WalletActivity;
  currency: string;
  locale: typeof DEFAULT_LOCALE;
  label: string;
  date: string;
}) {
  const credit = item.kind === "credit";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2">
        {credit ? (
          <ArrowDownLeft className="h-5 w-5 text-success" aria-hidden />
        ) : (
          <ArrowUpRight className="h-5 w-5 text-danger" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg">{label}</span>
        <span className="block text-xs text-muted">{date}</span>
      </span>
      <span className="text-right">
        <span className={`block text-sm font-bold ${credit ? "text-success" : "text-fg"}`}>
          {credit ? "+" : "−"}
          {formatMoneyCents(item.amountCents, currency, locale)}
        </span>
        <span className="block text-xs text-subtle">
          {formatMoneyCents(item.balanceAfterCents, currency, locale)}
        </span>
      </span>
    </li>
  );
}

export default async function WalletPage({ params, searchParams }: Props) {
  const [{ locale: rawLocale }, { cursor }] = await Promise.all([params, searchParams]);
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: "/account?redirect=/account/wallet", locale });

  const [t, format, wallet] = await Promise.all([
    getTranslations({ locale, namespace: "walletPage" }),
    getFormatter({ locale }),
    getWalletSnapshot(user.userId, { cursor, limit: 30 }),
  ]);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/account/settings" title={t("title")} />
      <main className="mx-auto max-w-2xl space-y-4 px-gutter py-4">
        <Card className="overflow-hidden" padding="lg">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-muted">{t("availableBalance")}</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-fg">
                {formatMoneyCents(wallet.balanceCents, wallet.currency, locale)}
              </p>
            </div>
            <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand-soft-fg">
              <Wallet className="h-6 w-6" aria-hidden />
            </span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-control bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">{t("moneyIn")}</p>
              <p className="mt-1 text-base font-bold text-success">
                {formatMoneyCents(wallet.totalCreditsCents, wallet.currency, locale)}
              </p>
            </div>
            <div className="rounded-control bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">{t("moneyOut")}</p>
              <p className="mt-1 text-base font-bold text-fg">
                {formatMoneyCents(wallet.totalDebitsCents, wallet.currency, locale)}
              </p>
            </div>
          </div>
          <div className="mt-4">
            <Badge tone="neutral">{t("currency", { currency: wallet.currency })}</Badge>
          </div>
        </Card>

        <section aria-labelledby="wallet-activity-title">
          <h2 id="wallet-activity-title" className="mb-2 px-1 text-sm font-bold text-fg">
            {t("activityTitle")}
          </h2>
          {wallet.activity.length === 0 ? (
            <EmptyState icon={Wallet} title={t("emptyTitle")} description={t("emptyBody")} />
          ) : (
            <Card padding="none">
              <ul className="divide-y divide-subtle">
                {wallet.activity.map((item) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    currency={wallet.currency}
                    locale={locale}
                    label={t(`activity.${activityKey(item.refType)}`)}
                    date={format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                  />
                ))}
              </ul>
            </Card>
          )}
        </section>

        {wallet.nextCursor ? (
          <div className="flex justify-center pb-4">
            <Button asChild variant="secondary">
              <Link href={`/account/wallet?cursor=${encodeURIComponent(wallet.nextCursor)}`}>
                {t("loadMore")}
              </Link>
            </Button>
          </div>
        ) : null}

        <p className="px-2 pb-4 text-center text-xs text-subtle">{t("readOnlyNote")}</p>
      </main>
    </div>
  );
}
