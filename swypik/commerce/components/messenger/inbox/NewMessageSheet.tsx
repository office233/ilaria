"use client";

import { useEffect, useState } from "react";
import { Search, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/lib/i18n/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { conversationPath, dmEntryHref } from "@/lib/dm/links";

type SearchUser = { id: string; username: string | null; display_name: string | null; avatar_url: string | null };

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

/** Mesaj nou: caută după nume/@username, apoi deschide DM-ul prin /messages/new. */
export function NewMessageSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("dm.newMessage");
  const router = useRouter();
  const [mode, setMode] = useState<"dm" | "group">("dm");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);
  const [selected, setSelected] = useState<SearchUser[]>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected([]);
      setGroupTitle("");
      setGroupError(null);
      setMode("dm");
    }
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

  const toggleSelected = (user: SearchUser) => {
    setSelected((current) =>
      current.some((item) => item.id === user.id)
        ? current.filter((item) => item.id !== user.id)
        : [...current, user],
    );
    setGroupError(null);
  };

  const createGroup = async () => {
    if (creating) return;
    if (!groupTitle.trim() || selected.length < 2) {
      setGroupError(t("groupMinMembers"));
      return;
    }
    setCreating(true);
    setGroupError(null);
    try {
      const res = await fetch("/api/dm/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "group",
          title: groupTitle.trim(),
          participant_user_ids: selected.map((user) => user.id),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { conversation_id?: string; error?: string };
      if (!res.ok || !data.conversation_id) {
        setGroupError(t("groupError"));
        return;
      }
      onOpenChange(false);
      router.push(conversationPath(data.conversation_id));
    } catch {
      setGroupError(t("groupError"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("title")}>
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-control bg-surface-2 p-1">
        <button
          type="button"
          onClick={() => setMode("dm")}
          className={`rounded-control px-3 py-2 text-sm font-bold ${mode === "dm" ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
        >
          {t("dmMode")}
        </button>
        <button
          type="button"
          onClick={() => setMode("group")}
          className={`rounded-control px-3 py-2 text-sm font-bold ${mode === "group" ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
        >
          {t("groupMode")}
        </button>
      </div>
      {mode === "group" ? (
        <div className="mb-3 space-y-2">
          <Input
            value={groupTitle}
            onChange={(e) => setGroupTitle(e.target.value)}
            placeholder={t("groupTitlePlaceholder")}
            maxLength={120}
          />
          {selected.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {selected.map((user) => {
                const name = user.display_name || (user.username ? `@${user.username}` : t("unknownUser"));
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => toggleSelected(user)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1.5 text-xs font-bold text-fg"
                  >
                    {name}
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
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
              const selectedUser = selected.some((item) => item.id === u.id);
              return (
                <li key={u.id}>
                  {mode === "dm" ? (
                    <ListItem
                      href={dmEntryHref({ kind: "user", id: u.id })}
                      onClick={() => onOpenChange(false)}
                      leading={<Avatar src={u.avatar_url} name={name} />}
                      title={name}
                      subtitle={u.username ? `@${u.username}` : undefined}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSelected(u)}
                      className={`flex w-full items-center gap-3 rounded-control px-2 py-2 text-left ${selectedUser ? "bg-brand-soft" : "hover:bg-surface-2"}`}
                    >
                      <Avatar src={u.avatar_url} name={name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-fg">{name}</span>
                        {u.username ? <span className="block truncate text-xs text-muted">@{u.username}</span> : null}
                      </span>
                      <UserPlus className="h-4 w-4 text-muted" aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {mode === "group" ? (
        <div className="border-t border-subtle pt-3">
          {groupError ? <p className="mb-2 text-sm font-medium text-danger">{groupError}</p> : null}
          <Button
            className="w-full"
            disabled={creating || !groupTitle.trim() || selected.length < 2}
            onClick={() => void createGroup()}
          >
            {creating ? t("creatingGroup") : t("createGroup", { count: selected.length })}
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}
