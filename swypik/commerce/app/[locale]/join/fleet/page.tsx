import { Suspense } from "react";
import FleetApplyClient from "./FleetApplyClient";
import type { Metadata } from "next";
import { getTierParams, getTierSlots, TIER_COMMISSION_PCT } from "@/lib/drivers/tiers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ kind?: string }> }): Promise<Metadata> {
    const { kind } = await searchParams;
    const isGo = kind === "driver";
    // 2026-08-11 (audit): valorile din text vin din config (DB/constante tiers)
    // — nu mai pot rămâne desincronizate față de program.
    const [{ promoDays }, slots] = await Promise.all([
        getTierParams(),
        getTierSlots().catch(() => null),
    ]);
    const foundingPct = TIER_COMMISSION_PCT.founding15;
    const foundingTotal = slots?.founding_total ?? 500;
    return isGo
        ? {
            title: `Devino șofer Swypik Go — 0% comision ${promoDays} de zile | Swypik`,
            description:
                `Câștigă din curse în orașul tău cu cel mai mic comision din România: 0% primele ${promoDays} de zile, apoi ${foundingPct}% pe viață pentru primii ${foundingTotal} de șoferi. Plăți săptămânale, program flexibil, fără dispecerat.`,
        }
        : {
            title: "Devino curier Swypik Food — plată pe livrare + bonusuri | Swypik",
            description:
                "Livrează mâncare în cartierul tău pe bicicletă, scuter sau mașină. Tarif corect pe livrare, bonusuri la orele de vârf, program 100% flexibil. Înscrie-te în 2 minute.",
        };
}

export default function FleetJoinPage() {
    return (
        <Suspense fallback={null}>
            <FleetApplyClient />
        </Suspense>
    );
}
