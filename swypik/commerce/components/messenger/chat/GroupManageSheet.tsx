"use client";

import { useEffect, useMemo, useState } from "react";
import { Crown, LogOut, Search, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

type Member = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  joined_at: string;
};

type SearchUser = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  viewerId: string;
  title: string;
};

function displayName(user: Pick<Member, "username" | "display_name">, fallback: string): string {
  return user.display_name || (user.username ? `@${user.username}` : fallback);
}

export function GroupManageSheet({ open, onOpenChange, conversationId, viewerId, title }: Props) {
  const t = useTranslations("dm.group");
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);

  const viewer = useMemo(() => members.find((member) => member.user_id === viewerId), [members, viewerId]);
  const viewerIsAdmin = Boolean(viewer?.is_admin);
  const memberIds = useMemo(() => new Set(members.map((member) => member.user_id)), [members]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dm/conversations/${conversationId}/members`);
      const data = (await res.json().catch(() => ({}))) as { members?: Member[] };
      if (!res.ok || !Array.isArray(data.members)) throw new Error("members");
      setMembers(data.members);
    } catch {
      toast({ title: t("loadError"), tone: "danger" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      return;
    }
    void load();
  }, [open, conversationId]);

  useEffect(() => {
    const q = query.trim();
    if (!open || !viewerIsAdmin || q.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const data = (await res.json().catch(() => ({}))) as { users?: SearchUser[] };
        if (!res.ok || !Array.isArray(data.users)) return setResults([]);
        setResults(data.users.filter((user) => !memberIds.has(user.id)));
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, viewerIsAdmin, memberIds]);

  const mutate = async (
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    key: string,
    success: string,
  ) => {
    setBusyId(key);
    try {
      const res = await fetch(`/api/dm/conversations/${conversationId}/members`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const message = data.error === "last_admin" ? t("lastAdminError") : t("actionError");
        toast({ title: message, tone: "danger" });
        return false;
      }
      toast({ title: success, tone: "success" });
      await load();
      return true;
    } catch {
      toast({ title: t("actionError"), tone: "danger" });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const add = async (user: SearchUser) => {
    const ok = await mutate("POST", { user_ids: [user.id] }, `add:${user.id}`, t("added"));
    if (ok) {
      setQuery("");
      setResults([]);
    }
  };

  const setAdmin = (member: Member, isAdmin: boolean) =>
    mutate(
      "PATCH",
      { user_id: member.user_id, is_admin: isAdmin },
      `admin:${member.user_id}`,
      isAdmin ? t("promoted") : t("demoted"),
    );

  const remove = async (member: Member) => {
    const self = member.user_id === viewerId;
    const ok = await mutate(
      "DELETE",
      { user_id: member.user_id },
      `remove:${member.user_id}`,
      self ? t("left") : t("removed"),
    );
    if (ok && self) onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={t("description")}>
      {viewerIsAdmin ? (
        <div className="mb-4 space-y-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
            />
          </label>
          {query.trim().length >= 2 ? (
            <div className="overflow-hidden rounded-card border border-subtle">
              {searching ? <p className="px-3 py-3 text-sm text-muted">{t("searching")}</p> : null}
              {!searching && results.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted">{t("noSearchResults")}</p>
              ) : null}
              {results.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void add(user)}
                  className="flex w-full items-center gap-3 border-t border-subtle px-3 py-2 text-left first:border-t-0 hover:bg-surface-2 disabled:opacity-50"
                >
                  <Avatar src={user.avatar_url} name={user.display_name || user.username || t("unknownUser")} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-fg">
                      {user.display_name || (user.username ? `@${user.username}` : t("unknownUser"))}
                    </span>
                  </span>
                  <UserPlus className="h-4 w-4 text-muted" aria-hidden />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-fg">{t("membersTitle")}</h3>
          <span className="text-xs text-muted">{members.length}</span>
        </div>
        {loading && members.length === 0 ? <p className="py-4 text-sm text-muted">{t("loading")}</p> : null}
        {members.map((member) => {
          const self = member.user_id === viewerId;
          const name = displayName(member, t("unknownUser"));
          return (
            <div key={member.user_id} className="flex items-center gap-3 rounded-card border border-subtle p-3">
              <Avatar src={member.avatar_url} name={name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-semibold text-fg">{name}</p>
                  {member.is_admin ? <Crown className="h-3.5 w-3.5 text-brand" aria-label={t("admin")} /> : null}
                </div>
                <p className="truncate text-xs text-muted">
                  {self ? t("you") : member.username ? `@${member.username}` : member.is_admin ? t("admin") : t("member")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {viewerIsAdmin && !self ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === `admin:${member.user_id}`}
                    onClick={() => void setAdmin(member, !member.is_admin)}
                    aria-label={member.is_admin ? t("removeAdmin") : t("makeAdmin")}
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
                {(viewerIsAdmin || self) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === `remove:${member.user_id}`}
                    onClick={() => void remove(member)}
                    aria-label={self ? t("leave") : t("remove")}
                  >
                    {self ? <LogOut className="h-4 w-4" aria-hidden /> : <Trash2 className="h-4 w-4 text-danger" aria-hidden />}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
