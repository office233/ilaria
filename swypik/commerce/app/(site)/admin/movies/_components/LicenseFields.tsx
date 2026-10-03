"use client";
import { useTranslations } from "next-intl";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { LICENSE_LABEL_KEY, LICENSE_TYPES, type LicenseType } from "@/lib/movies/license";

export type LicenseDraft = {
  type: LicenseType;
  attributionText: string;
  sourceUrl: string;
  /** Coduri separate prin virgulă: WORLD, EU sau ISO (RO, MD…). */
  territories: string;
  /** yyyy-mm-dd sau gol. */
  expiresAt: string;
};

export const EMPTY_LICENSE: LicenseDraft = { type: "cc_by", attributionText: "", sourceUrl: "", territories: "WORLD", expiresAt: "" };

export const LICENSE_KEY = LICENSE_LABEL_KEY;

/** Corpul `license` pentru API din ciorna formularului. */
export function licensePayload(d: LicenseDraft) {
  return {
    type: d.type,
    attributionText: d.attributionText.trim() || null,
    sourceUrl: d.sourceUrl.trim() || null,
    territories: d.territories.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    expiresAt: d.expiresAt ? new Date(`${d.expiresAt}T23:59:59Z`).toISOString() : null,
  };
}

/** Câmpurile de licență — comune formularului de ingest și editării unui titlu. */
export default function LicenseFields({ value, onChange }: { value: LicenseDraft; onChange: (next: LicenseDraft) => void }) {
  const t = useTranslations("movies");
  const set = (patch: Partial<LicenseDraft>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold text-fg">{t("ingestLicenseLegend")}</legend>
      <Field label={t("licenseTypeField")} required>
        {(f) => (
          <Select
            {...f}
            value={value.type}
            onChange={(e) => set({ type: e.target.value as LicenseType })}
            options={LICENSE_TYPES.map((l) => ({ value: l, label: t(LICENSE_KEY[l]) }))}
          />
        )}
      </Field>
      <Field label={t("attributionField")} hint={t("attributionHint")}>
        {(f) => <Textarea {...f} rows={3} value={value.attributionText} onChange={(e) => set({ attributionText: e.target.value })} />}
      </Field>
      <TextField label={t("sourceUrlField")} type="url" inputMode="url" value={value.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} />
      <TextField label={t("territoriesField")} hint={t("territoriesHint")} value={value.territories} onChange={(e) => set({ territories: e.target.value })} />
      <TextField label={t("licenseExpiresField")} type="date" value={value.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
    </fieldset>
  );
}
