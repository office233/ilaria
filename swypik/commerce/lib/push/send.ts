/**
 * Web Push sender — canonical helper peste tabela `user_push_tokens`.
 *
 * VAPID keys din env:
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto:...)
 * Generare (o singură dată, pune rezultatul în .env):
 *   npx web-push generate-vapid-keys
 *
 * sendPushToUser(userId, payload) — trimite la toate token-urile active ale
 * userului; token-urile care răspund 404/410 sunt revocate automat
 * (revoked_at = now()).
 */
import webpush from "web-push";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type PushPayload = {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  /** URL deschis la click pe notificare (handler în public/sw.js). */
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
};

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:contact@swypik.com";
  if (!publicKey || !privateKey) {
    logger.warn({}, "push.send: VAPID keys missing — push disabled");
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

type TokenRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type SendResult = {
  sent: number;
  failed: number;
  revoked: number;
};

/** Trimite payload-ul la toate token-urile active ale userului. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, revoked: 0 };
  if (!ensureConfigured()) return result;

  const { rows: tokens } = await dbQuery<TokenRow>(
    `SELECT id, endpoint, p256dh, auth
       FROM user_push_tokens
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  if (tokens.length === 0) return result;

  const body = JSON.stringify(payload);

  await Promise.all(
    tokens.map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          body,
          { TTL: 60 * 60 },
        );
        result.sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Endpoint mort — revocă tokenul.
          await dbQuery(
            `UPDATE user_push_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
            [t.id],
          ).catch(() => {});
          result.revoked += 1;
        } else {
          result.failed += 1;
          logger.error(
            { userId, statusCode, error: (err as Error).message },
            "push.send.failed",
          );
        }
      }
    }),
  );

  return result;
}
