import { getSessionUserId } from "@/lib/auth/getAuthUser";
import { getOrCreateAnonId, readAnonId } from "@/lib/anon/session";
import { deriveServerSecret } from "@/lib/security/secret-box";

export async function getChatRequestIdentityKey(): Promise<string> {
  const userId = await getSessionUserId();
  if (userId) return `user:${userId}`;
  const anonId = (await readAnonId()) ?? await getOrCreateAnonId();
  return `anon:${deriveServerSecret("chat-request-identity", anonId).slice(0, 48)}`;
}
