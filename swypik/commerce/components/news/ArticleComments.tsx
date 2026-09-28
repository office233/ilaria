"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Ban, Flag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

interface CommentItem {
  id: string;
  content: string;
  createdAt: string;
  author: { displayName: string | null; username: string | null; avatarUrl?: string | null };
  isOwn?: boolean;
}

const MAX_LEN = 2000;

export default function ArticleComments({ slug }: { slug: string }) {
  const t = useTranslations("news");
  const format = useFormatter();
  const base = `/api/news/${encodeURIComponent(slug)}/comments`;
  const [items, setItems] = useState<CommentItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { toast } = useToast();

  const reload = useCallback(() => {
    fetch(base)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.items)) {
          setItems(d.items);
          setHasMore(Boolean(d.hasMore));
        }
      })
      .catch(() => null);
  }, [base]);
  useEffect(reload, [reload]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const d = await fetch(`${base}?offset=${items.length}`).then((r) => r.json());
      if (d.ok && Array.isArray(d.items)) {
        const seen = new Set(items.map((c) => c.id));
        setItems((prev) => [...prev, ...(d.items as CommentItem[]).filter((c) => !seen.has(c.id))]);
        setHasMore(Boolean(d.hasMore));
      }
    } catch {
      setError(t("comments.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (content.length < 2) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setError(
          d.error === "unauthorized" ? t("comments.loginRequired") : d.error === "comment_blocked" ? t("comments.blocked") : t("comments.error"),
        );
        return;
      }
      setText("");
      // Marcat de Content Safety pentru revizuire: nu apare încă public.
      if (d.pending) {
        setNotice(t("comments.pendingReview"));
        return;
      }
      setItems((prev) => [{ id: d.id, content, createdAt: d.createdAt, author: { displayName: t("comments.you"), username: null }, isOwn: true }, ...prev]);
    } catch {
      setError(t("comments.error"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const snapshot = items;
    setItems((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(`${base}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setItems(snapshot);
      setError(t("comments.error"));
    }
  };

  const act = async (id: string, action: "report" | "block") => {
    try {
      const res = await fetch(`${base}/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "report" ? JSON.stringify({ reason: "other" }) : undefined,
      });
      if (res.status === 401) return toast({ title: t("comments.loginRequired"), tone: "danger" });
      if (!res.ok) return toast({ title: t("comments.error"), tone: "danger" });
      toast({ title: t(action === "report" ? "comments.reported" : "comments.blockedUser"), tone: "success" });
      if (action === "block") reload();
    } catch {
      toast({ title: t("comments.error"), tone: "danger" });
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="news-comments-title">
      <h2 id="news-comments-title" className="text-base font-semibold text-fg">{t("comments.title", { count: items.length })}</h2>
      <form onSubmit={submit} className="space-y-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_LEN} rows={3} placeholder={t("comments.placeholder")} aria-label={t("comments.placeholder")} />
        <div className="flex items-center gap-2">
          {error && <p className="min-w-0 flex-1 text-xs text-danger" role="alert">{error}</p>}
          {notice && <p className="min-w-0 flex-1 text-xs text-muted" role="status">{notice}</p>}
          <Button type="submit" className="ml-auto" loading={busy} disabled={text.trim().length < 2}>{t("comments.submit")}</Button>
        </div>
      </form>
      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-subtle">{t("comments.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-card bg-surface-2 p-3">
              <div className="flex items-center gap-2 text-xs text-subtle">
                <span className="min-w-0 flex-1 truncate font-semibold text-fg">{c.author.displayName || c.author.username || t("comments.anonymous")}</span>
                <span>{format.dateTime(new Date(c.createdAt), { day: "numeric", month: "short" })}</span>
                {c.isOwn ? (
                  <IconButton size="sm" label={t("comments.delete")} onClick={() => remove(c.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </IconButton>
                ) : (
                  <>
                    <IconButton size="sm" label={t("comments.report")} onClick={() => act(c.id, "report")}>
                      <Flag className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <IconButton size="sm" label={t("comments.blockAuthor")} onClick={() => act(c.id, "block")}>
                      <Ban className="h-4 w-4" aria-hidden />
                    </IconButton>
                  </>
                )}
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-fg">{c.content}</p>
            </li>
          ))}
        </ul>
      )}
      {hasMore && <Button variant="ghost" block loading={loadingMore} onClick={loadMore}>{t("comments.loadMore")}</Button>}
    </section>
  );
}
