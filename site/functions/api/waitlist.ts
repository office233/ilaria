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
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "Expected a JSON request." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return json({ error: "Request is too large." }, 413);
  }

  let body: WaitlistPayload;

  try {
    body = await request.json<WaitlistPayload>();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const honeypot = String(body.company ?? "").trim();
  if (honeypot) {
    return json({ ok: true });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const source = String(body.source ?? "homepage").trim().slice(0, 64);
  const consent = body.consent === true;

  if (!consent) {
    return json({ error: "Consent is required to join the launch list." }, 400);
  }

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  const insert = await env.DB.prepare(
    "INSERT OR IGNORE INTO waitlist (id, email, source, consent_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)"
  ).bind(crypto.randomUUID(), email, source || "homepage").run();

  const existing = insert.meta.changes === 0;
  return json({ ok: true, existing }, existing ? 200 : 201);
};
