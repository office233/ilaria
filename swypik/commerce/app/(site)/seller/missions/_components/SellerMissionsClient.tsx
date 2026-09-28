"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trophy } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { CreateMissionSheet } from "./CreateMissionSheet";
import { FundMissionSheet } from "./FundMissionSheet";
import { MissionDetailSheet } from "./MissionDetailSheet";
import { MissionSummaryCard } from "./MissionSummaryCard";
import { fetchMissions, type ManagedMission, type MissionLimits } from "./shared";

export function SellerMissionsClient({ limits }: { limits: MissionLimits }) {
  const t = useTranslations("sellerMissions");
  const [missions, setMissions] = useState<ManagedMission[]>([]);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [createOpen, setCreateOpen] = useState(false);
  const [fundId, setFundId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setMissions(await fetchMissions());
      setState("ready");
    } catch {
      setState((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCreated = useCallback(
    async (id: string) => {
      setCreateOpen(false);
      await reload();
      setFundId(id);
    },
    [reload],
  );

  const onFunded = useCallback(() => {
    void reload();
  }, [reload]);

  // Misiunile din sheet-uri se derivă din listă, ca să reflecte escrow-ul reîncărcat.
  const fundMission = fundId ? missions.find((m) => m.id === fundId) ?? null : null;
  const detailMission = detailId ? missions.find((m) => m.id === detailId) ?? null : null;

  const newButton = (
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus className="h-4 w-4" aria-hidden /> {t("new")}
    </Button>
  );

  return (
    <div className="mx-auto max-w-3xl text-fg">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={newButton} menu={false} sticky={false} tone="transparent" />
      <div className="space-y-3 py-3">
        <p className="rounded-control bg-surface-2 p-3 text-sm text-muted">{t("intro")}</p>
        {state === "loading" ? (
          [0, 1].map((i) => <Skeleton key={i} className="h-56 w-full rounded-card" />)
        ) : state === "error" ? (
          <ErrorState onRetry={() => void reload()} />
        ) : missions.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            action={<Button onClick={() => setCreateOpen(true)}>{t("new")}</Button>}
          />
        ) : (
          missions.map((m) => (
            <MissionSummaryCard key={m.id} mission={m} onFund={(x) => setFundId(x.id)} onOpen={(x) => setDetailId(x.id)} />
          ))
        )}
      </div>

      <CreateMissionSheet open={createOpen} onOpenChange={setCreateOpen} limits={limits} onCreated={(id) => void onCreated(id)} />
      <FundMissionSheet mission={fundMission} onOpenChange={(o) => !o && setFundId(null)} onFunded={onFunded} />
      <MissionDetailSheet mission={detailMission} onOpenChange={(o) => !o && setDetailId(null)} onChanged={onFunded} />
    </div>
  );
}
