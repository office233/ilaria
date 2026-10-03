export class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("webhook_body_too_large");
    this.name = "WebhookBodyTooLargeError";
  }
}

export async function readWebhookBody(req: Request, maxBytes = 1024 * 1024): Promise<string> {
  const declaredSize = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new WebhookBodyTooLargeError();
  }
  const reader = req.body?.getReader();
  if (!reader) throw new Error("webhook_body_missing");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
