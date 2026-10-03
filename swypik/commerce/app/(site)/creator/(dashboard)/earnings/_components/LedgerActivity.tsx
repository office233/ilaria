import { useFormatter, useLocale, useTranslations } from "next-intl";
import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItem } from "@/components/ui/ListItem";
import type { LedgerEntryView } from "@/lib/creator/earnings";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/ui/cn";

/** Ultimele mișcări din portofel (câștiguri, reversări, retrageri). */
export function LedgerActivity({ entries }: { entries: LedgerEntryView[] }) {
  const t = useTranslations("creatorStudio.earnings");
  const format = useFormatter();
  const locale = useLocale() as Locale;

  const label = (e: LedgerEntryView) =>
    t.has(`refType.${e.refType}`) ? t(`refType.${e.refType}`) : t(`source.${e.source}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activityTitle")}</CardTitle>
      </CardHeader>
      {entries.length === 0 ? (
        <EmptyState icon={Receipt} title={t("activityEmptyTitle")} description={t("activityEmptyBody")} className="py-6" />
      ) : (
        <ul className="-mx-3">
          {entries.map((e) => {
            const credit = e.kind === "credit";
            const amount = formatMoneyCents(e.amountCents, "RON", locale);
            return (
              <li key={e.id}>
                <ListItem
                  icon={credit ? ArrowDownLeft : ArrowUpRight}
                  title={label(e)}
                  subtitle={format.dateTime(new Date(e.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                  trailing={
                    <span className={cn("shrink-0 text-sm font-semibold tabular-nums", credit ? "text-success" : "text-fg")}>
                      {credit ? "+" : "−"}
                      {amount}
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
