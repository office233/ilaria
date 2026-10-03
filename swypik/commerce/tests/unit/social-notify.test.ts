import { beforeEach, describe, expect, it, vi } from "vitest";

/** notifySocial: fără anonimi, fără sine, fără blocări, linkuri canonice, titlu localizat, dedup like. */

const ACTOR = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const COMMENT = "44444444-4444-4444-8444-444444444444";

const s = vi.hoisted(() => ({ blocked: false, already: false }));
const notifyUser = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("user_blocks")) return { rows: [{ blocked: s.blocked }], rowCount: 1 };
    if (sql.includes("FROM notifications")) return { rows: [{ found: s.already }], rowCount: 1 };
    if (sql.includes("SELECT username, display_name")) return { rows: [{ username: "ana", display_name: "Ana" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notifyUser }));
vi.mock("@/lib/notifications/localized", () => ({ userLocale: async () => "en" }));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) =>
    (key: string, values?: Record<string, unknown>) => `${locale}:${namespace}.${key}:${values?.name ?? ""}`,
}));

import { notifySocial, shouldNotify } from "@/lib/notifications/social";

const actor = { userId: ACTOR, isAnon: false };

beforeEach(() => {
  s.blocked = false;
  s.already = false;
  notifyUser.mockClear();
});

describe("notifySocial", () => {
  it("skips anonymous actors, self-notifications and missing recipients", () => {
    expect(shouldNotify({ recipientId: RECIPIENT, actor: { userId: ACTOR, isAnon: true } })).toBe(false);
    expect(shouldNotify({ recipientId: ACTOR, actor })).toBe(false);
    expect(shouldNotify({ recipientId: null, actor })).toBe(false);
    expect(shouldNotify({ recipientId: RECIPIENT, actor })).toBe(true);
  });

  it("follow links to the actor's canonical profile with a localized title", async () => {
    await notifySocial({ recipientId: RECIPIENT, actor, notice: "follow" });
    expect(notifyUser).toHaveBeenCalledWith(
      RECIPIENT,
      expect.objectContaining({
        type: "follow",
        payload: expect.objectContaining({ url: "/u/ana", title: "en:notificationsText.social.follow.title:Ana" }),
      }),
    );
  });

  it("mention links to the comment inside the video player", async () => {
    await notifySocial({ recipientId: RECIPIENT, actor, notice: "mention", videoId: VIDEO, commentId: COMMENT, preview: "hei @x" });
    expect(notifyUser).toHaveBeenCalledWith(
      RECIPIENT,
      expect.objectContaining({
        type: "mention",
        targetType: "comment",
        payload: expect.objectContaining({ url: `/explore?v=${VIDEO}&comment=${COMMENT}`, body: "hei @x" }),
      }),
    );
  });

  it("does nothing across a block", async () => {
    s.blocked = true;
    await notifySocial({ recipientId: RECIPIENT, actor, notice: "comment", videoId: VIDEO, commentId: COMMENT });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("dedups repeated likes within 24h but not comments", async () => {
    s.already = true;
    await notifySocial({ recipientId: RECIPIENT, actor, notice: "videoLike", videoId: VIDEO });
    expect(notifyUser).not.toHaveBeenCalled();
    await notifySocial({ recipientId: RECIPIENT, actor, notice: "comment", videoId: VIDEO, commentId: COMMENT });
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });
});
