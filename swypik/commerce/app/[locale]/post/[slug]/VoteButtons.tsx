"use client";

import { Check, ShoppingBag } from "lucide-react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { apiErrorMessage } from "@/lib/i18n/api-error";

type Item = {
  optionKey: string;
  label: string;
  voteCount: number;
  imageUrl: string | null;
};

export default function VoteButtons({
  slug,
  items: initial,
}: {
  slug: string;
  items: Item[];
}) {
  const router = useRouter();
  const t = useTranslations("postVote");
  const locale = useLocale();
  const [items, setItems] = useState<Item[]>(initial);
  const [myVote, setMyVote] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const total = items.reduce((s, i) => s + i.voteCount, 0) || 1;

  async function vote(optionKey: string) {
    if (pending) return;
    setError(null);
    setPending(optionKey);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(slug)}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionKey }),
      });
      if (res.status === 401 || res.status === 403) {
        window.location.href = `/account?redirect=/post/${encodeURIComponent(slug)}`;
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessage(json, locale, t("genericError")));
        return;
      }
      setItems((prev) => {
        if (myVote === optionKey) return prev;
        return prev.map((it) => {
          if (it.optionKey === optionKey) return { ...it, voteCount: it.voteCount + 1 };
          if (it.optionKey === myVote) return { ...it, voteCount: Math.max(0, it.voteCount - 1) };
          return it;
        });
      });
      setMyVote(optionKey);
      startTransition(() => router.refresh());
    } catch {
      setError(t("networkError"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {items.map((it) => {
        const pct = Math.round((it.voteCount / total) * 100);
        const isMine = myVote === it.optionKey;
        const isPending = pending === it.optionKey;
        return (
          <button
            key={it.optionKey}
            type="button"
            disabled={isPending}
            onClick={() => vote(it.optionKey)}
            className={`relative w-full rounded-2xl border overflow-hidden text-left transition ${isMine
                ? "border-[#7C3AED] bg-[#7C3AED]/10"
                : "border-white/10 bg-white/[0.04] hover:border-white/30"
              } ${isPending ? "opacity-60" : ""}`}
          >
            <div
              className="absolute inset-y-0 left-0 bg-[#7C3AED]/20 transition-all"
              style={{ width: `${pct}%` }}
            />
            <div className="relative flex items-center gap-3 p-3">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.imageUrl}
                  alt=""
                  className="w-16 h-16 rounded-xl object-cover border border-white/10 flex-shrink-0"
                />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                  <ShoppingBag size={24} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold line-clamp-2">{it.label}</div>
                <div className="mt-1 text-xs text-white/60">
                  {t("votes", { count: it.voteCount })} · {pct}%
                  {isMine ? <span className="ml-2 inline-flex items-center gap-1 text-[#7C3AED]"><Check size={12} /> {t("yourVote")}</span> : null}
                </div>
              </div>
            </div>
          </button>
        );
      })}
      {error ? (
        <p className="text-xs text-red-400 text-center">{error}</p>
      ) : (
        <p className="text-xs text-white/40 text-center">{t("tapToVote")}</p>
      )}
    </div>
  );
}
