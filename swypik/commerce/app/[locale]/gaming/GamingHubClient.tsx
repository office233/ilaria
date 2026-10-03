"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import ArcadeTab, { type ArcadeGame, type GamesState } from "@/components/gaming/ArcadeTab";
import GamePlayerModal from "@/components/gaming/GamePlayerModal";
import LevelCard, { type ProfileState } from "@/components/gaming/LevelCard";
import TriviaTab from "@/components/gaming/TriviaTab";
import XpGuide from "@/components/gaming/XpGuide";

const LOGIN_HREF = "/auth/login?next=/gaming";

/** Gaming = a light XP layer: level card, arcade, daily trivia, how XP is earned. */
export default function GamingHubClient() {
  const t = useTranslations("gaming");
  const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
  const [games, setGames] = useState<GamesState>({ status: "loading" });
  const [activeGame, setActiveGame] = useState<ArcadeGame | null>(null);

  const loadProfile = useCallback(() => {
    fetch("/api/gaming/profile", { credentials: "same-origin" })
      .then(async (r) => {
        if (r.status === 401) return setProfile({ status: "guest" });
        const d = await r.json();
        setProfile(r.ok && d.ok ? { status: "ready", profile: d } : { status: "error" });
      })
      .catch(() => setProfile({ status: "error" }));
  }, []);

  const loadGames = useCallback(() => {
    setGames({ status: "loading" });
    fetch("/api/gaming/games")
      .then((r) => r.json())
      .then((d) => setGames(d.ok ? { status: "ready", games: d.games ?? [] } : { status: "error" }))
      .catch(() => setGames({ status: "error" }));
  }, []);

  useEffect(() => {
    loadProfile();
    loadGames();
  }, [loadProfile, loadGames]);

  const closeGame = useCallback(() => setActiveGame(null), []);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader title={t("hub.title")} />
      <div className="mx-auto max-w-3xl space-y-4 px-gutter py-4">
        <p className="text-sm text-muted">{t("hub.subtitle")}</p>
        <LevelCard state={profile} loginHref={LOGIN_HREF} />
        <Tabs defaultValue="arcade">
          <TabsList variant="pill" className="px-0">
            <TabsTrigger value="arcade">{t("tabs.arcade")}</TabsTrigger>
            <TabsTrigger value="trivia">{t("tabs.trivia")}</TabsTrigger>
          </TabsList>
          <TabsContent value="arcade" className="pt-3">
            <ArcadeTab state={games} onRetry={loadGames} onPlay={setActiveGame} />
          </TabsContent>
          <TabsContent value="trivia" className="pt-3">
            <TriviaTab loginHref={LOGIN_HREF} onXpChanged={loadProfile} />
          </TabsContent>
        </Tabs>
        <XpGuide />
      </div>
      <GamePlayerModal game={activeGame} canEarn={profile.status === "ready"} onClose={closeGame} onScoreChanged={loadProfile} />
    </div>
  );
}
