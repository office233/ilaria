import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

type GameRow = {
  id: string;
  title: string;
  slug: string;
  category: string;
  embed_url: string;
  thumbnail_url: string;
};

/**
 * GET /api/gaming/games — active arcade games, sourced from gaming_games
 * (is_active = true) instead of a hardcoded list, so a broken/deactivated
 * seed like game_sudoku never shows up.
 */
export async function GET(req: Request) {
  if (!isEnabled("gaming")) return frozenResponse("gaming");

  try {
    const { rows } = await dbQuery<GameRow>(
      `SELECT id, title, slug, category, embed_url, thumbnail_url
         FROM gaming_games
        WHERE is_active = true AND source_type = 'self_hosted'
        ORDER BY created_at ASC`,
    );
    return applyCachePolicy(NextResponse.json({ ok: true, games: rows }), "gaming/games", req);
  } catch (err) {
    logger.error({ err }, "[gaming.games] failed");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
