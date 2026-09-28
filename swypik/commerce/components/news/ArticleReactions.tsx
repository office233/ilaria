"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Flame, Lightbulb, Rocket } from "lucide-react";
import { cn } from "@/lib/ui/cn";

const REACTIONS = [
  { type: "fire", icon: Flame },
  { type: "insightful", icon: Lightbulb },
  { type: "rocket", icon: Rocket },
] as const;

export default function ArticleReactions({ slug }: { slug: string }) {
  const t = useTranslations("news");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [mine, setMine] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/news/${encodeURIComponent(slug)}/reactions`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setCounts(d.counts || {});
          setMine(d.mine || []);
        }
      })
      .catch(() => null);
  }, [slug]);

  const toggle = async (type: string) => {
    const already = mine.includes(type);
    const rollback = { counts, mine };
    setMine((prev) => (already ? prev.filter((r) => r !== type) : [...prev, type]));
    setCounts((prev) => ({ ...prev, [type]: Math.max(0, (prev[type] || 0) + (already ? -1 : 1)) }));
    try {
      const res = already
        ? await fetch(`/api/news/${encodeURIComponent(slug)}/reactions?reaction_type=${type}`, { method: "DELETE" })
        : await fetch(`/api/news/${encodeURIComponent(slug)}/reactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reaction_type: type }),
          });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setCounts(rollback.counts);
      setMine(rollback.mine);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {REACTIONS.map(({ type, icon: Icon }) => {
        const active = mine.includes(type);
        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            aria-label={t(`reactions.${type}`)}
            onClick={() => toggle(type)}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors duration-fast",
              active ? "border-brand bg-brand-soft text-brand-soft-fg" : "border-subtle bg-surface text-muted hover:bg-surface-2",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden /> {counts[type] || 0}
          </button>
        );
      })}
    </div>
  );
}
