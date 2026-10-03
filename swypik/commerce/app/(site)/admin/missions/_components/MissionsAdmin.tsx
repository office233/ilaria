"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trophy } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { MissionCard } from "./MissionCard";
import { CreateMissionSheet } from "./CreateMissionSheet";
import { MissionDetailSheet } from "./MissionDetailSheet";
import { errorKey, type AdminMission, type MissionLimits } from "./shared";

const FILTERS = ["all", "active", "draft", "closed", "archived"] as const;
type Filter = (typeof FILTERS)[number];

/** Admin — toate misiunile (selleri + platformă), escrow, jurizare. */
export function MissionsAdmin({ limits }: { limits: MissionLimits }) {
  const t = useTranslations("adminMissions");
  const [filter, setFilter] = useState<Filter>("all");
  const [missions, setMissions] = useState<AdminMission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { keep?: boolean } = {}) => {
      if (!opts.keep) setMissions(null);
      setError(null);
      try {
        const qs = filter === "all" ? "" : `?status=${filter}`;
        const res = await fetch(`/api/admin/missions${qs}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as { missions?: AdminMission[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? "generic");
        setMissions(data.missions ?? []);
      } catch (e) {
        setError(t(errorKey(e instanceof Error ? e.message : null)));
      }
    },
    [filter, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const selected = missions?.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        menu={false}
        actions={
          <Button size="sm" className="min-h-11 sm:min-h-9" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden className="h-4 w-4" />
            <span className="hidden sm:inline">{t("newPlatformMission")}</span>
            <span className="sm:hidden">{t("newShort")}</span>
          </Button>
        }
      >
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            {FILTERS.map((f) => (
              <TabsTrigger key={f} value={f}>
                {t(`filter.${f}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageHeader>

      <div className="mx-auto max-w-5xl px-gutter py-4">
        {error ? (
          <ErrorState description={error} onRetry={() => void load()} />
        ) : missions === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-card" />
            ))}
          </div>
        ) : missions.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title={t("empty")}
            description={t("emptyHint")}
            action={<Button onClick={() => setCreateOpen(true)}>{t("newPlatformMission")}</Button>}
          />
        ) : (
          <ul className="space-y-3">
            {missions.map((m) => (
              <li key={m.id}>
                <MissionCard mission={m} onOpen={() => setSelectedId(m.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateMissionSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        limits={limits}
        onCreated={() => void load({ keep: true })}
      />
      <MissionDetailSheet
        mission={selected}
        onOpenChange={(open) => (open ? undefined : setSelectedId(null))}
        onChanged={() => void load({ keep: true })}
      />
    </div>
  );
}
