/** Link-uri Messenger fără dependențe de server (folosite și în componente client). */

export const DM_ENTRY_KINDS = ["user", "seller", "order", "food_order"] as const;
export type DmEntryKind = (typeof DM_ENTRY_KINDS)[number];
export type DmEntry = { kind: DmEntryKind; id: string };

/** `/messages/new?<kind>=<id>` — link-ul folosit de toate butoanele „Mesaj”. */
export function dmEntryHref(entry: DmEntry): string {
  return `/messages/new?${entry.kind}=${encodeURIComponent(entry.id)}`;
}

export function conversationPath(conversationId: string): string {
  return `/messages/${conversationId}`;
}

export const INBOX_PATH = "/inbox";

/**
 * Link intern sigur pentru o notificare: doar căi relative; vechiul `/dm/<id>`
 * (404) devine conversația.
 */
export function notificationHref(actionUrl: string | null): string | undefined {
  if (!actionUrl || !actionUrl.startsWith("/") || actionUrl.startsWith("//")) return undefined;
  const legacyDm = actionUrl.match(/^\/dm\/([0-9a-f-]{36})$/i);
  return legacyDm ? conversationPath(legacyDm[1]) : actionUrl;
}
