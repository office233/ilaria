"use client";

import { useEffect, useState } from "react";
import { Target, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { pickerApi, type MissionDto } from "@/lib/upload/api";

type Loaded = { missions: MissionDto[]; joined: Set<string> };

/**
 * „Participă la o misiune”: lista vine din GET /api/missions/active, iar
 * alegerea (uuid sau null) pleacă la publicare ca `missionId` în
 * PATCH /api/creator/videos/[id]. Fără misiuni active și fără o alegere
 * existentă, secțiunea nu apare deloc.
 */
export function MissionPicker(props: { missionId: string | null; onChange: (missionId: string | null) => void }) {
  const t = useTranslations("videoUpload.mission");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);

  useEffect(() => {
    let alive = true;
    pickerApi
      .missions()
      .then((r) => alive && setData({ missions: r.missions, joined: new Set(r.joinedMissionIds) }))
      .catch(() => alive && setData({ missions: [], joined: new Set() }));
    return () => {
      alive = false;
    };
  }, []);

  if (data !== null && data.missions.length === 0 && !props.missionId) return null;
  const selected = data?.missions.find((m) => m.id === props.missionId);

  return (
    <>
      {props.missionId ? (
        <ListItem
          icon={Target}
          title={selected?.title ?? (data ? t("unavailable") : t("loading"))}
          subtitle={t("selectedHint")}
          trailing={
            <IconButton label={t("remove")} onClick={() => props.onChange(null)}>
              <X aria-hidden />
            </IconButton>
          }
        />
      ) : (
        <ListItem icon={Target} title={t("add")} subtitle={t("addHint")} onClick={() => setOpen(true)} />
      )}
      <Sheet open={open} onOpenChange={setOpen} title={t("sheetTitle")}>
        {data === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : data.missions.length === 0 ? (
          <EmptyState icon={Target} title={t("empty")} />
        ) : (
          <div className="divide-y divide-subtle">
            {data.missions.map((m) => (
              <ListItem
                key={m.id}
                icon={Target}
                title={m.title}
                subtitle={data.joined.has(m.id) ? t("joined") : undefined}
                active={m.id === props.missionId}
                onClick={() => {
                  props.onChange(m.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}
