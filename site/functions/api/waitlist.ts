interface Env {
  DB: D1Database;
}

type WaitlistPayload = {
  email?: unknown;
  company?: unknown;
  consent?: unknown;
  source?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 4096;

async function readPayload(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("empty_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ error: "Expected a JSON request." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }

  let body: WaitlistPayload;

  try {
    const parsed = await readPayload(request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Invalid request." }, 400);
    }
    body = parsed as WaitlistPayload;
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return json({ error: "Request is too large." }, 413);
    }
    return json({ error: "Invalid request." }, 400);
  }

  if (body.company !== undefined && typeof body.company !== "string") {
    return json({ error: "Invalid request." }, 400);
  }
  const honeypot = typeof body.company === "string" ? body.company.trim() : "";
  if (honeypot) {
    return json({ ok: true });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const source = typeof body.source === "string" ? body.source.trim().slice(0, 64) : "homepage";
  const consent = body.consent === true;

  if (!consent) {
    return json({ error: "Consent is required to join the launch list." }, 400);
  }

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  try {
    const insert = await env.DB.prepare(
      "INSERT OR IGNORE INTO waitlist (id, email, source, consent_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)"
    ).bind(crypto.randomUUID(), email, source || "homepage").run();

    if (!insert.success) throw new Error("waitlist_unavailable");
    const existing = insert.meta.changes === 0;
    return json({ ok: true, existing }, existing ? 200 : 201);
  } catch {
    return json({ error: "The launch list is unavailable. Please try again later." }, 503);
  }
};
