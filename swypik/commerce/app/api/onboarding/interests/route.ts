import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { TOPICS } from "@/lib/topics";
import {
  getOptionalSocialUserId,
  anonSessionErrorResponse,
  getOrCreateSocialUser,
  signAnonValue,
  ANON_SESSION_COOKIE,
} from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const topics: string[] = body.topics;

    if (!Array.isArray(topics) || topics.length < 3 || topics.length > 7) {
      return NextResponse.json({ error: "Invalid topics count. Must be between 3 and 7." }, { status: 400 });
    }

    const validTopicIds = new Set(TOPICS.map(t => t.id));
    for (const t of topics) {
      if (!validTopicIds.has(t as any)) {
        return NextResponse.json({ error: `Invalid topic: ${t}` }, { status: 400 });
      }
    }

    const session = await getOrCreateSocialUser();
    const userId = session.userId;

    const rl = await rateLimit("onboarding", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    // Insert interests
    for (const topic of topics) {
      await dbQuery(
        `INSERT INTO user_interests (user_id, topic, weight, source)
         VALUES ($1, $2, 2.0, 'onboarding')
         ON CONFLICT (user_id, topic)
         DO UPDATE SET weight = 2.0, source = 'onboarding'`,
        [userId, topic]
      );
    }

    const response = NextResponse.json({ ok: true, topics_saved: topics.length });

    if (session.anonSessionId) {
      // 2026-08-14 (bug): cookie-ul se seta NESEMNAT, dar `parseSignedAnon`
      // respinge UUID-urile brute ca „legacy" (anti-impersonare). Rezultat:
      // POST salva interesele, iar la următorul request userul era altul —
      // interesele rămâneau orfane și cold start-ul nu funcționa deloc.
      response.cookies.set(ANON_SESSION_COOKIE, signAnonValue(session.anonSessionId), {
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1 year
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }

    // Marchează utilizatorul ca onboarded — middleware-ul nu îl va mai redirecta la /onboarding.
    response.cookies.set("swypik_onboarded", "1", {
      path: "/",
      maxAge: 60 * 60 * 24 * 730, // 2 years
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });

    return response;
  } catch (error: any) {
    const anonErr = anonSessionErrorResponse(error);
    if (anonErr) return anonErr;
    logger.error({ err: error }, "Interests POST error:");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ interests: [] });
    }

    const { rows } = await dbQuery(
      `SELECT topic, weight, source FROM user_interests WHERE user_id = $1 ORDER BY weight DESC`,
      [userId]
    );

    return NextResponse.json({ interests: rows });
  } catch (error: any) {
    logger.error({ err: error }, "Interests GET error:");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
