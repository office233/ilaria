"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Input";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { licenseProblems } from "@/lib/movies/license";
import type { MovieSeriesRow } from "@/lib/movies/types";
import LicenseFields, { LICENSE_KEY, licensePayload, type LicenseDraft } from "./LicenseFields";
import { blockerKey } from "./blockers";

export type AdminSeriesRow = MovieSeriesRow & { episode_count: number; owner_name: string | null };
type Panel = "none" | "episode" | "license";
const JSON_OPTS: RequestInit = { credentials: "same-origin", headers: { "Content-Type": "application/json" } };

function draftFrom(s: AdminSeriesRow): LicenseDraft {
  return {
    type: s.license_type ?? "cc_by",
    attributionText: s.attribution_text ?? "",
    sourceUrl: s.license_source_url ?? "",
    territories: s.license_territories.join(", "),
    expiresAt: s.license_expires_at ? s.license_expires_at.slice(0, 10) : "",
  };
}

/** Un titlu în lista admin: stare, licență, publicare, atașare episod. Se stivuiește pe mobil. */
export default function SeriesAdminCard({ row, onChanged }: { row: AdminSeriesRow; onChanged: (msg: string) => void }) {
  const t = useTranslations("movies");
  const formatPrice = useFormatPrice();
  const [panel, setPanel] = useState<Panel>("none");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [episode, setEpisode] = useState({ title: "", mediaUrl: "", videoId: "" });
  const [license, setLicense] = useState<LicenseDraft>(() => draftFrom(row));
  // Serverul reverifică la publicare; aici doar arătăm din timp ce lipsește.
  const blockers = licenseProblems(row);

  const call = async (url: string, method: string, body: unknown) => {
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch(url, { ...JSON_OPTS, method, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(Array.isArray(d.blockers) ? d.blockers : [typeof d.error === "string" ? d.error : "error"]);
        return false;
      }
      onChanged(t("saved"));
      return true;
    } finally {
      setBusy(false);
    }
  };

  const attach = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = episode.videoId.trim() ? { title: episode.title, videoId: episode.videoId.trim() } : { title: episode.title, mediaUrl: episode.mediaUrl.trim() };
    if (await call(`/api/admin/movies/${row.id}/episodes`, "POST", body)) {
      setEpisode({ title: "", mediaUrl: "", videoId: "" });
      setPanel("none");
    }
  };
  const saveLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await call(`/api/admin/movies/${row.id}`, "PATCH", { license: licensePayload(license) })) setPanel("none");
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg">{row.title}</p>
          <p className="text-xs text-muted">{row.owner_name ?? row.owner_user_id.slice(0, 8)} · {t("episodes", { count: row.episode_count })} · {row.episode_price_cents !== null ? formatPrice(row.episode_price_cents, { sourceCurrency: "RON" }) : t("free")}</p>
        </div>
        {row.license_type ? <Badge tone={blockers.length ? "warning" : "success"}>{t(LICENSE_KEY[row.license_type])}</Badge> : <Badge tone="danger">{t("noLicense")}</Badge>}
      </div>
      {blockers.length > 0 && <p className="text-xs text-warning">{blockers.map((b) => t(blockerKey(b))).join(" · ")}</p>}
      {errors.length > 0 && <p role="alert" className="text-sm text-danger">{errors.map((b) => t(blockerKey(b))).join(" · ")}</p>}
      <div className="flex flex-wrap gap-2">
        {row.status !== "published" && <Button size="sm" loading={busy} onClick={() => call(`/api/admin/movies/${row.id}`, "PATCH", { status: "published" })}>{t("publish")}</Button>}
        {row.status === "published" && <Button size="sm" variant="secondary" loading={busy} onClick={() => call(`/api/admin/movies/${row.id}`, "PATCH", { status: "archived" })}>{t("archive")}</Button>}
        {row.status !== "draft" && <Button size="sm" variant="ghost" loading={busy} onClick={() => call(`/api/admin/movies/${row.id}`, "PATCH", { status: "draft" })}>{t("backToDraft")}</Button>}
        <Button size="sm" variant="soft" onClick={() => setPanel(panel === "episode" ? "none" : "episode")}>{t("addEpisode")}</Button>
        <Button size="sm" variant="soft" onClick={() => setPanel(panel === "license" ? "none" : "license")}>{t("editLicense")}</Button>
      </div>
      {panel === "episode" && (
        <form onSubmit={attach} className="space-y-2">
          <TextField label={t("episodeTitle")} required value={episode.title} onChange={(e) => setEpisode({ ...episode, title: e.target.value })} />
          <TextField label={t("mediaUrlField")} type="url" value={episode.mediaUrl} onChange={(e) => setEpisode({ ...episode, mediaUrl: e.target.value })} />
          <TextField label={t("videoIdField")} hint={t("videoIdHint")} value={episode.videoId} onChange={(e) => setEpisode({ ...episode, videoId: e.target.value })} />
          <Button type="submit" block loading={busy}>{t("addEpisode")}</Button>
        </form>
      )}
      {panel === "license" && (
        <form onSubmit={saveLicense} className="space-y-2">
          <LicenseFields value={license} onChange={setLicense} />
          <Button type="submit" block loading={busy}>{t("save")}</Button>
        </form>
      )}
    </Card>
  );
}
