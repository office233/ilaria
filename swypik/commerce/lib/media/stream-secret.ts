/** Secretul HMAC pentru token-urile de stream — același ca la sesiunile anonime (APP_ENCRYPTION_KEY). */
export function getStreamSecret(): string {
    const key = process.env.APP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "";
    if (!key) {
        if (process.env.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY missing — refusing to sign stream tokens");
        return "dev-only-stream-secret";
    }
    return key;
}
