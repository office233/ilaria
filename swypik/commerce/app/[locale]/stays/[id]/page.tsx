import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { freeCancelDays, lateCancelRefundPct, staysConfig } from "@/lib/stays/config";
import { isIsoDate } from "@/lib/stays/dates";
import { getStayDetail } from "@/lib/stays/listing-detail";
import { listReviews } from "@/lib/stays/reviews";
import { UUID_RE } from "@/lib/stays/route";
import StayDetailClient from "./StayDetailClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; locale: string }> };
type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
    return typeof v === "string" && isIsoDate(v) ? v : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { id, locale } = await params;
    if (!UUID_RE.test(id)) return {};
    const stay = await getStayDetail(id);
    if (!stay) return {};
    return {
        alternates: localizedAlternates(locale, `/stays/${id}`),
        title: `${stay.title} — Swypik Stays`,
        description: stay.description?.slice(0, 160) ?? undefined,
        openGraph: stay.images[0] ? { images: [stay.images[0]] } : undefined,
    };
}

export default async function StayDetailPage({ params, searchParams }: Params & Search) {
    const { id } = await params;
    const sp = await searchParams;
    if (!UUID_RE.test(id)) notFound();
    const [stay, reviews] = await Promise.all([getStayDetail(id), listReviews(id, 10)]);
    if (!stay) notFound();

    return (
        <StayDetailClient
            stay={stay}
            reviews={reviews}
            initial={{
                range: { checkIn: one(sp.checkIn), checkOut: one(sp.checkOut) },
                guests: Math.min(Math.max(1, Number(sp.guests) || 1), stay.maxGuests ?? staysConfig.maxGuests()),
            }}
            policy={{
                freeCancelDays: freeCancelDays(),
                lateRefundPct: lateCancelRefundPct(),
                hostResponseHours: staysConfig.hostResponseTtlHours(),
                pendingMinutes: staysConfig.pendingPaymentTtlMin(),
                maxNights: staysConfig.maxNights(),
                maxGuests: stay.maxGuests ?? staysConfig.maxGuests(),
            }}
        />
    );
}
