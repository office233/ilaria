import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { TOPICS } from "@/lib/topics";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { VideoFeedbackSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params;
    if (!isUuidParam(videoId)) return invalidIdResponse();
    const rawBody = await request.json().catch(() => null);
    const parsedBody = parseBody(VideoFeedbackSchema, rawBody);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { action } = parsedBody.data;

    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("videoFeedback", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    // Fetch video details to determine topic
    const { rows } = await dbQuery(
      `SELECT title, description, product_refs FROM videos WHERE id = $1`,
      [videoId]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const video = rows[0];
    const textToSearch = `${video.title || ""} ${video.description || ""} ${JSON.stringify(video.product_refs || {})}`.toLowerCase();

    let extractedTopic = 'general';
    for (const t of TOPICS) {
      if (textToSearch.includes(t.id.toLowerCase()) || textToSearch.includes(t.label.split(' ')[0].toLowerCase())) {
        extractedTopic = t.id;
        break;
      }
    }

    // Upsert logic
    const weightDelta = action === "more_like_this" ? 0.5 : -1.0;
    
    // Check current weight
    const currentRes = await dbQuery(
      `SELECT weight FROM user_interests WHERE user_id = $1 AND topic = $2`,
      [userId, extractedTopic]
    );
    
    let newWeight = weightDelta;
    if (currentRes.rows.length > 0) {
      const currentWeight = parseFloat(currentRes.rows[0].weight);
      newWeight = currentWeight + weightDelta;
    }
    
    // Clamp weight
    newWeight = Math.max(-5.0, Math.min(5.0, newWeight));

    await dbQuery(
      `INSERT INTO user_interests (user_id, topic, weight, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, topic)
       DO UPDATE SET weight = $3, source = $4`,
      [userId, extractedTopic, newWeight, action]
    );

    return NextResponse.json({ action, topic: extractedTopic, new_weight: newWeight });

  } catch (error: any) {
    logger.error({ err: error }, "Feedback error:");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
