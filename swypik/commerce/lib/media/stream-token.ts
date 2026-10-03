import { createHmac, timingSafeEqual } from "node:crypto";

/** Verticala care a emis token-ul; proxy-ul fiecăreia acceptă doar propriul scope. */
export type StreamScope = "movies" | "music";
export type StreamTokenPayload = { userId: string; scope: StreamScope; mediaId: string; expiresAt: number };

const SCOPES: readonly string[] = ["movies", "music"];

function sign(body: string, secret: string): string {
    return createHmac("sha256", secret).update(body).digest("base64url");
}

/** `base64url(json).hmac` — legat de user + scope + media, cu expirare absolută (ms). */
export function signStreamToken(payload: StreamTokenPayload, secret: string): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${sign(body, secret)}`;
}

export function verifyStreamToken(token: string, secret: string, now: number = Date.now()): StreamTokenPayload | null {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = sign(body, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    const p = parsed as Partial<StreamTokenPayload>;
    if (typeof p.userId !== "string" || typeof p.mediaId !== "string" || typeof p.expiresAt !== "number") return null;
    if (typeof p.scope !== "string" || !SCOPES.includes(p.scope)) return null;
    if (p.expiresAt <= now) return null;
    return { userId: p.userId, scope: p.scope, mediaId: p.mediaId, expiresAt: p.expiresAt };
}
