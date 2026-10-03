"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { AdminNewsRow, AdminNewsStatus } from "@/lib/news/admin-types";
import { plainSummary, sourceLabel } from "@/lib/news/text";

const ACTIONS: Record<AdminNewsStatus, AdminNewsStatus[]> = {
  draft: ["published", "archived"],
  published: ["archived", "draft"],
  archived: ["draft"],
};

/** One article in the review queue: source link (to fact-check), summary, status actions. */
export default function NewsAdminCard({ row, onChangeStatus }: { row: AdminNewsRow; onChangeStatus: (id: string, s: AdminNewsStatus) => Promise<void> }) {
  const t = useTranslations("adminNews");
  const format = useFormatter();
  const [busy, setBusy] = useState<AdminNewsStatus | null>(null);

  const act = async (s: AdminNewsStatus) => {
    setBusy(s);
    try {
      await onChangeStatus(row.id, s);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        <Badge size="sm">{row.category_slug}</Badge>
        <span>{format.dateTime(new Date(row.created_at), { dateStyle: "medium", timeStyle: "short" })}</span>
        {row.ai_model_name ? <span>{row.ai_model_name}</span> : null}
      </div>
      <p className="font-semibold text-fg">{row.title}</p>
      <p className="text-sm text-muted">{plainSummary(row.summary_tldr, 280)}</p>
      {row.source_url ? (
        <a href={row.source_url} target="_blank" rel="noopener nofollow noreferrer" className="flex min-h-11 items-center gap-2 text-sm font-semibold text-brand">
          <ExternalLink className="h-4 w-4" aria-hidden /> {sourceLabel(row.source_name, row.source_url)}
        </a>
      ) : (
        <p className="text-sm text-danger">{t("noSource")}</p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {ACTIONS[row.status].map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === "published" ? "primary" : s === "archived" ? "danger" : "secondary"}
            loading={busy === s}
            disabled={busy !== null || (s === "published" && !row.source_url)}
            onClick={() => act(s)}
          >
            {t(`action.${s}`)}
          </Button>
        ))}
      </div>
    </Card>
  );
}
