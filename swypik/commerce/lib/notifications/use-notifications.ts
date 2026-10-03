"use client";

/**
 * Starea listei de notificări — sursă unică pentru cele două ecrane care o
 * afișează (`/inbox` tab-ul Notificări și `/notifications`). Înainte, fiecare
 * își avea propria copie a acelorași patru operații (load, mark-all, mark-one,
 * contor necitite), care puteau diverge la orice modificare (audit 2026-08-24).
 */

import { useCallback, useEffect, useState } from "react";

export type Notification = {
  id: string;
  notification_type: string;
  actor_user_id: string | null;
  title: string;
  body: string | null;
  video_id: string | null;
  comment_id: string | null;
  action_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  actor_username?: string | null;
  actor_display_name?: string | null;
  actor_avatar_url?: string | null;
};

type NotificationsResponse = {
  items?: Notification[];
  nextCursor?: string | null;
  unreadCount?: number;
};

export type UseNotifications = {
  items: Notification[];
  unread: number;
  loading: boolean;
  marking: boolean;
  /** Există pagini mai vechi (cursor). */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  markAll: () => Promise<void>;
  markOne: (id: string) => Promise<void>;
};

/** Marchează local un rând ca citit, păstrând un `read_at` deja existent. */
function markRow(rows: Notification[], id: string | null, at: string): Notification[] {
  return rows.map((row) =>
    id === null || row.id === id ? { ...row, read_at: row.read_at || at } : row,
  );
}

export function useNotifications(limit = 50, autoLoad = true): UseNotifications {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(autoLoad);
  const [marking, setMarking] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/notifications?limit=${limit}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as NotificationsResponse;
      setItems(data.items || []);
      setUnread(data.unreadCount || 0);
      setCursor(data.nextCursor ?? null);
    } catch {
      // Lista rămâne cea de dinainte; ecranele au deja stare de gol/eroare.
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    if (autoLoad) void reload();
  }, [autoLoad, reload]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/notifications?limit=${limit}&cursor=${encodeURIComponent(cursor)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as NotificationsResponse;
      setItems((rows) => {
        const seen = new Set(rows.map((r) => r.id));
        return [...rows, ...(data.items || []).filter((r) => !seen.has(r.id))];
      });
      setCursor(data.nextCursor ?? null);
    } catch {
      // butonul rămâne pentru reîncercare
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, limit, loadingMore]);

  const markAll = useCallback(async () => {
    setMarking(true);
    try {
      await fetch("/api/notifications/mark-all-read", {
        method: "POST",
        credentials: "include",
      });
      setItems((rows) => markRow(rows, null, new Date().toISOString()));
      setUnread(0);
    } catch {
      // Necitirea rămâne — reîncercarea e la un tap distanță.
    } finally {
      setMarking(false);
    }
  }, []);

  const markOne = useCallback(async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      return;
    }
    setItems((rows) => markRow(rows, id, new Date().toISOString()));
    setUnread((current) => Math.max(0, current - 1));
  }, []);

  return { items, unread, loading, marking, hasMore: Boolean(cursor), loadingMore, loadMore, reload, markAll, markOne };
}
