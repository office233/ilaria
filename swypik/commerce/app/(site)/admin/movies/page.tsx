"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TextField } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import type { SeriesStatus } from "@/lib/movies/types";
import IngestForm from "./_components/IngestForm";
import SeriesAdminCard, { type AdminSeriesRow } from "./_components/SeriesAdminCard";

type Publisher = { user_id: string; display_name: string | null; username: string | null; email: string | null };
const STATUSES: SeriesStatus[] = ["pending_review", "draft", "published", "archived"];
const REQUEST_OPTS: RequestInit = { credentials: "same-origin", headers: { "Content-Type": "application/json" } };
const STATUS_KEY: Record<SeriesStatus, "statusDraft" | "statusPendingReview" | "statusPublished" | "statusArchived"> = {
  draft: "statusDraft",
  pending_review: "statusPendingReview",
  published: "statusPublished",
  archived: "statusArchived",
};

export default function AdminMoviesPage() {
  const t = useTranslations("movies");
  const { toast } = useToast();
  const [status, setStatus] = useState<SeriesStatus>("pending_review");
  const [rows, setRows] = useState<AdminSeriesRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [newPublisher, setNewPublisher] = useState("");

  const load = useCallback(() => {
    setFailed(false);
    fetch(`/api/admin/movies?status=${status}`, REQUEST_OPTS)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setRows(d.series ?? []))
      .catch(() => setFailed(true));
    fetch("/api/admin/movies/publishers", REQUEST_OPTS)
      .then((r) => r.json())
      .then((d) => setPublishers(d.publishers ?? []))
      .catch(() => undefined);
  }, [status]);
  useEffect(load, [load]);

  const changed = (msg: string) => { toast({ title: msg, tone: "success" }); load(); };

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/admin/movies/publishers", { ...REQUEST_OPTS, method: "POST", body: JSON.stringify({ userId: newPublisher.trim() }) });
    toast({ title: res.ok ? t("saved") : t("error"), tone: res.ok ? "success" : "danger" });
    if (res.ok) { setNewPublisher(""); load(); }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-6">
      <h1 className="flex items-center gap-2 text-xl font-bold text-fg"><Clapperboard className="h-5 w-5" aria-hidden /> {t("adminTitle")}</h1>
      <p className="rounded-card bg-info-soft p-3 text-sm text-info">{t("cnaAdminNotice")}</p>

      <IngestForm onCreated={() => { setStatus("draft"); load(); }} />

      <Tabs value={status} onValueChange={(v) => setStatus(v as SeriesStatus)}>
        <TabsList variant="pill">
          {STATUSES.map((s) => <TabsTrigger key={s} value={s}>{t(STATUS_KEY[s])}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      {failed ? (
        <ErrorState onRetry={load} />
      ) : rows === null ? (
        <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28 w-full rounded-card" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Clapperboard} title={t("adminEmpty")} />
      ) : (
        <div className="space-y-3">{rows.map((r) => <SeriesAdminCard key={r.id} row={r} onChanged={changed} />)}</div>
      )}

      <Card className="space-y-3">
        <h2 className="font-semibold text-fg">{t("publishers")}</h2>
        <ul className="space-y-1 text-sm text-fg">
          {publishers.map((p) => (
            <li key={p.user_id}>{p.display_name ?? p.username ?? p.email} <span className="text-xs text-subtle">{p.user_id}</span></li>
          ))}
        </ul>
        <form onSubmit={approve} className="space-y-2">
          <TextField label={t("approvePublisher")} value={newPublisher} onChange={(e) => setNewPublisher(e.target.value)} />
          <Button type="submit" variant="secondary">{t("approveSubmit")}</Button>
        </form>
      </Card>
    </div>
  );
}
