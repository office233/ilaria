"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { errorKey, postJson, useFormatters, type MissionLimits } from "./shared";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: MissionLimits;
  onCreated: () => void;
};

type Errors = Partial<Record<"title" | "brief" | "prize" | "winners" | "duration", string>>;

const FORM_ID = "admin-create-mission";

/** Formular: misiune finanțată de platformă (activă imediat). */
export function CreateMissionSheet({ open, onOpenChange, limits, onCreated }: Props) {
  const t = useTranslations("adminMissions");
  const f = useFormatters();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [formatHint, setFormatHint] = useState("");
  const [prize, setPrize] = useState("");
  const [winners, setWinners] = useState("1");
  const [duration, setDuration] = useState(String(Math.min(14, limits.maxDurationDays)));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError(null);
  }, [open]);

  const prizeCents = Math.round(Number(prize.replace(",", ".")) * 100);
  const winnersN = Number(winners);
  const durationN = Number(duration);
  const poolCents = Number.isFinite(prizeCents) && Number.isInteger(winnersN) ? prizeCents * winnersN : 0;

  function validate(): Errors {
    const e: Errors = {};
    const tl = title.trim().length;
    if (tl < 5 || tl > 120) e.title = t("form.errTitle", { min: 5, max: 120 });
    const bl = brief.trim().length;
    if (bl < 20 || bl > 2000) e.brief = t("form.errBrief", { min: 20, max: 2000 });
    if (!Number.isFinite(prizeCents) || prizeCents < limits.minPrizeCents || prizeCents > limits.maxPrizeCents) {
      e.prize = t("form.errPrize", { min: f.money(limits.minPrizeCents), max: f.money(limits.maxPrizeCents) });
    }
    if (!Number.isInteger(winnersN) || winnersN < 1 || winnersN > limits.maxWinners) {
      e.winners = t("form.errWinners", { max: limits.maxWinners });
    }
    if (!Number.isInteger(durationN) || durationN < limits.minDurationDays || durationN > limits.maxDurationDays) {
      e.duration = t("form.errDuration", { min: limits.minDurationDays, max: limits.maxDurationDays });
    }
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await postJson<{ id: string; slug: string }>("/api/admin/missions", {
        title: title.trim(),
        brief: brief.trim(),
        formatHint: formatHint.trim() || null,
        prizeCents,
        maxWinners: winnersN,
        durationDays: durationN,
      });
      toast({ title: t("form.created"), tone: "success" });
      setTitle("");
      setBrief("");
      setFormatHint("");
      setPrize("");
      setWinners("1");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setFormError(t(errorKey(err instanceof Error ? err.message : null)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}
      title={t("form.title")}
      description={t("form.description")}
      footer={
        <Button type="submit" form={FORM_ID} block loading={busy} disabled={busy}>
          {t("form.submit", { pool: f.money(poolCents > 0 ? poolCents : 0) })}
        </Button>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate className="space-y-4">
        <TextField
          label={t("form.titleLabel")}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          required
        />
        <Field label={t("form.briefLabel")} hint={t("form.briefHint")} error={errors.brief} required>
          {(fp) => (
            <Textarea {...fp} value={brief} rows={5} maxLength={2000} onChange={(e) => setBrief(e.target.value)} />
          )}
        </Field>
        <TextField
          label={t("form.formatLabel")}
          hint={t("form.formatHint")}
          value={formatHint}
          maxLength={60}
          onChange={(e) => setFormatHint(e.target.value)}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label={t("form.prizeLabel")}
            hint={t("form.prizeHint", { min: f.money(limits.minPrizeCents), max: f.money(limits.maxPrizeCents) })}
            inputMode="decimal"
            value={prize}
            onChange={(e) => setPrize(e.target.value)}
            error={errors.prize}
            required
          />
          <TextField
            label={t("form.winnersLabel")}
            hint={t("form.winnersHint", { max: limits.maxWinners })}
            type="number"
            inputMode="numeric"
            min={1}
            max={limits.maxWinners}
            value={winners}
            onChange={(e) => setWinners(e.target.value)}
            error={errors.winners}
            required
          />
          <TextField
            label={t("form.durationLabel")}
            hint={t("form.durationHint", { min: limits.minDurationDays, max: limits.maxDurationDays })}
            type="number"
            inputMode="numeric"
            min={limits.minDurationDays}
            max={limits.maxDurationDays}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            error={errors.duration}
            required
          />
        </div>
        <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">{t("form.platformNote")}</p>
        {formError ? (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
