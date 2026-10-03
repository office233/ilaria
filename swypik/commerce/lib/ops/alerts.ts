/**
 * Generic ops alert helper. Persists to ops_alert_log + optional webhook + log.
 *
 * Cooldown e per `key` (de obicei include orderId / disputeId etc). Default 60min.
 * Setezi OPS_ALERT_WEBHOOK_URL pentru Slack/Discord/orice — același JSON.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type OpsAlertSeverity = "info" | "warning" | "critical";

export type OpsAlertInput = {
  key: string;                  // ex: "fraud_block:<orderId>"
  severity: OpsAlertSeverity;
  title: string;                // scurt, vizibil în Slack
  detail?: string;              // body extins, multiline OK
  link?: string;                // URL admin către detaliu
  payload?: Record<string, unknown>;
  cooldownMin?: number;         // default 60
};

const EMOJI: Record<OpsAlertSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

async function withinCooldown(key: string, cooldownMin: number): Promise<boolean> {
  const r = await dbQuery<{ alerted_at: Date }>(
    `SELECT alerted_at FROM ops_alert_log
      WHERE alert_key = $1
      ORDER BY alerted_at DESC LIMIT 1`,
    [key],
  );
  const last = r.rows[0]?.alerted_at;
  if (!last) return false;
  const ageMin = (Date.now() - new Date(last).getTime()) / 60_000;
  return ageMin < cooldownMin;
}

async function postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url: url.slice(0, 60) }, "[ops-alert] webhook non-2xx");
    }
  } catch (err) {
    logger.warn({ err }, "[ops-alert] webhook failed");
  }
}

/**
 * Trimite alert. Idempotent prin cooldown — apelurile repetate cu același key
 * în interval cooldownMin sunt skip-uite (returnează false).
 */
export async function notifyOps(input: OpsAlertInput): Promise<boolean> {
  const cooldown = input.cooldownMin ?? 60;
  try {
    if (await withinCooldown(input.key, cooldown)) {
      return false;
    }
  } catch (err) {
    logger.warn({ err, key: input.key }, "[ops-alert] cooldown check failed, proceeding");
  }

  const fullPayload = {
    severity: input.severity,
    title: input.title,
    detail: input.detail || null,
    link: input.link || null,
    ...input.payload,
  };

  // 1) Persistă în DB
  try {
    await dbQuery(
      `INSERT INTO ops_alert_log (alert_key, payload, alerted_at) VALUES ($1, $2, now())`,
      [input.key, JSON.stringify(fullPayload)],
    );
  } catch (err) {
    logger.error({ err, key: input.key }, "[ops-alert] persist failed");
  }

  // 2) Log (search-friendly)
  const logLine = `[ops-alert] ${input.severity.toUpperCase()} ${input.title}${input.link ? ` <${input.link}>` : ""}`;
  if (input.severity === "critical") logger.error(fullPayload, logLine);
  else if (input.severity === "warning") logger.warn(fullPayload, logLine);
  else logger.info(fullPayload, logLine);

  // 3) Webhook opțional (Slack/Discord/generic JSON)
  const webhook = process.env.OPS_ALERT_WEBHOOK_URL;
  if (webhook) {
    const emoji = EMOJI[input.severity];
    const text = `${emoji} *${input.title}*${input.detail ? `\n${input.detail}` : ""}${input.link ? `\n<${input.link}>` : ""}`;
    // Slack/Discord ambele acceptă `{text: ...}`; pentru clienți custom trimitem și full payload.
    await postWebhook(webhook, { text, ...fullPayload });
  }

  return true;
}
