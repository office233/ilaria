"use client";

/**
 * Pagina unui restaurant care nu e încă pe Swypik: spunem clar că nu se poate
 * comanda, oferim „Sugerează proprietarului” (clienți) și „Revendică afacerea”
 * (proprietari).
 */
import { useState } from "react";
import { BadgeCheck, Megaphone, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { MerchantSummary } from "@/lib/food/types";
import ClaimSheet from "./ClaimSheet";
import { useSuggestMerchant } from "./useSuggestMerchant";

type Props = { m: MerchantSummary; signedIn: boolean; returnPath: string };

export default function UnclaimedMerchantView({ m, signedIn, returnPath }: Props) {
  const t = useTranslations("foodHub");
  const sug = useSuggestMerchant();
  const [claimOpen, setClaimOpen] = useState(false);
  const suggested = sug.suggested.has(m.id);
  const count = sug.counts[m.id] ?? m.suggestion_count;

  return (
    <div className="space-y-4 px-gutter pt-4">
      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-control bg-warning-soft text-warning" aria-hidden>
            <Store size={20} />
          </span>
          <div>
            <p className="text-base font-bold text-fg">{t("notOnSwypikTitle")}</p>
            <p className="text-sm text-muted">{t("notOrderableSub", { name: m.name })}</p>
          </div>
        </div>
        <Button block loading={sug.busyId === m.id} disabled={suggested} variant={suggested ? "soft" : "primary"} onClick={() => void sug.suggest(m.id)}>
          <Megaphone size={18} aria-hidden />
          {suggested ? t("suggested") : t("suggestLong")}
        </Button>
        {count > 0 ? <p className="text-center text-sm text-muted">{t("suggestCount", { count })}</p> : null}
      </Card>

      <Card variant="muted" className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-bold text-fg">
          <BadgeCheck size={18} aria-hidden className="text-brand" /> {t("ownerQuestion")}
        </p>
        <p className="text-sm text-muted">{t("ownerPitch")}</p>
        <Button variant="secondary" block onClick={() => setClaimOpen(true)}>{t("claimCta")}</Button>
      </Card>

      <ClaimSheet
        open={claimOpen}
        onOpenChange={setClaimOpen}
        merchantId={m.id}
        merchantName={m.name}
        signedIn={signedIn}
        returnPath={returnPath}
      />
    </div>
  );
}
