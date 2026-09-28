"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/ui/cn";
import { useShopError } from "../useShopError";

type Props = {
  productId: string;
  productTitle?: string;
  /** Butonul care deschide formularul. */
  trigger: ReactNode;
  onSubmitted?: () => void;
};

/** Formular de recenzie într-un bottom sheet (doar cumpărători verificați — serverul verifică). */
export function ReviewFormSheet({ productId, productTitle, trigger, onSubmitted }: Props) {
  const t = useTranslations("shopBuyer.reviews");
  const { toast } = useToast();
  const errorMessage = useShopError();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rating < 1) {
      setError(t("pickRating"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${productId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rating, title: title.trim() || null, body: body.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessage(data));
        return;
      }
      setOpen(false);
      setRating(0);
      setTitle("");
      setBody("");
      toast({ title: t("thanks"), tone: "success" });
      onSubmitted?.();
    } catch {
      setError(errorMessage({ code: "network" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={t("write")}
      description={productTitle}
      footer={
        <Button type="submit" form={`review-${productId}`} block size="lg" loading={busy}>
          {t("submit")}
        </Button>
      }
    >
      <form id={`review-${productId}`} onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg">{t("ratingLabel")}</legend>
          <div role="radiogroup" aria-label={t("ratingLabel")} className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={t("starsLabel", { n })}
                onClick={() => setRating(n)}
                className="flex h-11 w-11 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2"
              >
                <Star aria-hidden className={cn("h-8 w-8", n <= rating ? "fill-warning text-warning" : "text-fg-subtle/40")} />
              </button>
            ))}
          </div>
        </fieldset>
        <Field label={t("titleLabel")}>
          {(f) => <Input {...f} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label={t("bodyLabel")}>
          {(f) => <Textarea {...f} value={body} rows={4} maxLength={4000} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
