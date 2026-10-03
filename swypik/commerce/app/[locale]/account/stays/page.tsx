import type { Metadata } from "next";
import { redirect } from "@/lib/i18n/navigation";
import { BedDouble } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItem } from "@/components/ui/ListItem";
import { PageHeader } from "@/components/ui/PageHeader";
import { BookingStatusBadge } from "@/components/stays/BookingStatusBadge";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { Link } from "@/lib/i18n/navigation";
import { listGuestBookings } from "@/lib/stays/bookings-repo";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "staysUi" });
    return { title: t("myBookings") };
}

/** Rezervările clientului: cele viitoare/active primele, apoi istoricul. */
export default async function MyStayBookingsPage({ params }: Params) {
    const { locale } = await params;
    const user = await getAuthUser();
    if (!user.userId) return redirect({ href: "/account?redirect=/account/stays", locale });
    const t = await getTranslations({ locale, namespace: "staysUi" });
    const bookings = await listGuestBookings(user.userId);
    const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
    const d = (iso: string) => date.format(new Date(`${iso}T00:00:00Z`));

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader back="/account" title={t("myBookings")} />
            <main className="mx-auto max-w-lg px-gutter py-4">
                {bookings.length === 0 ? (
                    <EmptyState
                        icon={BedDouble}
                        title={t("noBookingsTitle")}
                        description={t("noBookingsBody")}
                        action={
                            <Button asChild>
                                <Link href="/stays">{t("findStay")}</Link>
                            </Button>
                        }
                    />
                ) : (
                    <ul className="space-y-1">
                        {bookings.map((b) => (
                            <li key={b.id}>
                                <ListItem
                                    href={`/account/stays/${b.id}`}
                                    leading={
                                        b.image_url ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={b.image_url} alt="" className="h-12 w-12 shrink-0 rounded-control object-cover" />
                                        ) : (
                                            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control bg-surface-2">
                                                <BedDouble className="h-5 w-5 text-subtle" aria-hidden />
                                            </span>
                                        )
                                    }
                                    title={b.title}
                                    subtitle={`${d(b.check_in)} – ${d(b.check_out)}${b.location_city ? ` · ${b.location_city}` : ""}`}
                                    trailing={<BookingStatusBadge status={b.status} />}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </main>
        </div>
    );
}
