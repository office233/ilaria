/**
 * Plumbing comun pentru rutele Stays: sesiune obligatorie, rate limit și
 * conversia StaysError → `{ error: code }`.
 */
import { getAuthSession, type AuthSession } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { StaysError, staysError } from "./errors";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler<A extends unknown[]> = (...args: A) => Promise<Response>;

/** Prinde StaysError (cod stabil) și orice altă eroare (internal_error). */
export function staysRoute<A extends unknown[]>(name: string, fn: Handler<A>): Handler<A> {
    return async (...args: A) => {
        try {
            return await fn(...args);
        } catch (err) {
            if (err instanceof StaysError) return staysError(err.code);
            logger.error({ err, route: name }, "stays route failed");
            return staysError("internal_error");
        }
    };
}

/** Sesiunea curentă sau StaysError('unauthorized'). */
export async function requireSession(): Promise<AuthSession> {
    const session = await getAuthSession().catch(() => null);
    if (!session) throw new StaysError("unauthorized");
    return session;
}

/** Rate limit pe user (sau IP); aruncă StaysError('rate_limited'). */
export async function limitOrThrow(
    req: Request,
    bucket: string,
    who: string | null,
    cfg: { limit: number; window: number },
): Promise<void> {
    const rl = await rateLimit(`stays:${bucket}`, who ?? getClientIP(req), cfg);
    if (!rl.success) throw new StaysError("rate_limited");
}

/** Parametrul [id] al rutei, validat ca UUID. */
export async function idParam(params: Promise<{ id: string }>): Promise<string> {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new StaysError("not_found");
    return id;
}
