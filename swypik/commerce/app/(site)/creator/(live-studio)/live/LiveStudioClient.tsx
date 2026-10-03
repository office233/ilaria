"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleSlash, Plus, Radio } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { CreateStreamSheet } from "@/components/live/studio/CreateStreamSheet";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItem } from "@/components/ui/ListItem";

export type StudioStream = {
  id: string;
  title: string;
  status: "scheduled" | "live" | "ended" | "failed";
  viewer_count: number;
  peak_viewers: number;
  scheduled_at: string | null;
  started_at: string | null;
  created_at: string;
};

const TONE = { live: "danger", scheduled: "warning", ended: "neutral", failed: "neutral" } as const;

/** Lista streamurilor creatorului + „Stream nou”. Transmisia pornește din studio (browser). */
export default function LiveStudioClient({ streams, configured }: { streams: StudioStream[]; configured: boolean }) {
  const t = useTranslations("live.studio");
  const format = useFormatter();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-bold text-fg">
          <Radio className="h-5 w-5 text-danger" aria-hidden />
          {t("listTitle")}
        </h1>
        {configured ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("newStream")}
          </Button>
        ) : null}
      </div>

      {!configured ? (
        <EmptyState icon={CircleSlash} title={t("unconfiguredTitle")} description={t("unconfiguredDescription")} />
      ) : streams.length === 0 ? (
        <EmptyState
          icon={Radio}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={<Button onClick={() => setCreateOpen(true)}>{t("newStream")}</Button>}
        />
      ) : (
        <ul className="space-y-1 rounded-card border border-subtle bg-surface p-1">
          {streams.map((s) => {
            const when = s.started_at || s.scheduled_at || s.created_at;
            return (
              <li key={s.id}>
                <Link href={`/creator/live/${s.id}`} className="block rounded-control focus-visible:outline-none focus-visible:ring-2">
                  <ListItem
                    title={s.title}
                    subtitle={
                      s.status === "ended"
                        ? t("peakViewers", { count: s.peak_viewers })
                        : format.dateTime(new Date(when), { dateStyle: "medium", timeStyle: "short" })
                    }
                    trailing={<Badge tone={TONE[s.status]}>{t(`status.${s.status}`)}</Badge>}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <CreateStreamSheet open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
