"use client";

import { useTranslations } from "next-intl";
import { Gamepad2, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";

export type ArcadeGame = { id: string; title: string; category: string; embed_url: string; thumbnail_url: string };
export type GamesState = { status: "loading" } | { status: "error" } | { status: "ready"; games: ArcadeGame[] };

export default function ArcadeTab({ state, onRetry, onPlay }: { state: GamesState; onRetry: () => void; onPlay: (g: ArcadeGame) => void }) {
  const t = useTranslations("gaming");

  if (state.status === "loading") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full rounded-card" />)}
      </div>
    );
  }
  if (state.status === "error") return <ErrorState onRetry={onRetry} />;
  if (state.games.length === 0) return <EmptyState icon={Gamepad2} title={t("arcade.empty")} />;

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {state.games.map((game) => (
        <li key={game.id}>
          <Card padding="sm" className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- thumbnail host comes from gaming_games */}
            <img src={game.thumbnail_url} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-control bg-surface-2 object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-fg">{game.title}</p>
              <p className="text-xs text-muted">{t("arcade.xpHint")}</p>
            </div>
            <Button onClick={() => onPlay(game)} aria-label={t("arcade.playNamed", { title: game.title })}>
              <Play className="h-4 w-4" aria-hidden /> {t("arcade.play")}
            </Button>
          </Card>
        </li>
      ))}
    </ul>
  );
}
