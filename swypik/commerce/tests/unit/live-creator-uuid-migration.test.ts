import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));

import {
  getLiveStream,
  listLiveStreams,
} from "@/lib/live/queries";

describe("Live creator UUID migration", () => {
  it("adds a canonical creator_user_id with FK/index and safe legacy backfill", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "db/migrations/20260930_0001_live_creator_uuid.sql"),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS creator_user_id uuid");
    expect(sql).toContain("FOREIGN KEY (creator_user_id) REFERENCES users(id)");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_live_creator_user");
    expect(sql).toContain("ls.creator_id = u.id::text");
    expect(sql).toContain("NOT VALID");
  });

  it("joins public creator profiles by UUID, never by u.id::text = creator_id", async () => {
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await getLiveStream("11111111-1111-4111-8111-111111111111");
    await listLiveStreams("live", 10);

    for (const [sql] of dbQuery.mock.calls) {
      const text = String(sql);
      if (!text.includes("FROM live_streams ls")) continue;
      expect(text).toContain("LEFT JOIN users u ON u.id = ls.creator_user_id");
      expect(text).not.toContain("u.id::text = ls.creator_id");
      expect(text).toContain("COALESCE(ls.creator_user_id::text, ls.creator_id) AS creator_id");
    }
  });
});
