import { beforeEach, describe, expect, it, vi } from "vitest";

/** Fire de comentarii: permisiuni, aplatizare la 1 nivel, ștergere în cascadă, fixare, mențiuni, cursor. */

type Row = Record<string, unknown>;
const OWNER = "44444444-4444-4444-8444-444444444444";
const AUTHOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const TOP = "66666666-6666-4666-8666-666666666666";
const REPLY = "77777777-7777-4777-8777-777777777777";

const db = vi.hoisted(() => ({
  handler: (_sql: string, _p: unknown[]): { rows: Row[] } => ({ rows: [] }),
  calls: [] as { sql: string; params: unknown[] }[],
  tx: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    const r = db.handler(sql, params);
    return { ...r, rowCount: r.rows.length };
  }),
  withTransaction: vi.fn(async (fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>) => unknown) =>
    fn(async (sql: string) => {
      db.tx.push(sql);
      return { rows: [{ id: "x" }], rowCount: 1 };
    }),
  ),
}));

import { commentPermissions, mapCommentRow } from "@/lib/social/comments";
import { createComment, deleteComment, setPinned } from "@/lib/social/comments/mutations";
import { extractMentions } from "@/lib/social/comments/mentions";
import { planCommentNotifications } from "@/lib/social/comments/notify";
import { decodeCursor, encodeCursor, nextCursorFrom } from "@/lib/social/cursor";

beforeEach(() => {
  db.calls = [];
  db.tx = [];
  db.handler = () => ({ rows: [] });
});

describe("commentPermissions", () => {
  const ctx = (viewerId: string | null, viewerIsAccount = true) => ({ viewerId, viewerIsAccount, videoOwnerId: OWNER });

  it("author (even anonymous) can delete own comment, others cannot", () => {
    expect(commentPermissions({ userId: AUTHOR, parentCommentId: null }, ctx(AUTHOR, false)).canDelete).toBe(true);
    expect(commentPermissions({ userId: AUTHOR, parentCommentId: null }, ctx(OTHER)).canDelete).toBe(false);
    expect(commentPermissions({ userId: AUTHOR, parentCommentId: null }, ctx(null)).canDelete).toBe(false);
  });

  it("video owner can delete any comment and pin only top-level ones", () => {
    expect(commentPermissions({ userId: AUTHOR, parentCommentId: null }, ctx(OWNER))).toEqual({ canDelete: true, canPin: true });
    expect(commentPermissions({ userId: AUTHOR, parentCommentId: TOP }, ctx(OWNER)).canPin).toBe(false);
  });

  it("mapCommentRow marks pinned + video-owner author", () => {
    const view = mapCommentRow(
      { id: TOP, video_id: VIDEO, user_id: OWNER, body: "hi", pinned_at: new Date().toISOString() },
      "en",
      ctx(OWNER),
    );
    expect(view.isPinned).toBe(true);
    expect(view.author.isVideoOwner).toBe(true);
    expect(view.canPin).toBe(true);
  });
});

describe("createComment", () => {
  function videoAndParent(parentRow: Row | null) {
    db.handler = (sql) => {
      if (sql.includes("FROM videos") && sql.includes("allow_comments")) return { rows: [{ creator_id: OWNER, allow_comments: true }] };
      if (sql.includes("FROM user_blocks")) return { rows: [{ blocked: false }] };
      if (sql.includes("LEFT JOIN comments p")) return { rows: parentRow ? [parentRow] : [] };
      if (sql.includes("INSERT INTO comments")) return { rows: [{ id: "new", video_id: VIDEO, user_id: AUTHOR, parent_comment_id: null, body: "x" }] };
      if (sql.startsWith("SELECT comment_count")) return { rows: [{ comment_count: 3 }] };
      return { rows: [] };
    };
  }
  const base = { videoId: VIDEO, authorId: AUTHOR, text: "hi", status: "visible" as const, ctx: { viewerId: AUTHOR, viewerIsAccount: true, videoOwnerId: null } };

  it("flattens a reply-to-a-reply to the top-level parent (1 level of threading)", async () => {
    videoAndParent({ id: REPLY, parent_comment_id: TOP, user_id: OTHER });
    const r = await createComment({ ...base, parentId: REPLY });
    const insert = db.calls.find((c) => c.sql.includes("INSERT INTO comments"));
    expect(insert?.params[2]).toBe(TOP);
    expect(r.parentAuthorId).toBe(OTHER);
    expect(r.commentCount).toBe(3);
  });

  it("rejects a reply to a missing parent with 404", async () => {
    videoAndParent(null);
    await expect(createComment({ ...base, parentId: REPLY })).rejects.toMatchObject({ code: "parent_comment_not_found", status: 404 });
  });

  it("rejects when comments are disabled or the video is gone", async () => {
    db.handler = (sql) => (sql.includes("allow_comments") ? { rows: [{ creator_id: OWNER, allow_comments: false }] } : { rows: [] });
    await expect(createComment({ ...base, parentId: null })).rejects.toMatchObject({ code: "comments_disabled" });
    db.handler = () => ({ rows: [] });
    await expect(createComment({ ...base, parentId: null })).rejects.toMatchObject({ code: "video_not_found" });
  });

  it("rejects a comment across a block with the video owner", async () => {
    videoAndParent(null);
    const prev = db.handler;
    db.handler = (sql, p) => (sql.includes("FROM user_blocks") ? { rows: [{ blocked: true }] } : prev(sql, p));
    await expect(createComment({ ...base, parentId: null })).rejects.toMatchObject({ code: "blocked", status: 403 });
  });

  it("does not touch comment_count/reply_count (trigger-owned)", async () => {
    videoAndParent({ id: TOP, parent_comment_id: null, user_id: OTHER });
    await createComment({ ...base, parentId: TOP });
    expect(db.calls.some((c) => /SET\s+(comment_count|reply_count)/i.test(c.sql))).toBe(false);
  });
});

describe("deleteComment / setPinned", () => {
  function target(row: Row | null) {
    db.handler = (sql) => {
      if (sql.includes("JOIN videos v ON v.id = c.video_id")) return { rows: row ? [row] : [] };
      if (sql.startsWith("SELECT comment_count")) return { rows: [{ comment_count: 1 }] };
      return { rows: [] };
    };
  }
  const top = { id: TOP, video_id: VIDEO, user_id: AUTHOR, parent_comment_id: null, owner_id: OWNER };

  it("author can delete; deleting a top-level comment also deletes its replies", async () => {
    target(top);
    await deleteComment(AUTHOR, TOP, VIDEO);
    expect(db.tx[0]).toMatch(/SET status = 'deleted', pinned_at = NULL/);
    expect(db.tx[1]).toMatch(/WHERE parent_comment_id = \$1/);
  });

  it("video owner can delete someone else's comment; a stranger gets 403", async () => {
    target(top);
    await expect(deleteComment(OWNER, TOP, VIDEO)).resolves.toMatchObject({ commentCount: 1 });
    await expect(deleteComment(OTHER, TOP, VIDEO)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("deleting a reply does not cascade", async () => {
    target({ ...top, id: REPLY, parent_comment_id: TOP });
    await deleteComment(AUTHOR, REPLY, VIDEO);
    expect(db.tx).toHaveLength(1);
  });

  it("wrong video id → 404", async () => {
    target(top);
    await expect(deleteComment(AUTHOR, TOP, OTHER)).rejects.toMatchObject({ code: "comment_not_found" });
  });

  it("only the video owner pins, and only top-level comments", async () => {
    target(top);
    await expect(setPinned(AUTHOR, TOP, true)).rejects.toMatchObject({ code: "forbidden" });
    await setPinned(OWNER, TOP, true);
    expect(db.tx[0]).toMatch(/SET pinned_at = NULL WHERE video_id/);
    expect(db.tx[1]).toMatch(/SET pinned_at = now\(\)/);
    target({ ...top, id: REPLY, parent_comment_id: TOP });
    await expect(setPinned(OWNER, REPLY, true)).rejects.toMatchObject({ code: "not_top_level" });
  });
});

describe("mentions + notification plan", () => {
  it("extracts unique lowercase @usernames, ignores emails, respects the cap", () => {
    expect(extractMentions("hei @Ana_1 și @ana_1, scrie la a@b.ro @bo", 5)).toEqual(["ana_1"]);
    expect(extractMentions("@aaa @bbb @ccc", 2)).toEqual(["aaa", "bbb"]);
  });

  it("anonymous actors notify nobody", () => {
    expect(planCommentNotifications({ actor: { userId: AUTHOR, isAnon: true }, videoOwnerId: OWNER, parentAuthorId: OTHER }, [OTHER])).toEqual([]);
  });

  it("each recipient gets one notification, never the actor", () => {
    const plan = planCommentNotifications(
      { actor: { userId: AUTHOR, isAnon: false }, videoOwnerId: OWNER, parentAuthorId: OTHER },
      [OTHER, OWNER, AUTHOR, "88888888-8888-4888-8888-888888888888"],
    );
    expect(plan).toEqual([
      { recipientId: OTHER, notice: "reply" },
      { recipientId: OWNER, notice: "comment" },
      { recipientId: "88888888-8888-4888-8888-888888888888", notice: "mention" },
    ]);
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    const c = encodeCursor("2026-09-25T10:00:00.000Z", TOP) as string;
    expect(decodeCursor(c)).toEqual({ at: "2026-09-25T10:00:00.000Z", id: TOP });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from("x|y").toString("base64url"))).toBeNull();
  });

  it("nextCursorFrom only emits a cursor when there is one more row than the limit", () => {
    const rows = [1, 2, 3].map((i) => ({ id: TOP, at: `2026-09-2${i}T00:00:00.000Z` }));
    expect(nextCursorFrom(rows.slice(0, 2), 2, (r) => r.at).nextCursor).toBeNull();
    const page = nextCursorFrom(rows, 2, (r) => r.at);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor)?.at).toBe(rows[1].at);
  });
});
