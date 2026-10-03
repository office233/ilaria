"use client";

import useSWR from "swr";

type CartResponse = { items?: Array<{ quantity?: number | string }> } | null;
type NotificationsResponse = { unreadCount?: number | string } | null;
type DmResponse =
  | { conversations?: Array<{ unread_count?: number | string }>; items?: Array<{ unread_count?: number | string }> }
  | Array<{ unread_count?: number | string }>
  | null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Numărul de bucăți din coșul server-side. */
export function cartCountFrom(data: CartResponse): number {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.reduce((sum, it) => sum + (Number(it?.quantity) || 0), 0);
}

/** Notificări necitite + conversații cu mesaje necitite. */
export function unreadCountFrom(notif: NotificationsResponse, dm: DmResponse): number {
  const convs = Array.isArray(dm) ? dm : Array.isArray(dm?.conversations) ? dm.conversations : Array.isArray(dm?.items) ? dm.items : [];
  const dmUnread = convs.reduce((sum, c) => sum + (Number(c?.unread_count) > 0 ? 1 : 0), 0);
  return (Number(notif?.unreadCount) || 0) + dmUnread;
}

/** Afișare compactă pentru badge-uri: 0 → null, >99 → „99+”. */
export function formatBadgeCount(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}

export function useCartCount(): number {
  const { data } = useSWR("/api/cart", (u: string) => getJson<CartResponse>(u), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  return cartCountFrom(data ?? null);
}

export function useUnreadCount(): number {
  const { data } = useSWR(
    "shell:unread",
    async () => {
      const [notif, dm] = await Promise.all([
        getJson<NotificationsResponse>("/api/notifications?limit=1"),
        getJson<DmResponse>("/api/dm/conversations"),
      ]);
      return unreadCountFrom(notif, dm);
    },
    { refreshInterval: 60_000, revalidateOnFocus: false },
  );
  return data ?? 0;
}
