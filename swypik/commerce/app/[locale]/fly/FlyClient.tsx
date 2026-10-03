"use client";

/**
 * Swypik Fly — căutare + rezervare zboruri.
 * Flux: căutare → listă oferte (preț total, cu markup inclus) → pasageri →
 * Live Price Check → plată wallet sau Stripe. La price_changed (409),
 * afișăm noul preț și cerem reconfirmare.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plane, ArrowRight, Loader2, Users, CalendarDays, Wallet, CreditCard, CheckCircle2, AlertTriangle } from "lucide-react";
import AirportInput, { localizeCountryName } from "./AirportInput";
import { localizedCityName } from "@/lib/fly/city-names";

type Segment = { origin: string; destination: string; departAt: string; arriveAt: string; carrier: string; carrierName?: string; flightNumber?: string };
type Slice = { origin: string; destination: string; durationMinutes?: number; segments: Segment[] };
type Offer = {
    token: string;
    provider: "duffel" | "kiwi";
    totalCents: number;
    currency: string;
    slices: Slice[];
    stops: number;
    carrier: string;
    carrierName?: string;
};

type Passenger = { givenName: string; familyName: string; bornOn: string; type: "adult" };

// Prețurile vin deja în RON de la server; formatăm cu moneda + locale-ul curent
// al utilizatorului (nu hardcodat), ca sumele să apară corect în orice limbă.
const formatMoney = (locale: string, cents: number, currency = "RON") =>
    new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);

const formatTime = (locale: string, iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

const dur = (min?: number) => (min ? `${Math.floor(min / 60)}h ${min % 60}m` : "");

/** Logo companie aeriană după codul IATA (CDN public Duffel). */
const airlineLogo = (iata: string) =>
    `https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/${iata}.svg`;

type Deal = {
    iata: string;
    city: string;
    country: string;
    image: string;
    fromCents: number | null;
    currency: string;
};

export default function FlyClient() {
    const t = useTranslations("flyPage");
    const tFly = useTranslations("fly");
    const locale = useLocale();
    const eur = useCallback((cents: number, currency = "RON") => formatMoney(locale, cents, currency), [locale]);
    const hhmm = useCallback((iso: string) => formatTime(locale, iso), [locale]);
    const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
    const [form, setForm] = useState({ origin: "OTP", destination: "", departDate: today, returnDate: "", adults: 1 });
    const [loading, setLoading] = useState(false);
    const [offers, setOffers] = useState<Offer[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    // checkout state
    const [selected, setSelected] = useState<Offer | null>(null);
    const [passengers, setPassengers] = useState<Passenger[]>([]);
    const [contact, setContact] = useState({ email: "", phone: "" });
    const [booking, setBooking] = useState(false);
    const [filter, setFilter] = useState<"all" | "direct" | "cheap" | "fast">("all");
    const [priceNotice, setPriceNotice] = useState<string | null>(null);
    const [success, setSuccess] = useState<{ bookingRef: string | null } | null>(null);

    // Destinații populare cu prețuri "de la" — cârligul care vinde.
    // Randat doar după mount: `today`/`Date` diferă între server și client
    // și ar provoca hydration mismatch (secțiunea ar dispărea).
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const [deals, setDeals] = useState<Deal[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetch("/api/fly/deals?origin=OTP")
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (!cancelled && j) setDeals(j.deals); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, []);

    const search = useCallback(async (destOverride?: string, departOverride?: string) => {
        const destination = (destOverride ?? form.destination).trim().toUpperCase();
        const departDate = departOverride ?? form.departDate;
        if (destOverride) setForm((f) => ({ ...f, destination, departDate }));
        setLoading(true);
        setError(null);
        setOffers(null);
        setSelected(null);
        setSuccess(null);
        try {
            const res = await fetch("/api/fly/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    origin: form.origin.trim().toUpperCase(),
                    destination,
                    departDate,
                    returnDate: form.returnDate || null,
                    adults: form.adults,
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) throw new Error(json?.error ?? t("searchFailed"));
            setOffers(json?.offers ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : t("searchFailed"));
        } finally {
            setLoading(false);
        }
    }, [form, t]);

    const startCheckout = (offer: Offer) => {
        setSelected(offer);
        setPriceNotice(null);
        setSuccess(null);
        setPassengers(
            Array.from({ length: form.adults }, () => ({ givenName: "", familyName: "", bornOn: "", type: "adult" as const })),
        );
    };

    const pay = useCallback(
        async (method: "wallet" | "stripe") => {
            if (!selected) return;
            setBooking(true);
            setError(null);
            setPriceNotice(null);
            try {
                // 1. Live price check — evită capcana cache-ului.
                const pc = await fetch("/api/fly/price-check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: selected.token }),
                });
                const pcJson = await pc.json().catch(() => null);
                if (!pc.ok || !pcJson?.ok) throw new Error(pcJson?.message ?? t("offerExpired"));
                if (pcJson.priceChanged) {
                    setSelected({ ...selected, totalCents: pcJson.totalCents });
                    setPriceNotice(
                        pcJson.deltaCents > 0
                            ? t("priceUp", { delta: eur(pcJson.deltaCents), total: eur(pcJson.totalCents) })
                            : t("priceDown", { total: eur(pcJson.totalCents) }),
                    );
                    return;
                }

                // 2. Order.
                const res = await fetch("/api/fly/orders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        token: selected.token,
                        passengers,
                        contactEmail: contact.email,
                        contactPhone: contact.phone,
                        paymentMethod: method,
                    }),
                });
                const json = await res.json().catch(() => null);
                if (res.status === 409 && json?.code === "price_changed") {
                    setSelected({ ...selected, totalCents: json.newTotalCents });
                    setPriceNotice(t("priceChanged", { total: eur(json.newTotalCents) }));
                    return;
                }
                if (res.status === 401) throw new Error(t("authRequired"));
                if (!res.ok) throw new Error(json?.error ?? t("bookingFailed"));
                if (json?.checkoutUrl) {
                    window.location.href = json.checkoutUrl;
                    return;
                }
                setSuccess({ bookingRef: json?.bookingRef ?? null });
                setSelected(null);
            } catch (e) {
                setError(e instanceof Error ? e.message : t("bookingFailed"));
            } finally {
                setBooking(false);
            }
        },
        [selected, passengers, contact, t, eur],
    );

    const passengersValid =
        passengers.length > 0 &&
        passengers.every((p) => p.givenName && p.familyName && p.bornOn) &&
        /\S+@\S+\.\S+/.test(contact.email) &&
        contact.phone.length >= 6;

    return (
        <div className="mx-auto max-w-lg px-4 pb-24 pt-6">
            <header className="mb-5 flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600">
                    <Plane size={20} className="text-white" />
                </div>
                <div>
                    <h1 className="text-xl font-bold">Swypik Fly</h1>
                    <p className="text-xs text-neutral-500">{t("finalPriceNote")}</p>
                </div>
            </header>

            {/* Formular căutare */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                <div className="grid grid-cols-2 gap-3">
                    <AirportInput
                        label={t("fromLabel")}
                        value={form.origin}
                        onChange={(iata) => setForm({ ...form, origin: iata })}
                        placeholder={t("fromPlaceholder")}
                    />
                    <AirportInput
                        label={t("toLabel")}
                        value={form.destination}
                        onChange={(iata) => setForm({ ...form, destination: iata })}
                        placeholder={t("toPlaceholder")}
                    />
                    <label className="text-xs font-medium text-neutral-500">
                        <span className="flex items-center gap-1"><CalendarDays size={12} /> {t("departure")}</span>
                        <input
                            type="date"
                            min={today}
                            value={form.departDate}
                            onChange={(e) => setForm({ ...form, departDate: e.target.value })}
                            className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800"
                        />
                    </label>
                    <label className="text-xs font-medium text-neutral-500">
                        <span className="flex items-center gap-1"><CalendarDays size={12} /> {t("returnOptional")}</span>
                        <input
                            type="date"
                            min={form.departDate}
                            value={form.returnDate}
                            onChange={(e) => setForm({ ...form, returnDate: e.target.value })}
                            className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800"
                        />
                    </label>
                    <label className="text-xs font-medium text-neutral-500">
                        <span className="flex items-center gap-1"><Users size={12} /> {t("passengers")}</span>
                        <select
                            value={form.adults}
                            onChange={(e) => setForm({ ...form, adults: Number(e.target.value) })}
                            className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800"
                        >
                            {[1, 2, 3, 4, 5, 6].map((n) => (
                                <option key={n} value={n}>{n} {n === 1 ? t("adult") : t("adults")}</option>
                            ))}
                        </select>
                    </label>
                    <button
                        onClick={() => search()}
                        disabled={loading || form.origin.length !== 3 || form.destination.length !== 3}
                        className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 px-4 py-2.5 font-semibold text-white shadow disabled:opacity-40"
                    >
                        {loading ? <Loader2 size={18} className="animate-spin" /> : <Plane size={18} />}
                        {t("search")}
                    </button>
                </div>
            </div>

            {error && (
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
            )}

            {success && (
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 p-4 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
                    <div>
                        <p className="font-semibold">{t("ticketIssued")}</p>
                        {success.bookingRef && <p className="text-sm">{t("bookingRef")}: <b>{success.bookingRef}</b></p>}
                        <p className="mt-1 text-xs">{t("detailsSent")}</p>
                    </div>
                </div>
            )}

            {/* Destinații populare — poze + prețuri "de la", ca să vândă singure */}
            {mounted && !offers && !selected && !loading && (
                <div className="mt-6">
                    <div className="mb-3 flex items-end justify-between">
                        <h2 className="text-lg font-bold">{t("popularFrom", { city: localizedCityName("București", locale) })}</h2>
                        <span className="text-[10px] text-neutral-400">{t("livePrices")}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        {(deals ?? Array.from({ length: 6 }, () => null)).map((d, i) =>
                            d ? (
                                <button
                                    key={d.iata}
                                    onClick={() => search(d.iata)}
                                    className="group relative aspect-[4/3] overflow-hidden rounded-2xl text-left shadow-sm transition active:scale-[0.98]"
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={d.image}
                                        alt={localizedCityName(d.city, locale)}
                                        className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-105"
                                        loading={i < 4 ? "eager" : "lazy"}
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
                                    <div className="absolute bottom-0 left-0 right-0 p-3">
                                        <p className="text-sm font-bold text-white drop-shadow">{localizedCityName(d.city, locale)}</p>
                                        <p className="text-[10px] text-white/80">{localizeCountryName(d.country, locale)}</p>
                                        {d.fromCents !== null && (
                                            <p className="mt-1 inline-block rounded-full bg-white/95 px-2 py-0.5 text-xs font-extrabold text-sky-700">
                                                {t("fromPrice", { price: eur(d.fromCents, d.currency) })}
                                            </p>
                                        )}
                                    </div>
                                </button>
                            ) : (
                                <div key={i} className="aspect-[4/3] animate-pulse rounded-2xl bg-neutral-200 dark:bg-neutral-800" />
                            ),
                        )}
                    </div>
                    <p className="mt-3 text-center text-[10px] text-neutral-400">
                        {t("tapDestination")}
                    </p>
                </div>
            )}

            {/* Rezultate */}
            {offers && !selected && (
                <div className="mt-5 space-y-3">
                    {/* Hero destinație — poza vinde */}
                    {(() => {
                        const deal = deals?.find((d) => d.iata === form.destination.toUpperCase());
                        return deal ? (
                            <div className="relative h-32 overflow-hidden rounded-2xl">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={deal.image} alt={localizedCityName(deal.city, locale)} className="absolute inset-0 h-full w-full object-cover" />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                                <div className="absolute bottom-3 left-4">
                                    <p className="text-xl font-extrabold text-white drop-shadow">{localizedCityName(deal.city, locale)}</p>
                                    <p className="text-xs text-white/85">{form.origin.toUpperCase()} → {deal.iata} · {form.departDate}</p>
                                </div>
                            </div>
                        ) : null;
                    })()}
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {([
                            ["all", t("filterAll", { count: offers.length })],
                            ["direct", t("filterDirect")],
                            ["cheap", t("filterCheap")],
                            ["fast", t("filterFast")],
                        ] as const).map(([k, label]) => (
                            <button
                                key={k}
                                onClick={() => setFilter(k)}
                                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${filter === k ? "bg-sky-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-neutral-500">{t("flightsFound", { count: offers.length })}</p>
                    {offers.length === 0 && <p className="rounded-xl bg-neutral-100 p-4 text-sm dark:bg-neutral-800">{t("noFlights")}</p>}
                    {(filter === "direct"
                        ? offers.filter((o) => o.stops === 0)
                        : filter === "cheap"
                            ? [...offers].sort((a, b) => a.totalCents - b.totalCents).slice(0, 20)
                            : filter === "fast"
                                ? [...offers].sort(
                                    (a, b) =>
                                        (a.slices[0]?.durationMinutes ?? 9999) - (b.slices[0]?.durationMinutes ?? 9999),
                                ).slice(0, 20)
                                : offers
                    ).map((o) => (
                        <button
                            key={o.token}
                            onClick={() => startCheckout(o)}
                            className="w-full rounded-2xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition active:scale-[0.99] dark:border-neutral-800 dark:bg-neutral-900"
                        >
                            {o.slices.map((s, i) => (
                                <div key={i} className={`flex items-center justify-between ${i > 0 ? "mt-2 border-t border-dashed border-neutral-200 pt-2 dark:border-neutral-700" : ""}`}>
                                    <div className="text-center">
                                        <p className="text-lg font-bold">{hhmm(s.segments[0].departAt)}</p>
                                        <p className="text-xs text-neutral-500">{s.origin}</p>
                                    </div>
                                    <div className="flex-1 px-3 text-center">
                                        <p className="text-[10px] text-neutral-400">{dur(s.durationMinutes)}</p>
                                        <div className="relative my-1 h-px bg-neutral-300 dark:bg-neutral-600">
                                            <ArrowRight size={12} className="absolute -top-1.5 right-0 text-neutral-400" />
                                        </div>
                                        <p className="text-[10px] text-neutral-400">
                                            {s.segments.length - 1 === 0 ? t("direct") : t("stops", { count: s.segments.length - 1 })}
                                        </p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-lg font-bold">{hhmm(s.segments[s.segments.length - 1].arriveAt)}</p>
                                        <p className="text-xs text-neutral-500">{s.destination}</p>
                                    </div>
                                </div>
                            ))}
                            <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-2 dark:border-neutral-800">
                                <span className="flex items-center gap-2 text-xs text-neutral-500">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={airlineLogo(o.carrier)}
                                        alt={o.carrierName || o.carrier}
                                        className="h-5 w-12 object-contain object-left"
                                        loading="lazy"
                                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                    />
                                    {o.carrierName || o.carrier} · {o.provider === "duffel" ? t("instantIssue") : t("viaKiwi")}
                                </span>
                                <span className="text-lg font-extrabold text-sky-600 dark:text-sky-400">{eur(o.totalCents, o.currency)}</span>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* Checkout */}
            {selected && (
                <div className="mt-5 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                    <div className="mb-3 flex items-center justify-between">
                        <h2 className="font-bold">{t("passengersPayment")}</h2>
                        <button onClick={() => setSelected(null)} className="text-xs text-neutral-500 underline">{t("backToResults")}</button>
                    </div>

                    {passengers.map((p, i) => (
                        <div key={i} className="mb-3 grid grid-cols-2 gap-2">
                            <p className="col-span-2 text-xs font-medium text-neutral-500">{t("passengerN", { n: i + 1 })}</p>
                            <input
                                placeholder={t("firstName")}
                                value={p.givenName}
                                onChange={(e) => setPassengers(passengers.map((x, j) => (j === i ? { ...x, givenName: e.target.value } : x)))}
                                className="rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                            />
                            <input
                                placeholder={t("lastName")}
                                value={p.familyName}
                                onChange={(e) => setPassengers(passengers.map((x, j) => (j === i ? { ...x, familyName: e.target.value } : x)))}
                                className="rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                            />
                            <label className="col-span-2 text-xs text-neutral-500">
                                {t("birthDate")}
                                <input
                                    type="date"
                                    value={p.bornOn}
                                    onChange={(e) => setPassengers(passengers.map((x, j) => (j === i ? { ...x, bornOn: e.target.value } : x)))}
                                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                                />
                            </label>
                        </div>
                    ))}

                    <div className="grid grid-cols-2 gap-2">
                        <input
                            placeholder={t("contactEmail")}
                            type="email"
                            value={contact.email}
                            onChange={(e) => setContact({ ...contact, email: e.target.value })}
                            className="rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                        />
                        <input
                            placeholder={t("phone")}
                            value={contact.phone}
                            onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                            className="rounded-xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                        />
                    </div>

                    {priceNotice && (
                        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">{priceNotice}</div>
                    )}

                    <div className="mt-4 flex items-center justify-between">
                        <span className="text-sm text-neutral-500">{t("totalToPay")}</span>
                        <span className="text-2xl font-extrabold">{eur(selected.totalCents, selected.currency)}</span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                            onClick={() => pay("wallet")}
                            disabled={booking || !passengersValid}
                            className="flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                        >
                            {booking ? <Loader2 size={16} className="animate-spin" /> : <Wallet size={16} />} {tFly("walletButton")}
                        </button>
                        <button
                            onClick={() => pay("stripe")}
                            disabled={booking || !passengersValid}
                            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 px-4 py-3 font-semibold text-white disabled:opacity-40"
                        >
                            {booking ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />} {tFly("cardButton")}
                        </button>
                    </div>
                    <p className="mt-2 text-center text-[10px] text-neutral-400">
                        {t("priceRecheck")}
                    </p>
                </div>
            )}
        </div>
    );
}
