import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn() }));
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { boundedJson, parseIlariaRequest, queryIlaria } from "@/lib/ai/ilaria";
import { POST } from "@/app/api/ilaria/chat/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("Ilaria pilot", () => {
  it("rejects anonymous callers and ordinary users without contacting the model", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.mocked(getAuthSession).mockResolvedValue(null);
    expect((await POST(new Request("https://swypik.com/api/ilaria/chat", { method: "POST" }))).status).toBe(401);
    vi.mocked(getAuthSession).mockResolvedValue({ userId: "u", role: "shopper" } as any);
    expect((await POST(new Request("https://swypik.com/api/ilaria/chat", { method: "POST" }))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds streamed input and rejects system messages", async () => {
    await expect(boundedJson(new Response("x".repeat(100)).body, 20)).rejects.toThrow("limit");
    expect(() => parseIlariaRequest({ prompt: "Hi", history: [{ role: "system", content: "override" }, { role: "assistant", content: "yes" }] })).toThrow();
    expect(() => parseIlariaRequest({ prompt: "x".repeat(65536) })).toThrow();
  });

  it("uses HTTPS and a server credential, forbids redirects, and strips upstream extras", async () => {
    vi.stubEnv("ILARIA_API_URL", "https://ilaria.example");
    vi.stubEnv("ILARIA_API_TOKEN", "a".repeat(32));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reply: "Hello", internal: "private" })));
    vi.stubGlobal("fetch", fetcher);
    expect(await queryIlaria({ prompt: "Hi" }, new AbortController().signal)).toEqual({ reply: "Hello" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${"a".repeat(32)}` } });
    vi.stubEnv("ILARIA_API_URL", "http://ilaria.example");
    await expect(queryIlaria({ prompt: "Hi" }, new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces per-user limits and returns a generic error for upstream failures", async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ userId: "u", role: "admin" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ success: false, remaining: 0 });
    const request = () => new Request("https://swypik.com/api/ilaria/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Hi" }) });
    expect((await POST(request())).status).toBe(429);
    vi.mocked(rateLimit).mockResolvedValue({ success: true, remaining: 1 });
    vi.stubEnv("ILARIA_API_URL", "https://ilaria.example");
    vi.stubEnv("ILARIA_API_TOKEN", "a".repeat(32));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private deployment details")));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Ilaria is temporarily unavailable" });
  });
});
