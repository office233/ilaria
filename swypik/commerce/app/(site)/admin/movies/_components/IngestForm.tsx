"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { TITLE_FORMATS, type TitleFormat } from "@/lib/movies/license";
import LicenseFields, { EMPTY_LICENSE, licensePayload, type LicenseDraft } from "./LicenseFields";
import { blockerKey } from "./blockers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const FORMAT_KEY: Record<TitleFormat, "formatSeries" | "formatFilm"> = { series: "formatSeries", film: "formatFilm" };

type Draft = { title: string; synopsis: string; format: TitleFormat; posterUrl: string; coverUrl: string; mediaUrl: string; isAdult: boolean };
const EMPTY: Draft = { title: "", synopsis: "", format: "film", posterUrl: "", coverUrl: "", mediaUrl: "", isAdult: false };

/**
 * Ingest de titlu licențiat: metadate + licență (obligatorie) + fișierul video
 * opțional (https, intră în transcodare ca episodul 1). Titlul se creează ca
 * ciornă pe contul oficial; publicarea e un pas separat, blocat până când
 * licența și episoadele sunt complete.
 */
export default function IngestForm({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations("movies");
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [license, setLicense] = useState<LicenseDraft>(EMPTY_LICENSE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/movies", {
        method: "POST",
        credentials: "same-origin",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: draft.title,
          synopsis: draft.synopsis,
          format: draft.format,
          posterUrl: draft.posterUrl.trim() || null,
          coverUrl: draft.coverUrl.trim() || null,
          mediaUrl: draft.mediaUrl.trim() || null,
          isAdult: draft.isAdult,
          license: licensePayload(license),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail ? `${t("ingestInvalid")} (${data.detail})` : t("error"));
        return;
      }
      const blockers: string[] = data.publishBlockers ?? [];
      toast({
        title: t("ingestCreated"),
        description: blockers.length ? blockers.map((b) => t(blockerKey(b))).join(" · ") : undefined,
        tone: blockers.length ? "info" : "success",
      });
      setDraft(EMPTY);
      setLicense(EMPTY_LICENSE);
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h2 className="text-base font-semibold text-fg">{t("ingestTitle")}</h2>
        <p className="text-sm text-muted">{t("ingestIntro")}</p>
        <TextField label={t("seriesTitle")} required minLength={2} maxLength={120} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        <Field label={t("seriesSynopsis")}>
          {(f) => <Textarea {...f} rows={3} value={draft.synopsis} onChange={(e) => set({ synopsis: e.target.value })} />}
        </Field>
        <Field label={t("formatField")}>
          {(f) => (
            <Select {...f} value={draft.format} onChange={(e) => set({ format: e.target.value as TitleFormat })} options={TITLE_FORMATS.map((x) => ({ value: x, label: t(FORMAT_KEY[x]) }))} />
          )}
        </Field>
        <TextField label={t("posterUrl")} type="url" inputMode="url" value={draft.posterUrl} onChange={(e) => set({ posterUrl: e.target.value })} />
        <TextField label={t("coverUrl")} type="url" inputMode="url" value={draft.coverUrl} onChange={(e) => set({ coverUrl: e.target.value })} />
        <TextField label={t("mediaUrlField")} hint={t("mediaUrlHint")} type="url" inputMode="url" value={draft.mediaUrl} onChange={(e) => set({ mediaUrl: e.target.value })} />
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-fg">
          {t("isAdultField")}
          <Switch checked={draft.isAdult} onCheckedChange={(v) => set({ isAdult: v })} aria-label={t("isAdultField")} />
        </label>
        <LicenseFields value={license} onChange={setLicense} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" block loading={busy}>{t("ingestSubmit")}</Button>
      </form>
    </Card>
  );
}
