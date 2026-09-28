import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { boundedJson, parseIlariaRequest, queryIlaria } from "@/lib/ai/ilaria";

export const runtime = "nodejs";
export const maxDuration = 130;

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Private pilot: existing Swypik cookie/bearer sessions and middleware CSRF
// protection apply. The model service credential never reaches the browser.
export async function POST(req: Request) {
  try {
    const session = await getAuthSession();
    if (!session) return json({ error: "Sign in required" }, 401);
    if (session.role !== "admin") return json({ error: "Ilaria pilot access required" }, 403);
    if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-site request rejected" }, 403);
    if (req.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "JSON required" }, 415);
    const limit = await rateLimit("ilariaPilot", session.userId, { limit: 5, window: 60 });
    if (!limit.success) return json({ error: "Please try again later" }, 429);
    let request;
    try {
      request = parseIlariaRequest(await boundedJson(req.body, 64 * 1024));
    } catch {
      return json({ error: "Invalid Ilaria request; maximum 64 KiB and 10 history turns" }, 400);
    }
    return json(await queryIlaria(request, req.signal));
  } catch {
    // Do not disclose service URLs, credentials, or internal model errors.
    return json({ error: "Ilaria is temporarily unavailable" }, 503);
  }
}
