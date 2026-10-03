import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { collectUserData } from "@/lib/legal/data-export";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/export — dreptul de acces și portabilitate (GDPR art. 15, 20).
 *
 * Descarcă un JSON cu datele utilizatorului AUTENTIFICAT. Nu acceptă niciun
 * parametru de identificare: id-ul vine exclusiv din sesiune. Un `?userId=`
 * ar transforma un drept GDPR în cea mai comodă scurgere de date posibilă.
 *
 * Până pe 20 august, politica de confidențialitate promitea acest drept
 * („să primești o copie", „format structurat, citibil automat") fără să existe
 * nicio rută. Asta e ce implementează promisiunea.
 */
export async function GET() {
    const user = await getAuthUser();
    if (!user.userId) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // Interogare grea (14 tabele). Fără limită, un client care apasă repetat
    // pune presiune pe baza de producție.
    const rl = await rateLimit("accountExport", user.userId);
    if (!rl.success) {
        return NextResponse.json(
            { error: "rate_limited", detail: "Prea multe cereri. Încearcă peste un minut." },
            { status: 429 },
        );
    }

    try {
        const data = await collectUserData(user.userId);

        // Urmă de audit: dovada că cererea a fost onorată și când. Nu logăm
        // conținutul, doar faptul.
        await dbQuery(
            `INSERT INTO cron_runs(job_name, status, result, completed_at)
             VALUES ($1, $2, $3, NOW())`,
            [
                "gdpr-export",
                "success",
                JSON.stringify({
                    userId: user.userId,
                    sectiuni: Object.keys(data.date).length,
                    esuate: data.sectiuni_esuate ?? [],
                }),
            ],
        ).catch(() => {
            // Auditul nu are voie să blocheze exercitarea dreptului.
        });

        const stamp = new Date().toISOString().slice(0, 10);
        return new NextResponse(JSON.stringify(data, null, 2), {
            status: 200,
            headers: {
                "content-type": "application/json; charset=utf-8",
                "content-disposition": `attachment; filename="swypik-datele-mele-${stamp}.json"`,
                "cache-control": "no-store, max-age=0",
            },
        });
    } catch (error) {
        logger.error({ error: String(error), userId: user.userId }, "gdpr export failed");
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}
