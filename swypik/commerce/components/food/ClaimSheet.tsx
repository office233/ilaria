"use client";

/** „Revendică afacerea”: formular pentru proprietar → POST /api/merchants/[id]/claim. */
import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Textarea, TextField, Field } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { BadgeCheck } from "lucide-react";
import { readFoodError, useFoodError } from "./useFoodError";

type Props = { open: boolean; onOpenChange: (o: boolean) => void; merchantId: string; merchantName: string; signedIn: boolean; returnPath: string };

export default function ClaimSheet({ open, onOpenChange, merchantId, merchantName, signedIn, returnPath }: Props) {
  const t = useTranslations("foodHub");
  const errorText = useFoodError();
  const [form, setForm] = useState({ contact_name: "", contact_phone: "", contact_email: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = form.contact_name.trim().length >= 2 && form.contact_phone.trim().length >= 5;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/merchants/${merchantId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        setError(errorText(await readFoodError(res)));
        return;
      }
      setDone(true);
    } catch {
      setError(errorText("server_error"));
    } finally {
      setBusy(false);
    }
  }

  const loginHref = `/auth/login?next=${encodeURIComponent(returnPath)}`;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("claimTitle", { name: merchantName })}
      description={done ? undefined : t("claimSub")}
      footer={
        done ? null : signedIn ? (
          <Button block loading={busy} disabled={!valid} onClick={() => void submit()}>{t("claimSubmit")}</Button>
        ) : (
          <Button asChild block><Link href={loginHref}>{t("claimSignIn")}</Link></Button>
        )
      }
    >
      {done ? (
        <EmptyState icon={BadgeCheck} title={t("claimSent")} description={t("claimSentSub")} />
      ) : signedIn ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
          <TextField label={t("claimName")} value={form.contact_name} onChange={set("contact_name")} autoComplete="name" maxLength={120} required />
          <TextField label={t("phoneLabel")} value={form.contact_phone} onChange={set("contact_phone")} type="tel" inputMode="tel" autoComplete="tel" maxLength={32} required />
          <TextField label={t("claimEmail")} value={form.contact_email} onChange={set("contact_email")} type="email" autoComplete="email" maxLength={254} />
          <Field label={t("claimMessage")}>
            {(f) => <Textarea {...f} value={form.message} onChange={set("message")} maxLength={1000} placeholder={t("claimMessagePlaceholder")} />}
          </Field>
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
        </form>
      ) : (
        <p className="text-sm text-muted">{t("claimSignInSub")}</p>
      )}
    </Sheet>
  );
}
