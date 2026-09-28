import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { proxyToSocialApi } from "@/lib/social/proxy";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function fallback(req: Request, socialPath: string) {
  if (req.method === "GET" && socialPath === "/v1/notifications") {
    return NextResponse.json({
      notifications: [],
      unread: 0,
      source: "next-fallback",
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "Go social API is not configured for this endpoint.",
      endpoint: socialPath,
    },
    { status: 503 }
  );
}

async function handle(req: Request, context: RouteContext) {
  const { path } = await context.params;
  const socialPath = `/v1/${path.join("/")}`;
  // Proxy-ul ataseaza secretul intern al platform-api, care in Go e SINGURA
  // autorizare pentru /v1/admin/* (requiresInternalAuth). Fara gardul asta,
  // orice vizitator anonim ajunge la datele de admin ale serviciului Go.
  if (socialPath === "/v1/admin" || socialPath.startsWith("/v1/admin/")) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  // Checkout-ul vechi (Stripe Checkout Session pentru vizitatori) e retras: nici
  // ruta Next /api/checkout, nici /v1/checkout din platform-api (cu URL-uri de
  // test swypik.local) nu mai primesc plăți prin acest proxy. Codul stabil îi
  // trimite pe clienții vechi la /api/checkout/create-intent.
  if (socialPath === "/v1/checkout" || socialPath.startsWith("/v1/checkout/")) {
    return NextResponse.json(
      {
        success: false,
        code: "legacy_checkout_retired",
        error: "legacy_checkout_retired",
        replacement: "/api/checkout/create-intent",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }
  const proxied = await proxyToSocialApi(req, socialPath);
  if (proxied) return proxied;
  return fallback(req, socialPath);
}

async function GET_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function POST_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function PUT_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function PATCH_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function DELETE_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
export const PUT = withErrorHandling(PUT_impl);
export const PATCH = withErrorHandling(PATCH_impl);
export const DELETE = withErrorHandling(DELETE_impl);
