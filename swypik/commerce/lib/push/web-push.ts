/**
 * Legacy Web Push shim — canonical implementation lives in lib/push/send.ts
 * (table `user_push_tokens`). Kept for backwards-compatible imports.
 */
import { sendPushToUser as sendPush, type PushPayload as SendPayload } from "@/lib/push/send";

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  [key: string]: unknown;
};

/**
 * @deprecated Shim de compatibilitate. Sursa unică de adevăr e acum
 * `lib/push/send.ts` (tabela `user_push_tokens`). Apelurile existente
 * (lib/notifications/dispatch.ts, api/internal/live/started) merg neschimbate.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  await sendPush(userId, payload as SendPayload);
}

export function getVapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}
