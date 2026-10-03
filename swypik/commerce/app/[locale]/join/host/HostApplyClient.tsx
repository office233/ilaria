"use client";

/**
 * Înrolare gazdă Swypik Stays — flux serios, cu verificare.
 * POST /api/hosts/apply → status pending; publicarea se face DOAR după
 * review manual (verificăm certificatul de clasificare, dreptul asupra
 * proprietății și conformitatea fiscală).
 */
import { useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { BedDouble, CheckCircle2, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import PartnerLanding from "@/components/join/PartnerLanding";

const PROPERTY_TYPES = [
    { value: "apartament", label: "Apartament" },
    { value: "casa", label: "Casă" },
    { value: "cabana", label: "Cabană" },
    { value: "vila", label: "Vilă" },
    { value: "pensiune", label: "Pensiune" },
    { value: "hotel", label: "Hotel" },
];

const ENTITY_TYPES = [
    { value: "persoana_fizica", label: "Persoană fizică (max. 5 camere)" },
    { value: "pfa", label: "PFA / ÎI" },
    { value: "srl", label: "SRL" },
];

export default function HostApplyClient() {
  const t = useTranslations("hostApply");
    const tj = useTranslations("join");
    const th = useTranslations("staysHost");
    const [form, setForm] = useState({
        full_name: "", phone: "", email: "",
        entity_type: "persoana_fizica", company_name: "", cui: "", cnp: "",
        property_name: "", property_type: "apartament",
        address: "", city: "", county: "",
        rooms: 1, max_guests: 2,
        classification_cert: "", tourism_registered: false,
    });
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const needsCert = form.property_type === "pensiune" || form.property_type === "hotel";
    const isCompany = form.entity_type === "pfa" || form.entity_type === "srl";

    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const v = e.target.type === "checkbox"
            ? (e.target as HTMLInputElement).checked
            : e.target.type === "number" ? Number(e.target.value) : e.target.value;
        setForm((f) => ({ ...f, [k]: v }));
    };

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            const res = await fetch("/api/hosts/apply", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...form,
                    company_name: form.company_name || undefined,
                    cui: form.cui || undefined,
                    cnp: form.cnp || undefined,
                    classification_cert: form.classification_cert || undefined,
                }),
            });
            const data = await res.json().catch(() => ({}));
            // Aplicația cere cont: fără el, o aplicație aprobată n-ar putea deveni gazdă.
            if (res.status === 401) { setError(th("loginToApply")); return; }
            if (!res.ok) { setError(data.error ?? th("applyFailed")); return; }
            setDone(true);
        } catch {
            setError(th("applyFailed"));
        } finally {
            setLoading(false);
        }
    }

    if (done) {
        return (
            <main className="grid min-h-screen place-items-center bg-[#FAFAFB] px-4 dark:bg-neutral-950">
                <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-sm ring-1 ring-black/5 dark:bg-neutral-900">
                    <CheckCircle2 size={48} className="mx-auto text-emerald-500" />
                    <h1 className="mt-4 text-xl font-bold">{tj("hostApply.submitted")}</h1>
                    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                        
                        {t("echipaSwypikVerificaDocumentele")}
                    </p>
                    <Link href="/stays" className="mt-6 inline-block rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-5 py-2.5 font-semibold text-white">
                        
                        {t("inapoiLaStays")}
                    </Link>
                </div>
            </main>
        );
    }

    const input = "mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-800";
    const label = "block text-xs font-medium text-neutral-500";

    return (
        <PartnerLanding
            accent="#0D9488"
            portalLabel="Swypik Stays · Gazde"
            headline={tj("hostHero1")}
            headlineMuted={tj("hostHero2")}
            subheadline={tj("hostHeroSub")}
            ctaLabel={tj("hostFormCta")}
            whyTitle={tj("whyUs")}
            features={[
                { title: tj("hostF1t"), description: tj("hostF1d") },
                { title: tj("hostF2t"), description: tj("hostF2d") },
                { title: tj("hostF3t"), description: tj("hostF3d") },
            ]}
            stepsTitle={tj("howItWorks")}
            steps={[
                { title: tj("hostS1t"), description: tj("hostS1d") },
                { title: tj("hostS2t"), description: tj("hostS2d") },
                { title: tj("hostS3t"), description: tj("hostS3d") },
                { title: tj("hostS4t"), description: tj("hostS4d") },
            ]}
            earningsTitle={tj("earningsTitleHost")}
            earningsParagraphs={[tj("hostE1"), tj("hostE2"), tj("hostE3")]}
            faqTitle={tj("faqTitle")}
            faqs={[
                { q: tj("hostQ1"), a: tj("hostA1") },
                { q: tj("hostQ2"), a: tj("hostA2") },
                { q: tj("hostQ3"), a: tj("hostA3") },
                { q: tj("hostQ4"), a: tj("hostA4") },
            ]}
            formTitle={tj("hostFormTitle")}
            formSubtitle={tj("hostFormSub")}
        >
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-sky-50 p-3 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                <ShieldCheck size={16} className="mt-0.5 shrink-0" />
                <span>
                    
                    {t("verificamFiecareProprietateInainte")}
                </span>
            </div>

            <form onSubmit={submit} className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                <fieldset className="space-y-3">
                    <legend className="text-sm font-bold">{t("dateDeContact")}</legend>
                    <label className={label}>Nume complet
                        <input required value={form.full_name} onChange={set("full_name")} className={input} placeholder="Ion Popescu" />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <label className={label}>Telefon
                            <input required type="tel" value={form.phone} onChange={set("phone")} className={input} placeholder="07xx xxx xxx" />
                        </label>
                        <label className={label}>Email
                            <input required type="email" value={form.email} onChange={set("email")} className={input} placeholder="nume@exemplu.ro" />
                        </label>
                    </div>
                </fieldset>

                <fieldset className="space-y-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
                    <legend className="text-sm font-bold">{tj("hostApply.legalForm")}</legend>
                    <label className={label}>{t("inchiriezCa")}
                        <select value={form.entity_type} onChange={set("entity_type")} className={input}>
                            {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </label>
                    {isCompany && (
                        <div className="grid grid-cols-2 gap-3">
                            <label className={label}>{t("denumireFirma")}
                                <input required value={form.company_name} onChange={set("company_name")} className={input} />
                            </label>
                            <label className={label}>CUI / CIF
                                <input required value={form.cui} onChange={set("cui")} className={input} placeholder="RO12345678" />
                            </label>
                        </div>
                    )}
                    {!isCompany && (
                        <label className={label}>CNP
                            <input
                                required
                                value={form.cnp}
                                onChange={set("cnp")}
                                inputMode="numeric"
                                pattern="\d{13}"
                                maxLength={13}
                                autoComplete="off"
                                className={input}
                                placeholder="13 cifre"
                            />
                            <span className="mt-1 block text-[11px] text-neutral-400">
                                
                                {t("obligatoriuLegalRaportareAnaf")}
                            </span>
                        </label>
                    )}
                </fieldset>

                <fieldset className="space-y-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
                    <legend className="text-sm font-bold">Proprietatea</legend>
                    <label className={label}>Denumire
                        <input required value={form.property_name} onChange={set("property_name")} className={input} placeholder={t("casaCuMolizi")} />
                    </label>
                    <label className={label}>Tip
                        <select value={form.property_type} onChange={set("property_type")} className={input}>
                            {PROPERTY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </label>
                    <label className={label}>{t("adresaCompleta")}
                        <input required value={form.address} onChange={set("address")} className={input} placeholder={tj("hostApply.addressPlaceholder")} />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <label className={label}>Localitate
                            <input required value={form.city} onChange={set("city")} className={input} placeholder="Sinaia" />
                        </label>
                        <label className={label}>{t("judet")}
                            <input required value={form.county} onChange={set("county")} className={input} placeholder="Prahova" />
                        </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <label className={label}>Camere
                            <input required type="number" min={1} max={200} value={form.rooms} onChange={set("rooms")} className={input} />
                        </label>
                        <label className={label}>{t("oaspetiMax")}
                            <input required type="number" min={1} max={500} value={form.max_guests} onChange={set("max_guests")} className={input} />
                        </label>
                    </div>
                    {form.entity_type === "persoana_fizica" && form.rooms > 5 && (
                        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                            
                            {t("peste5CamereAi")}
                        </p>
                    )}
                    {needsCert && (
                        <label className={label}>{t("nrCertificatDeClasificare")}
                            <input required value={form.classification_cert} onChange={set("classification_cert")} className={input} placeholder="ex: 12345/2024" />
                            <span className="mt-1 block text-[11px] text-neutral-400">
                                
                                {t("obligatoriuPentruPensiuniSi")}
                            </span>
                        </label>
                    )}
                </fieldset>

                <label className="flex items-start gap-2 border-t border-neutral-100 pt-4 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
                    <input required type="checkbox" checked={form.tourism_registered} onChange={set("tourism_registered")} className="mt-0.5" />
                    <span>
                        
                        {t("confirmCaActivitateaDe")}
                    </span>
                </label>

                {error && (
                    <div className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2.5 font-semibold text-white shadow disabled:opacity-40"
                >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <BedDouble size={16} />}
                    {loading ? "Se trimite..." : "Trimite aplicația"}
                </button>
            </form>
        </PartnerLanding>
    );
}
