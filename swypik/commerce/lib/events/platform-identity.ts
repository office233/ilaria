import { getSessionUserId } from "@/lib/auth/getAuthUser";
import { getOrCreateAnonId, readAnonId } from "@/lib/anon/session";
import { deriveServerSecret } from "@/lib/security/secret-box";

export type PlatformEventIdentity = {
  actorId: string | null;
  sessionId: string;
  rateLimitKey: string;
  kind: "user" | "anonymous";
};

function pseudonym(kind: "user" | "anonymous", id: string): string {
  const digest = deriveServerSecret("platform-event-session", `${kind}:${id}`);
  return `${kind === "user" ? "u" : "a"}_${digest.slice(0, 48)}`;
}

/**
 * Resolve authoritative event identity from first-party Swypik state.
 * Client-supplied actor_id/user_id/session_id is never trusted as identity.
 */
export async function resolvePlatformEventIdentity(): Promise<PlatformEventIdentity> {
  const userId = await getSessionUserId();
  if (userId) {
    return {
      actorId: userId,
      sessionId: pseudonym("user", userId),
      rateLimitKey: `user:${userId}`,
      kind: "user",
    };
  }

  const anonId = (await readAnonId()) ?? await getOrCreateAnonId();
  const sessionId = pseudonym("anonymous", anonId);
  return {
    actorId: null,
    sessionId,
    rateLimitKey: `anon:${sessionId}`,
    kind: "anonymous",
  };
}
