/**
 * GET /r/[code] — link scurt de invitație (QR-ul șoferilor + referral general).
 * Setează cookie 30 de zile și redirecționează la înregistrare cu codul
 * precompletat. Claim-ul efectiv se face la signup (sau post-signup).
 */
import { NextResponse } from "next/server";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Z0-9]{3,16}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;
    const clean = String(code ?? "").trim().toUpperCase();
    // Derivă baza din request (env-urile NEXT_PUBLIC_* nu există la runtime în
    // container, iar req.url conține adresa internă 0.0.0.0:3000).
    const hdrHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const safeHost = hdrHost && !/^(0\.0\.0\.0|127\.|localhost)/.test(hdrHost) ? hdrHost : null;
    const base = safeHost ? `${proto}://${safeHost}` : APP_URL;
    if (!CODE_RE.test(clean)) {
        return NextResponse.redirect(new URL("/", base), 302);
    }
    const res = NextResponse.redirect(new URL(`/auth?mode=register&ref=${encodeURIComponent(clean)}`, base), 302);
    res.cookies.set("swypik_ref", clean, {
        maxAge: 60 * 60 * 24 * 30,
        path: "/",
        sameSite: "lax",
    });
    return res;
}
