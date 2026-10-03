"use client";

/**
 * Înrolare flotă — șoferi Swypik Go (kind=driver) și curieri Food (kind=courier).
 * POST /api/couriers (cont obligatoriu, rate-limited): aplicația se leagă de
 * cont (user_id) și apare în „Modurile mele"; fără sesiune → login.
 */
import { useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { apiErrorMessage } from "@/lib/i18n/api-error";
import PartnerLanding from "@/components/join/PartnerLanding";

const VEHICLES: { value: string; labelKey: string }[] = [
    { value: "bike", labelKey: "vBike" },
    { value: "scooter", labelKey: "vScooter" },
    { value: "motorcycle", labelKey: "vMoto" },
    { value: "car", labelKey: "vCar" },
    { value: "van", labelKey: "vVan" },
];

export default function FleetApplyClient() {
    const t = useTranslations("join");
    const locale = useLocale();
    const router = useRouter();
    const params = useSearchParams();
    const kind = params.get("kind") === "driver" ? "driver" : "courier";
    const isGo = kind === "driver";

    const [form, setForm] = useState({
        full_name: "",
        phone: "",
        email: "",
        city: "",
        vehicle_type: isGo ? "car" : "bike",
        vehicle_plate: "",
    });
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setForm((f) => ({ ...f, [k]: e.target.value }));

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            const res = await fetch("/api/couriers", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind,
                    full_name: form.full_name,
                    phone: form.phone,
                    email: form.email || undefined,
                    city: form.city,
                    vehicle_type: form.vehicle_type,
                    vehicle_plate: form.vehicle_plate || undefined,
                }),
            });
            const data = await res.json().catch(() => ({}));
            // Aplicația cere cont (audit food-go #6): fără sesiune → login, apoi înapoi aici.
            if (res.status === 401) {
                router.push(`/auth/login?next=${encodeURIComponent(`/join/fleet?kind=${kind}`)}`);
                return;
            }
            if (!res.ok || data.error) {
                setError(typeof data.error === "string" ? apiErrorMessage(data, locale, t("errGeneric")) : t("errGeneric"));
                return;
            }
            setDone(true);
        } catch {
            setError(t("errGeneric"));
        } finally {
            setLoading(false);
        }
    }

    if (done) {
        return (
            <main className="grid min-h-screen place-items-center bg-[#FAFAFB] px-4">
                <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-sm ring-1 ring-black/5">
                    <CheckCircle2 size={48} className="mx-auto text-green-500" />
                    <h1 className="mt-4 text-xl font-black text-[#0D0D0D]">{t("doneTitle")}</h1>
                    <p className="mt-2 text-[14px] text-[#6E6E80]">{isGo ? t("doneGo") : t("doneFood")}</p>
                    <button
                        type="button"
                        onClick={() => router.push(isGo ? "/courier" : "/courier")}
                        className="mt-6 w-full rounded-2xl bg-[#0D0D0D] py-3 text-[14px] font-extrabold text-white"
                    >
                        {t("openPanel")}
                    </button>
                    <Link href="/" className="mt-3 block text-[13px] font-bold text-violet-600 hover:underline">
                        {t("backHome")}
                    </Link>
                </div>
            </main>
        );
    }

    return (
        <PartnerLanding
            accent={isGo ? "#F59E0B" : "#2DBE60"}
            portalLabel={isGo ? "Swypik Go · Șoferi" : "Swypik Food · Curieri"}
            headline={isGo ? t("goHero1") : t("foodHero1")}
            headlineMuted={isGo ? t("goHero2") : t("foodHero2")}
            subheadline={isGo ? t("goHeroSub") : t("foodHeroSub")}
            ctaLabel={isGo ? t("goFormCta") : t("foodFormCta")}
            whyTitle={t("whyUs")}
            features={
                isGo
                    ? [
                        { title: t("goF1t"), description: t("goF1d") },
                        { title: t("goF2t"), description: t("goF2d") },
                        { title: t("goF3t"), description: t("goF3d") },
                    ]
                    : [
                        { title: t("foodF1t"), description: t("foodF1d") },
                        { title: t("foodF2t"), description: t("foodF2d") },
                        { title: t("foodF3t"), description: t("foodF3d") },
                    ]
            }
            stepsTitle={t("howItWorks")}
            steps={
                isGo
                    ? [
                        { title: t("goS1t"), description: t("goS1d") },
                        { title: t("goS2t"), description: t("goS2d") },
                        { title: t("goS3t"), description: t("goS3d") },
                        { title: t("goS4t"), description: t("goS4d") },
                    ]
                    : [
                        { title: t("foodS1t"), description: t("foodS1d") },
                        { title: t("foodS2t"), description: t("foodS2d") },
                        { title: t("foodS3t"), description: t("foodS3d") },
                        { title: t("foodS4t"), description: t("foodS4d") },
                    ]
            }
            earningsTitle={isGo ? t("earningsTitleGo") : t("earningsTitleFood")}
            earningsParagraphs={
                isGo
                    ? [t("goE1"), t("goE2"), t("goE3")]
                    : [t("foodE1"), t("foodE2"), t("foodE3")]
            }
            faqTitle={t("faqTitle")}
            faqs={
                isGo
                    ? [
                        { q: t("goQ1"), a: t("goA1") },
                        { q: t("goQ2"), a: t("goA2") },
                        { q: t("goQ3"), a: t("goA3") },
                        { q: t("goQ4"), a: t("goA4") },
                    ]
                    : [
                        { q: t("foodQ1"), a: t("foodA1") },
                        { q: t("foodQ2"), a: t("foodA2") },
                        { q: t("foodQ3"), a: t("foodA3") },
                        { q: t("foodQ4"), a: t("foodA4") },
                    ]
            }
            formTitle={isGo ? t("goFormTitle") : t("foodFormTitle")}
            formSubtitle={isGo ? t("goFormSub") : t("foodFormSub")}
        >
            <form onSubmit={submit} className="space-y-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                {error && (
                    <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] font-bold text-red-600">{error}</p>
                )}
                <Field label={t("fullName")}>
                    <input required minLength={3} value={form.full_name} onChange={set("full_name")} className={inputCls} autoComplete="name" />
                </Field>
                <Field label={t("phone")}>
                    <input required type="tel" minLength={5} value={form.phone} onChange={set("phone")} className={inputCls} autoComplete="tel" />
                </Field>
                <Field label={`${t("email")} (${t("optional")})`}>
                    <input type="email" value={form.email} onChange={set("email")} className={inputCls} autoComplete="email" />
                </Field>
                <Field label={t("city")}>
                    <input required minLength={2} value={form.city} onChange={set("city")} className={inputCls} autoComplete="address-level2" />
                </Field>
                <Field label={t("vehicle")}>
                    <select value={form.vehicle_type} onChange={set("vehicle_type")} className={inputCls}>
                        {(isGo ? VEHICLES.filter((v) => ["car", "van"].includes(v.value)) : VEHICLES).map((v) => (
                            <option key={v.value} value={v.value}>{t(v.labelKey)}</option>
                        ))}
                    </select>
                </Field>
                {["car", "van", "motorcycle"].includes(form.vehicle_type) && (
                    <Field label={t("plate")}>
                        <input value={form.vehicle_plate} onChange={set("vehicle_plate")} className={inputCls} placeholder="B 123 ABC" />
                    </Field>
                )}
                <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-2xl bg-[#0D0D0D] py-3.5 text-[15px] font-extrabold text-white transition active:scale-[0.98] disabled:opacity-60"
                >
                    {loading ? <Loader2 size={18} className="mx-auto animate-spin" /> : t("apply")}
                </button>
                <p className="text-center text-[11px] text-[#A1A1AA]">{t("applyNote")}</p>
            </form>
        </PartnerLanding>
    );
}

const inputCls =
    "w-full rounded-xl border border-black/10 px-3 py-2.5 text-[14px] font-semibold text-[#0D0D0D] outline-none transition focus:border-violet-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-[#A1A1AA]">{label}</span>
            {children}
        </label>
    );
}
