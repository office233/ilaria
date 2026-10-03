"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { postJson, useErrorMessage, useFormatRon, type MissionLimits } from "./shared";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: MissionLimits;
  onCreated: (id: string) => void;
};

type ProductOption = { id: string; title: string | null };
type Errors = Partial<Record<"title" | "brief" | "prize" | "winners" | "duration" | "form", string>>;

const FORM_ID = "seller-mission-create";

export function CreateMissionSheet({ open, onOpenChange, limits, onCreated }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const errorMessage = useErrorMessage();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [formatHint, setFormatHint] = useState("");
  const [productId, setProductId] = useState("");
  const [prize, setPrize] = useState(String(limits.minPrizeCents / 100));
  const [winners, setWinners] = useState("1");
  const [duration, setDuration] = useState(String(Math.min(14, limits.maxDurationDays)));
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/seller/products?limit=100", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { products: [] }))
      .then((d: { products?: ProductOption[] }) => {
        if (!cancelled) setProducts(d.products ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const prizeCents = Math.round(Number(prize.replace(",", ".")) * 100);
  const winnersN = Math.trunc(Number(winners));
  const durationN = Math.trunc(Number(duration));
  const poolCents = Number.isFinite(prizeCents * winnersN) && prizeCents > 0 && winnersN > 0 ? prizeCents * winnersN : 0;

  const validate = (): Errors => {
    const e: Errors = {};
    if (title.trim().length < 5 || title.trim().length > 120) e.title = t("form.titleError");
    if (brief.trim().length < 20 || brief.trim().length > 2000) e.brief = t("form.briefError");
    if (!Number.isFinite(prizeCents) || prizeCents < limits.minPrizeCents || prizeCents > limits.maxPrizeCents) {
      e.prize = t("form.prizeHint", { min: ron(limits.minPrizeCents), max: ron(limits.maxPrizeCents) });
    }
    if (!Number.isInteger(winnersN) || winnersN < 1 || winnersN > limits.maxWinners) {
      e.winners = t("form.winnersHint", { max: limits.maxWinners });
    }
    if (!Number.isInteger(durationN) || durationN < limits.minDurationDays || durationN > limits.maxDurationDays) {
      e.duration = t("form.durationHint", { min: limits.minDurationDays, max: limits.maxDurationDays });
    }
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy(true);
    const { ok, data } = await postJson<{ id?: string }>("/api/seller/missions", {
      title: title.trim(),
      brief: brief.trim(),
      formatHint: formatHint.trim() || null,
      productId: productId || null,
      prizeCents,
      maxWinners: winnersN,
      durationDays: durationN,
    });
    setBusy(false);
    if (!ok || !data.id) {
      setErrors({ form: errorMessage(data.error) });
      return;
    }
    setTitle("");
    setBrief("");
    setFormatHint("");
    setProductId("");
    onCreated(data.id);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("form.title")}
      description={t("form.description")}
      footer={
        <div className="space-y-2">
          {errors.form ? <p className="text-sm font-medium text-danger" role="alert">{errors.form}</p> : null}
          <Button type="submit" form={FORM_ID} block loading={busy}>
            {t("form.submit", { amount: ron(poolCents) })}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="space-y-4" noValidate>
        <TextField label={t("form.nameLabel")} value={title} maxLength={120} required error={errors.title}
          onChange={(e) => setTitle(e.target.value)} />
        <Field label={t("form.briefLabel")} hint={t("form.briefHelp")} error={errors.brief} required>
          {(f) => <Textarea {...f} value={brief} maxLength={2000} rows={5} onChange={(e) => setBrief(e.target.value)} />}
        </Field>
        <TextField label={t("form.formatLabel")} hint={t("form.formatHelp")} value={formatHint} maxLength={60}
          onChange={(e) => setFormatHint(e.target.value)} />
        <Field label={t("form.productLabel")} hint={t("form.productHelp")}>
          {(f) => (
            <Select {...f} value={productId} onChange={(e) => setProductId(e.target.value)}
              options={[{ value: "", label: t("form.noProduct") }, ...products.map((p) => ({ value: p.id, label: p.title ?? p.id }))]} />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <TextField label={t("form.prizeLabel")} inputMode="decimal" value={prize} error={errors.prize} required
            hint={t("form.prizeHint", { min: ron(limits.minPrizeCents), max: ron(limits.maxPrizeCents) })}
            onChange={(e) => setPrize(e.target.value)} />
          <TextField label={t("form.winnersLabel")} type="number" min={1} max={limits.maxWinners} value={winners}
            error={errors.winners} required hint={t("form.winnersHint", { max: limits.maxWinners })}
            onChange={(e) => setWinners(e.target.value)} />
        </div>
        <TextField label={t("form.durationLabel")} type="number" min={limits.minDurationDays} max={limits.maxDurationDays}
          value={duration} error={errors.duration} required
          hint={t("form.durationHint", { min: limits.minDurationDays, max: limits.maxDurationDays })}
          onChange={(e) => setDuration(e.target.value)} />
        <p className="rounded-control bg-surface-2 p-3 text-sm text-muted">
          {t("form.poolSummary", { amount: ron(poolCents), count: winnersN > 0 ? winnersN : 0 })}
        </p>
      </form>
    </Sheet>
  );
}
