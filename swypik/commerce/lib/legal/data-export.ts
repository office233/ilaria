import { dbQuery } from "@/lib/db";

/**
 * Colectarea datelor unui utilizator pentru dreptul de acces și portabilitate
 * (GDPR art. 15 și 20).
 *
 * DE CE E AICI, NU ÎN `route.ts`
 * Next.js permite într-un fișier de rută doar exporturi cunoscute (GET, POST,
 * dynamic, ...). Orice altceva rupe `tsc` prin tipurile din `.next/types` —
 * lecție învățată pe 19 august cu `parseIds`.
 *
 * CE INTRĂ ȘI CE NU
 * Regula: intră ce a produs utilizatorul sau ce descrie identitatea lui. NU
 * intră:
 *   - secrete (`password_hash`, `session_token_hash`, `cnp_encrypted`,
 *     chei de wallet) — a le exporta ar transforma un drept GDPR într-un
 *     vector de furt de cont;
 *   - scoruri de risc și semnale antifraudă (`user_risk_scores`,
 *     `user_fraud_signals`) — art. 15(4): dreptul de acces nu poate aduce
 *     atingere drepturilor altora, iar publicarea logicii de detecție ar face
 *     frauda mai ușoară. Faptul că există se declară în politică; conținutul
 *     se dă doar la cerere motivată, manual.
 */

/** Un tabel = o secțiune în JSON-ul exportat. */
type Section = {
    /** Cheia din JSON-ul final. */
    key: string;
    /** Explicație în română, ca fișierul să fie citibil fără documentație. */
    about: string;
    sql: string;
};

const SECTIONS: Section[] = [
    {
        key: "cont",
        about: "Datele contului tău.",
        sql: `SELECT id, username, display_name, email, first_name, last_name, phone,
                     avatar_url, bio, locale, role, status, birth_date,
                     email_verified_at, phone_verified_at, created_at, last_seen_at
                FROM users WHERE id = $1`,
    },
    {
        key: "adrese",
        about: "Adresele de livrare salvate.",
        sql: `SELECT label, recipient_name, phone, line1, line2, city, region,
                     postal_code, country_code, is_default, created_at
                FROM user_addresses WHERE user_id = $1 ORDER BY created_at`,
    },
    {
        key: "comenzi",
        about: "Comenzile plasate în magazin.",
        sql: `SELECT id, status, currency, subtotal_cents, discount_cents,
                     shipping_cents, tax_cents, total_cents, placed_at
                FROM commerce_orders WHERE buyer_user_id = $1 ORDER BY placed_at DESC`,
    },
    {
        key: "cos",
        about: "Coșurile de cumpărături (inclusiv cele nefinalizate).",
        sql: `SELECT id, status, currency, created_at, updated_at
                FROM carts WHERE user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "clipuri_incarcate",
        about: "Clipurile pe care le-ai publicat.",
        sql: `SELECT id, slug, title, description, duration_ms, visibility, status,
                     language_code, tags, created_at
                FROM videos WHERE creator_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "comentarii",
        about: "Comentariile scrise.",
        sql: `SELECT id, video_id, body, status, like_count, created_at
                FROM comments WHERE user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "aprecieri",
        about: "Ce ai apreciat (clipuri, comentarii, produse).",
        sql: `SELECT video_id, comment_id, product_id, reaction, created_at
                FROM likes WHERE user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "salvari",
        about: "Ce ai salvat pentru mai târziu.",
        sql: `SELECT video_id, collection_name, created_at
                FROM saves WHERE user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "urmariri",
        about: "Conturile pe care le urmărești.",
        sql: `SELECT following_user_id, notification_level, created_at
                FROM follows WHERE follower_user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "recenzii",
        about: "Recenziile lăsate la produse.",
        sql: `SELECT product_id, rating, title, body, is_verified_purchase, created_at
                FROM product_reviews WHERE user_id = $1 ORDER BY created_at DESC`,
    },
    {
        key: "interese",
        about: "Categoriile deduse din activitatea ta, folosite la recomandări.",
        sql: `SELECT topic, weight, source, updated_at
                FROM user_interests WHERE user_id = $1 ORDER BY weight DESC`,
    },
    {
        key: "preferinte_notificari",
        about: "Ce notificări ai activat.",
        // Coloane enumerate, nu `SELECT *`: o coloană adăugată mâine ar intra
        // automat în export, inclusiv una care n-ar trebui să iasă niciodată.
        sql: `SELECT email_likes, email_comments, email_follows, email_messages,
                     email_sales, email_marketing, email_digest,
                     push_likes, push_comments, push_follows, push_messages,
                     push_sales, updated_at
                FROM notification_preferences WHERE user_id = $1`,
    },
];

export type ExportResult = {
    generat_la: string;
    despre: string;
    utilizator_id: string;
    date: Record<string, unknown>;
    sectiuni_esuate?: string[];
};

/**
 * Adună tot ce ține de un utilizator.
 *
 * O secțiune care eșuează (tabel lipsă după o migrare, de exemplu) nu oprește
 * exportul: e notată în `sectiuni_esuate`. Altfel o singură schimbare de schemă
 * ar bloca un drept legal pentru toată lumea.
 */
export async function collectUserData(userId: string): Promise<ExportResult> {
    const date: Record<string, unknown> = {};
    const esuate: string[] = [];

    for (const s of SECTIONS) {
        try {
            const { rows } = await dbQuery(s.sql, [userId]);
            date[s.key] = { descriere: s.about, inregistrari: rows };
        } catch {
            esuate.push(s.key);
        }
    }

    return {
        generat_la: new Date().toISOString(),
        despre:
            "Export al datelor tale personale de pe Swypik (GDPR art. 15 și 20). " +
            "Nu conține parole, chei sau token-uri de sesiune. Semnalele antifraudă " +
            "și scorurile de risc se pot cere separat, la privacy@swypik.com.",
        utilizator_id: userId,
        date,
        ...(esuate.length ? { sectiuni_esuate: esuate } : {}),
    };
}
