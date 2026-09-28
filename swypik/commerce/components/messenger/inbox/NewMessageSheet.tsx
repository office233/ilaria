"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Input } from "@/components/ui/Input";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { dmEntryHref } from "@/lib/dm/links";

type SearchUser = { id: string; username: string | null; display_name: string | null; avatar_url: string | null };

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

/** Mesaj nou: caută după nume/@username, apoi deschide DM-ul prin /messages/new. */
export function NewMessageSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("dm.newMessage");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { users?: SearchUser[] };
        setResults(data.users ?? []);
        setStatus("done");
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") setStatus("error");
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("title")}>
      <label className="relative mb-3 block">
        <span className="sr-only">{t("searchLabel")}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-9"
        />
      </label>
      <div className="min-h-40 pb-2" aria-live="polite">
        {status === "idle" ? <p className="py-6 text-center text-sm text-muted">{t("hint", { min: MIN_CHARS })}</p> : null}
        {status === "loading" ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-control" />
            ))}
          </div>
        ) : null}
        {status === "error" ? <p className="py-6 text-center text-sm text-danger">{t("error")}</p> : null}
        {status === "done" && results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t("noResults")}</p>
        ) : null}
        {status === "done" ? (
          <ul className="space-y-0.5">
            {results.map((u) => {
              const name = u.display_name || (u.username ? `@${u.username}` : t("unknownUser"));
              return (
                <li key={u.id}>
                  <ListItem
                    href={dmEntryHref({ kind: "user", id: u.id })}
                    onClick={() => onOpenChange(false)}
                    leading={<Avatar src={u.avatar_url} name={name} />}
                    title={name}
                    subtitle={u.username ? `@${u.username}` : undefined}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
