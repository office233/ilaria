import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({ send: vi.fn(), provider: vi.fn(), db: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/email/transport", () => ({ sendMail: mocks.send, activeProvider: mocks.provider }));
vi.mock("@/lib/db", () => ({ dbQuery: mocks.db }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: mocks.enabled }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));
vi.mock("@/lib/contact", () => ({ SUPPORT_EMAIL: "support@swypik.com" }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { sendEmail, sendRefundEmail, sendSellerNewOrderAlert, sendSellerApprovalEmail, sendCustomerShippingAlert, sendMagicLink } from "@/lib/email/service";
import { notifyVideoApproved, notifyVideoRejected } from "@/lib/email/creator-notifications";
import { sendDigestEmail } from "@/lib/email/templates/digest";
import { sendVerifyEmail, sendWelcomeEmail } from "@/lib/email/templates/auth";
import { sendFleetDecisionEmail } from "@/lib/email/templates/fleet";
import { sendOpsApplicationAlert } from "@/lib/email/templates/ops";
import { localizedPath, emailLink } from "@/lib/email/links";
import { isPlaceholderSecret, emailFrom, emailReplyTo } from "@/lib/email/config";

type Sent = { to: string; subject: string; html: string; text: string; headers?: Record<string, string> };
const lastSent = (): Sent => mocks.send.mock.calls.at(-1)?.[0] as Sent;

/** Rânduri DB după textul interogării. */
function db(map: Record<string, unknown[]>) {
  mocks.db.mockImplementation(async (sql: string) => {
    for (const [needle, rows] of Object.entries(map)) if (sql.includes(needle)) return { rows };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.provider.mockReturnValue("resend");
  mocks.send.mockResolvedValue(true);
  mocks.enabled.mockReturnValue(false); // FEATURE_EMAIL_MARKETING OFF (ca în producție)
  vi.stubEnv("SESSION_SECRET", "test-only-secret");
  db({});
});
afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it("treats placeholder keys as not configured", () => {
    expect(isPlaceholderSecret("placeholder")).toBe(true);
    expect(isPlaceholderSecret("re_placeholder_key")).toBe(true);
    expect(isPlaceholderSecret("")).toBe(true);
    expect(isPlaceholderSecret("re_AbC123realKey")).toBe(false);
  });
  it("has one default sender and replies go to support", () => {
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("EMAIL_REPLY_TO", "");
    expect(emailFrom()).toBe("Swypik <noreply@swypik.com>");
    expect(emailReplyTo()).toBe("support@swypik.com");
  });
});

describe("links", () => {
  it("prefixes localized pages and never the auth/seller routes", () => {
    expect(localizedPath("en", "/orders/abc")).toBe("/en/orders/abc");
    expect(localizedPath("ro", "/orders/abc")).toBe("/orders/abc");
    expect(localizedPath("de", "/auth/verify-email")).toBe("/auth/verify-email");
    expect(localizedPath("de", "/seller/orders")).toBe("/seller/orders");
    expect(emailLink("fr", "/explore")).toBe("https://swypik.com/fr/explore");
  });
});

describe("transactional emails", () => {
  it("do not depend on FEATURE_EMAIL_MARKETING and have no unsubscribe footer", async () => {
    expect(await sendSellerNewOrderAlert("s@example.com", [{ title: "Mug", quantity: 2 }], "Ana")).toBe(true);
    expect(await sendSellerApprovalEmail("s@example.com", "Ana")).toBe(true);
    expect(await notifyVideoApproved("c@example.com", "Ion", "Clip")).toBe(true);
    expect(await notifyVideoRejected("c@example.com", "Ion", "Clip", "Low quality")).toBe(true);
    expect(await sendCustomerShippingAlert("b@example.com", "AWB123")).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(5);
    for (const [msg] of mocks.send.mock.calls as [Sent][]) {
      expect(msg.html).not.toMatch(/unsubscribe/i);
      expect(msg.headers).toBeUndefined();
      expect(msg.text.length).toBeGreaterThan(20);
    }
  });

  it("return false (not a fake success) when email is not configured", async () => {
    mocks.provider.mockReturnValue("none");
    expect(await sendSellerApprovalEmail("s@example.com", "Ana")).toBe(false);
    expect(await sendEmail({ to: "u@example.com", subject: "x", html: "<p>x</p>" })).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("escapes user input in HTML", async () => {
    await sendSellerNewOrderAlert("s@example.com", [{ title: "<img src=x onerror=alert(1)>", quantity: 1 }], "<b>Eve</b>");
    const { html } = lastSent();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<b>Eve</b>");
  });

  it("uses the configured creator commission instead of a hardcoded 5%", async () => {
    await notifyVideoApproved("c@example.com", "Ion", "Clip");
    expect(lastSent().text).toMatch(/5\s?%/);
  });

  it("links the refund to the customer's order page with the lookup token and locale", async () => {
    db({ "FROM commerce_orders": [{ id: "abcd-1", lookup_token: "tok123", buyer_user_id: "u1", locale: "en" }] });
    await sendRefundEmail("b@example.com", "abcd-1", 1999, "RON");
    const { html, subject } = lastSent();
    expect(html).toContain("https://swypik.com/en/orders/tok123");
    expect(html).not.toContain("/orders/abcd-1");
    expect(subject).toMatch(/Refund/);
  });

  it("falls back to the account order page (never the uuid on /orders) without a token", async () => {
    db({ "FROM commerce_orders": [{ id: "abcd-1", lookup_token: null, buyer_user_id: "u1", locale: "ro" }] });
    await sendRefundEmail("b@example.com", "abcd-1", 1999, "RON");
    expect(lastSent().html).toContain("https://swypik.com/account/orders/abcd-1");
  });

  it("sends the email in the recipient's stored locale", async () => {
    db({ "SELECT locale FROM users": [{ locale: "de" }] });
    await sendSellerApprovalEmail("s@example.com", "Ana");
    expect(lastSent().subject).toBe("Dein Verkäuferkonto wurde freigegeben");
    expect(lastSent().html).toContain('lang="de"');
  });

  it("login code and verification are different emails; the verify email carries a link", async () => {
    await sendMagicLink("u@example.com", "123456", "ro");
    const code = lastSent();
    expect(code.html).toContain("123456");
    expect(code.html).not.toContain("verify-email");
    await sendVerifyEmail("u@example.com", "tok_abc", "en");
    expect(lastSent().html).toContain("https://swypik.com/auth/verify-email?token=tok_abc");
  });

  it("welcome greets the first name", async () => {
    await sendWelcomeEmail("u@example.com", "Maria", "ro");
    expect(lastSent().html).toContain("Bun venit, Maria!");
  });

  it("wraps legacy HTML fragments in the branded layout with a text part", async () => {
    await sendEmail({ to: "ops@example.com", subject: "Alert", html: "<h2>Titlu</h2><p>Corp <a href=\"https://swypik.com/admin\">link</a></p><script>x()</script>" });
    const { html, text } = lastSent();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Titlu");
    expect(html).not.toContain("<script>");
    expect(text).toContain("link (https://swypik.com/admin)");
  });

  it("fleet decision and ops alert escape applicant data", async () => {
    await sendFleetDecisionEmail({ to: "d@example.com", kind: "driver", name: "<x>", decision: "approve", referralCode: "ABC" });
    expect(lastSent().html).toContain("&lt;x&gt;");
    vi.stubEnv("OPS_ALERT_EMAIL", "ops@example.com");
    await sendOpsApplicationAlert({ kind: "courier", label: "Ion", fields: { name: "<script>", phone: "07" }, adminPath: "/admin/fleet" });
    expect(lastSent().html).not.toContain("<script>");
    expect(lastSent().html).toContain("https://swypik.com/admin/fleet");
  });
});

describe("marketing emails", () => {
  it("digest carries the unsubscribe footer and List-Unsubscribe headers", async () => {
    await sendDigestEmail({
      to: "u@example.com",
      locale: "en",
      firstName: "Ana",
      products: [{ id: "p1", title: "Mug", slug: "mug", image_url: null, price_cents: 1000, currency: "RON" }],
      videos: [],
    });
    const msg = lastSent();
    expect(msg.html).toContain("Unsubscribe");
    expect(msg.html).toContain("https://swypik.com/unsubscribe?u=");
    expect(msg.headers?.["List-Unsubscribe"]).toContain("https://swypik.com/api/unsubscribe?u=");
    expect(msg.html).toContain("https://swypik.com/en/product/mug");
  });
});

describe("no mojibake anywhere in email sources", () => {
  const MOJIBAKE = /Ã.|Ä[\u0080-ÿ]|Č™|â€|đź|Ă[®˘]/;
  it("email templates, digest route and messages.email are clean UTF-8", () => {
    const root = path.resolve(__dirname, "../..");
    const files = [
      ...fs.readdirSync(path.join(root, "lib/email")).filter((f) => f.endsWith(".ts")).map((f) => `lib/email/${f}`),
      ...fs.readdirSync(path.join(root, "lib/email/templates")).map((f) => `lib/email/templates/${f}`),
      "app/api/cron/email-digest/route.ts",
      "app/api/unsubscribe/route.ts",
    ];
    for (const f of files) expect(fs.readFileSync(path.join(root, f), "utf8"), f).not.toMatch(MOJIBAKE);
    for (const l of ["ro", "en", "es", "fr", "de", "pt", "it"]) {
      const m = JSON.parse(fs.readFileSync(path.join(root, `messages/${l}.json`), "utf8"));
      expect(JSON.stringify(m.email), l).not.toMatch(MOJIBAKE);
      expect(JSON.stringify(m.authEmail), l).not.toMatch(MOJIBAKE);
    }
  });
});
