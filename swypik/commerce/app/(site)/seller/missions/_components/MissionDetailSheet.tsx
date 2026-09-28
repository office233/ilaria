"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Film } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { CloseMissionDialog } from "./CloseMissionDialog";
import { SubmissionRow } from "./SubmissionRow";
import { canClose, useFormatRon, type ManagedMission, type ManagedSubmission } from "./shared";

type Props = {
  mission: ManagedMission | null;
  onOpenChange: (open: boolean) => void;
  /** Reîncarcă lista (escrow, câștigători) după o acțiune. */
  onChanged: () => void;
};

export function MissionDetailSheet({ mission, onOpenChange, onChanged }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<ManagedSubmission[]>([]);
  const missionId = mission?.id ?? null;

  const load = useCallback(async () => {
    if (!missionId) return;
    setState("loading");
    try {
      const res = await fetch(`/api/seller/missions/${missionId}/submissions`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { submissions?: ManagedSubmission[] };
      setItems(data.submissions ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => {
    void load();
    onChanged();
  };

  const paidWinners = items.filter((s) => s.status === "paid").length;
  const canPickWinner =
    !!mission &&
    mission.status === "active" &&
    mission.fundingStatus === "funded" &&
    paidWinners < (mission.maxWinners ?? 0) &&
    mission.escrowRemainingCents >= mission.prizeCents;

  return (
    <Sheet
      open={mission !== null}
      onOpenChange={onOpenChange}
      title={mission?.title ?? t("detail.title")}
      description={
        mission
          ? t("detail.summary", {
              winners: paidWinners,
              max: mission.maxWinners ?? 0,
              remaining: ron(mission.escrowRemainingCents),
            })
          : undefined
      }
      footer={mission && canClose(mission) ? <CloseMissionDialog mission={mission} onClosed={changed} /> : undefined}
    >
      {mission && !canPickWinner && mission.status === "active" ? (
        <p className="mb-3 rounded-control bg-info-soft p-3 text-sm text-info">{t("detail.noSlots")}</p>
      ) : null}
      {mission && mission.status === "draft" ? (
        <p className="mb-3 rounded-control bg-warning-soft p-3 text-sm text-warning">{t("detail.draftNote")}</p>
      ) : null}
      {state === "loading" ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-control" />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Film} title={t("detail.emptyTitle")} description={t("detail.emptyDescription")} />
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <SubmissionRow
              key={s.id}
              submission={s}
              prizeCents={mission?.prizeCents ?? 0}
              canPickWinner={canPickWinner}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
    </Sheet>
  );
}
