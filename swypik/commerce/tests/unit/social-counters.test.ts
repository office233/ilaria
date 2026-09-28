import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contoarele sociale sunt ținute de triggere (20260926_0110). Testele verifică
 * contractul migrării și că niciun cod aplicație nu le mai scrie manual
 * (dublă numărare = drift-ul găsit în audit).
 */
const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const migration = read("db/migrations/20260926_0110_social_counter_triggers.sql");

describe("counter trigger migration", () => {
  it("installs both triggers idempotently (guarded by pg_trigger)", () => {
    expect(migration).toMatch(/tgname = 'trg_likes_social_counter'/);
    expect(migration).toMatch(/tgname = 'trg_comments_social_counter'/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION social_likes_counter\(\)/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION social_comments_counter\(\)/);
  });

  it("counts only visible comments, on status transitions too (hide/delete/restore)", () => {
    expect(migration).toMatch(/old_counted := OLD\.status = 'visible'/);
    expect(migration).toMatch(/new_counted := NEW\.status = 'visible'/);
    expect(migration).toMatch(/AFTER INSERT OR DELETE OR UPDATE OF status, parent_comment_id, video_id ON comments/);
    expect(migration).toMatch(/reply_count = reply_count \+ 1 WHERE id = NEW\.parent_comment_id/);
  });

  it("never lets a counter go negative", () => {
    const decrements = migration.match(/_count - 1/g) ?? [];
    const guarded = migration.match(/GREATEST\(\w+_count - 1, 0\)/g) ?? [];
    expect(decrements.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(decrements.length);
  });

  it("backfills drift once and keeps the resync function callable", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION social_resync_counters\(\) RETURNS integer/);
    expect(migration.trim().endsWith("SELECT social_resync_counters();")).toBe(true);
  });

  it("the cron resync uses the same definition of a counted comment", () => {
    expect(read("app/api/cron/aggregate-video-stats/route.ts")).toMatch(/c\.status = 'visible'/);
  });
});

describe("application code no longer writes like/comment counters", () => {
  const files = [
    "lib/social/likes.ts",
    "lib/social/like-route.ts",
    "lib/social/merge-anon.ts",
    "lib/social/comments/mutations.ts",
    "lib/social/comments/handlers.ts",
    "app/api/videos/[id]/like/route.ts",
    "app/api/comments/[id]/like/route.ts",
    "app/api/videos/[id]/comments/route.ts",
  ];
  it.each(files)("%s", (file) => {
    const src = read(file);
    // product_stats.like_count (produse) rămâne recalculat din sursă în merge-anon — nu e vizat.
    expect(src).not.toMatch(/UPDATE\s+(videos|comments)[\s\S]{0,60}?SET\s+(like_count|comment_count|reply_count)\s*=/i);
  });
});
