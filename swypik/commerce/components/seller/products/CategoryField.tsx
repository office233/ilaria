"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";
import { cn } from "@/lib/ui/cn";
import { sellerApi } from "@/components/seller/api";

type Suggestion = { slug: string; confidence: number; label: string };
type Props = {
  title: string;
  description: string;
  category: string;
  taxonomySlug: string;
  onChange: (v: { category: string; taxonomySlug: string }) => void;
};

/** Categoria: text liber + sugestii AI din taxonomie (/api/seller/products/classify). */
export function CategoryField({ title, description, category, taxonomySlug, onChange }: Props) {
  const t = useTranslations("sellerPanel.products.editor");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function classify() {
    setBusy(true);
    setError(null);
    const res = await sellerApi<{ suggestions?: Suggestion[] }>("/api/seller/products/classify", {
      method: "POST",
      body: { title, description: description || undefined },
    });
    setBusy(false);
    if (!res.ok) {
      setError(t("classifyError"));
      return;
    }
    const list = res.data.suggestions ?? [];
    setSuggestions(list);
    if (list[0] && !taxonomySlug) onChange({ category: list[0].label, taxonomySlug: list[0].slug });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label={t("category")}
          value={category}
          onChange={(e) => onChange({ category: e.target.value, taxonomySlug: "" })}
        />
        <Button type="button" variant="secondary" loading={busy} disabled={title.trim().length < 3} onClick={() => void classify()}>
          <Sparkles className="h-4 w-4" aria-hidden /> {t("suggest")}
        </Button>
      </div>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s.slug}
              type="button"
              aria-pressed={s.slug === taxonomySlug}
              onClick={() => onChange({ category: s.label, taxonomySlug: s.slug })}
              className={cn(
                "min-h-9 rounded-full px-3 text-xs font-semibold",
                s.slug === taxonomySlug ? "bg-brand text-brand-fg" : "border border-subtle bg-surface text-muted",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
