/**
 * POST /api/hosts/apply — aplicație de gazdă Swypik Stays.
 *
 * Onboarding cu verificare: nimic nu devine public fără review manual.
 * Cerințe legale RO validate la nivel de formular:
 *   - pensiune/hotel → certificat de clasificare OBLIGATORIU (Ordin 65/2013)
 *   - PFA/SRL → CUI obligatoriu
 *   - persoană fizică → max 5 camere (peste → trebuie PFA/SRL, Cod Fiscal)
 *   - declarație de conformitate fiscală (ANAF) obligatorie
 * Documentele (extras CF, act identitate) se cer la pasul de review, prin
 * canalul securizat — nu în formularul public.
 *
 * GET /api/hosts/apply — statusul aplicației userului curent.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { isValidCnp, ageFromCnp, encryptCnp, hashCnp } from "@/lib/identity/cnp";
import { logger } from "@/lib/logger";
import { sendOpsApplicationAlert } from "@/lib/email/templates/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
    .object({
        full_name: z.string().min(3).max(120),
        phone: z.string().min(8).max(20),
        email: z.string().email(),
        entity_type: z.enum(["persoana_fizica", "pfa", "srl"]),
        company_name: z.string().max(160).optional(),
        cui: z.string().max(20).optional(),
        cnp: z.string().trim().length(13, "CNP-ul are 13 cifre").optional(),
        property_name: z.string().min(3).max(160),
        property_type: z.enum(["apartament", "casa", "pensiune", "hotel", "cabana", "vila"]),
        address: z.string().min(5).max(240),
        city: z.string().min(2).max(80),
        county: z.string().min(2).max(60),
        rooms: z.number().int().min(1).max(200),
        max_guests: z.number().int().min(1).max(500),
        classification_cert: z.string().max(60).optional(),
        tourism_registered: z.boolean(),
    })
    .superRefine((d, ctx) => {
        // DAC7: platformele trebuie să colecteze codul fiscal al vânzătorului.
        // Persoană fizică → CNP; PFA/SRL → CUI (validat mai jos).
        if (d.entity_type === "persoana_fizica") {
            if (!d.cnp) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["cnp"],
                    message: "CNP-ul e obligatoriu pentru persoane fizice (raportare ANAF/DAC7).",
                });
            } else if (!isValidCnp(d.cnp)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cnp"], message: "CNP invalid (cifra de control nu corespunde)." });
            } else if ((ageFromCnp(d.cnp) ?? 0) < 18) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cnp"], message: "Trebuie să fii major pentru a deveni gazdă." });
            }
        } else if (d.cnp && !isValidCnp(d.cnp)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cnp"], message: "CNP invalid." });
        }
        // Ordin 65/2013: structurile clasificabile au nevoie de certificat.
        if ((d.property_type === "pensiune" || d.property_type === "hotel") && !d.classification_cert) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["classification_cert"],
                message: "Pensiunile și hotelurile au nevoie de certificat de clasificare (Ministerul Turismului).",
            });
        }
        // PFA/SRL → CUI obligatoriu.
        if ((d.entity_type === "pfa" || d.entity_type === "srl") && !d.cui) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cui"], message: "CUI obligatoriu pentru PFA/SRL." });
        }
        // Persoană fizică: max 5 camere (Cod Fiscal, norme închiriere turistică).
        if (d.entity_type === "persoana_fizica" && d.rooms > 5) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["rooms"],
                message: "Ca persoană fizică poți închiria max. 5 camere. Peste, e nevoie de PFA/SRL.",
            });
        }
        // Fără declarație de conformitate fiscală nu acceptăm aplicația.
        if (!d.tourism_registered) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["tourism_registered"],
                message: "Confirmă înregistrarea fiscală (ANAF) a activității de închiriere turistică.",
            });
        }
    });

export const POST = withErrorHandling(async function POST(req: Request) {
    // Aplicația trebuie legată de un cont: o aplicație anonimă aprobată nu
    // putea deveni niciodată gazdă (audit stays.md §4).
    const session = await getAuthSession().catch(() => null);
    if (!session) return NextResponse.json({ error: "unauthorized", code: "login_required" }, { status: 401 });

    const rl = await rateLimit("hosts:apply", getClientIP(req), { limit: 5, window: 3600 });
    if (!rl.success) {
        return NextResponse.json({ error: "Prea multe încercări. Reîncearcă mai târziu." }, { status: 429 });
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Date invalide", field: parsed.error.issues[0]?.path?.[0] },
            { status: 400 },
        );
    }
    const d = parsed.data;

    // Anti-duplicat: o aplicație pending per email.
    const dup = await dbQuery<{ id: string }>(
        `SELECT id FROM host_applications WHERE email = $1 AND status IN ('pending','needs_info') LIMIT 1`,
        [d.email],
    );
    if (dup.rows.length) {
        return NextResponse.json({ error: "Ai deja o aplicație în curs de verificare." }, { status: 409 });
    }

    // Anti-fraudă: același CNP nu poate avea două aplicații active/aprobate
    // (verificat pe hash, fără decriptare).
    const cnpHash = d.cnp ? hashCnp(d.cnp) : null;
    if (cnpHash) {
        const dupCnp = await dbQuery<{ id: string }>(
            `SELECT id FROM host_applications
              WHERE cnp_hash = $1 AND status IN ('pending','needs_info','approved') LIMIT 1`,
            [cnpHash],
        );
        if (dupCnp.rows.length) {
            return NextResponse.json({ error: "Există deja o aplicație cu acest CNP." }, { status: 409 });
        }
    }

    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO host_applications
            (user_id, full_name, phone, email, entity_type, company_name, cui,
             property_name, property_type, address, city, county, rooms, max_guests,
             classification_cert, tourism_registered, cnp_encrypted, cnp_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id`,
        [
            session.userId, d.full_name, d.phone, d.email, d.entity_type,
            d.company_name ?? null, d.cui ?? null, d.property_name, d.property_type,
            d.address, d.city, d.county, d.rooms, d.max_guests,
            d.classification_cert ?? null, d.tourism_registered,
            d.cnp ? encryptCnp(d.cnp) : null, cnpHash,
        ],
    );

    logger.info({ applicationId: rows[0].id, city: d.city, type: d.property_type }, "host application received");

    // Notifică ops (best-effort; escaparea e în lib/email).
    sendOpsApplicationAlert({
        kind: "host",
        label: d.property_name,
        fields: {
            property: `${d.property_name} (${d.property_type}, ${d.rooms})`,
            location: `${d.city}, ${d.county}`,
            name: d.full_name,
            phone: d.phone,
            email: d.email,
            legalForm: d.cui ? `${d.entity_type} (${d.cui})` : d.entity_type,
        },
        adminPath: "/admin/hosts",
    }).catch((err) => logger.warn({ err }, "[hosts/apply] ops email failed"));

    return NextResponse.json({ ok: true, applicationId: rows[0].id, status: "pending" });
});

export const GET = withErrorHandling(async function GET() {
    const session = await getAuthSession().catch(() => null);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { rows } = await dbQuery(
        `SELECT id, status, property_name, created_at::text FROM host_applications
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [session.userId],
    );
    return NextResponse.json({ applications: rows });
});
