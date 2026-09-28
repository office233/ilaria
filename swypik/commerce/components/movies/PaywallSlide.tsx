"use client";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import UnlockButton from "./UnlockButton";

type Props = {
  slug: string;
  episodeId: string;
  episodeNumber: number;
  totalEpisodes: number;
  priceCents: number | null;
  seasonPriceCents: number | null;
  poster: string | null;
  onUnlocked: () => void;
};

export default function PaywallSlide(p: Props) {
  const t = useTranslations("movies");
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-end bg-canvas px-gutter pb-safe-b">
      {p.poster && <div className="absolute inset-0 bg-cover bg-center opacity-30 blur-md" style={{ backgroundImage: `url(${p.poster})` }} />}
      <div className="relative mb-10 w-full max-w-sm space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-2">
          <Lock className="h-6 w-6 text-fg" aria-hidden />
        </div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">{t("episodeOf", { n: p.episodeNumber, total: p.totalEpisodes })}</p>
        <h2 className="text-2xl font-black text-fg">{t("locked")}</h2>
        <UnlockButton slug={p.slug} target={{ episodeId: p.episodeId }} priceCents={p.priceCents} label={t("unlockEpisode")} onUnlocked={p.onUnlocked} />
        {p.seasonPriceCents !== null && p.seasonPriceCents > 0 && (
          <UnlockButton slug={p.slug} target={{ season: true }} priceCents={p.seasonPriceCents} label={t("unlockSeason")} onUnlocked={p.onUnlocked} />
        )}
      </div>
    </div>
  );
}
