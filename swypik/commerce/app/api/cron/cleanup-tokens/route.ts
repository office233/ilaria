import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

async function authorize(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function GET_impl(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await runCron("cleanup-tokens", async () => {
      const r1 = await dbQuery(
        "DELETE FROM password_reset_tokens WHERE expires_at < NOW() - INTERVAL '7 days'"
      ).catch(() => ({ rowCount: 0 } as any));
      const r2 = await dbQuery(
        "DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '30 days'"
      ).catch(() => ({ rowCount: 0 } as any));
      // GDPR: IP-ul și user-agent-ul sunt date personale — le anonimizăm după
      // 90 de zile chiar dacă sesiunea încă e validă (verificare flotă/fraudă
      // are sens doar pe termen scurt).
      const r3 = await dbQuery(
        `UPDATE user_sessions SET ip_address = NULL, user_agent = NULL
          WHERE created_at < NOW() - INTERVAL '90 days'
            AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)`
      ).catch(() => ({ rowCount: 0 } as any));

      // ── Restul locurilor cu IP în clar (adăugat 2026-08-20) ──────────────
      // Politica promite, la secțiunea 3: „Adresa IP și user-agent-ul sunt
      // anonimizate automat după 90 de zile." Până acum era adevărat pentru
      // UN singur tabel din patru — promisiune parțial falsă.
      //
      // Termene diferite, pe scopuri diferite:

      // `checkout_audit_log` — 180 de zile, nu 90. E singurul loc unde se poate
      // reconstitui cine a trimis cereri de plată frauduloase; incidentul din
      // iulie (4 webhook_fail cu `client_ip` gol) a arătat exact ce lipsește
      // fără el. Termen mai lung decât la sesiuni, dar tot finit: după o
      // jumătate de an, o investigație de fraudă pe plăți fie s-a făcut, fie
      // nu se mai face. Verificat: `client_ip` se SCRIE de trei locuri în cod
      // și nu se CITEȘTE de nicăieri automat — e material de anchetă manuală.
      const r4 = await dbQuery(
        `UPDATE checkout_audit_log SET client_ip = NULL, user_agent = NULL
          WHERE created_at < NOW() - INTERVAL '180 days'
            AND (client_ip IS NOT NULL OR user_agent IS NOT NULL)`
      ).catch(() => ({ rowCount: 0 } as any));

      // `user_watch_events` — analiză de conținut. IP-ul nu are niciun rol
      // dincolo de deduplicarea vizionărilor pe termen scurt.
      const r5 = await dbQuery(
        `UPDATE user_watch_events SET client_ip = NULL, user_agent = NULL
          WHERE created_at < NOW() - INTERVAL '90 days'
            AND (client_ip IS NOT NULL OR user_agent IS NOT NULL)`
      ).catch(() => ({ rowCount: 0 } as any));

      // `push_subscriptions` — user-agent-ul spune ce browser primește
      // notificarea. Util cât abonamentul e activ, inutil după.
      const r6 = await dbQuery(
        `UPDATE push_subscriptions SET user_agent = NULL
          WHERE created_at < NOW() - INTERVAL '90 days'
            AND user_agent IS NOT NULL`
      ).catch(() => ({ rowCount: 0 } as any));

      // `user_fraud_signals.signup_ip` — IP în CLAR, ratat la primul audit.
      // Restul tabelelor de fraudă țin `ip_hash`, care nu mai e dată personală
      // identificabilă; aici e adresa întreagă. 180 de zile, ca la
      // `checkout_audit_log`: același scop, aceeași justificare.
      // `signup_ip_country` rămâne — o țară nu identifică pe nimeni.
      const r7 = await dbQuery(
        `UPDATE user_fraud_signals SET signup_ip = NULL, signup_user_agent = NULL
          WHERE created_at < NOW() - INTERVAL '180 days'
            AND (signup_ip IS NOT NULL OR signup_user_agent IS NOT NULL)`
      ).catch(() => ({ rowCount: 0 } as any));

      return {
        tokens_deleted: r1.rowCount ?? 0,
        sessions_deleted: r2.rowCount ?? 0,
        sessions_anonymized: r3.rowCount ?? 0,
        checkout_audit_anonymized: r4.rowCount ?? 0,
        watch_events_anonymized: r5.rowCount ?? 0,
        push_subs_anonymized: r6.rowCount ?? 0,
        fraud_signals_anonymized: r7.rowCount ?? 0,
      };
  });
  if (result === null) return cronSkippedResponse("cleanup-tokens");
  return NextResponse.json(result);
}

export const GET = withErrorHandling(GET_impl);
