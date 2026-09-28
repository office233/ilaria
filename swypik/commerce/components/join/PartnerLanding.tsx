"use client";

/**
 * PartnerLanding — layout comun pentru paginile de recrutare partener
 * (șofer Go, curier Food, franciză), în stilul paginii /become-a-seller,
 * dar cu identitate de culoare per vertical și conținut explicativ complet:
 * hero → argumente „de ce noi" → cum funcționează (pași) → câștiguri → FAQ → formular.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";

export type Feature = { title: string; description: string };
export type Step = { title: string; description: string };
export type Faq = { q: string; a: string };

type Props = {
    /** Culoarea verticalei (ex. #F59E0B pentru Go). */
    accent: string;
    /** Eticheta discretă din dreapta sus (ex. „Swypik Go · Șoferi"). */
    portalLabel: string;
    headline: string;
    headlineMuted: string;
    subheadline: string;
    ctaLabel: string;
    whyTitle: string;
    features: Feature[];
    stepsTitle?: string;
    steps?: Step[];
    earningsTitle?: string;
    earningsParagraphs?: string[];
    faqTitle?: string;
    faqs?: Faq[];
    formTitle: string;
    formSubtitle: string;
    children: ReactNode;
};

export default function PartnerLanding({
    accent,
    portalLabel,
    headline,
    headlineMuted,
    subheadline,
    ctaLabel,
    whyTitle,
    features,
    stepsTitle,
    steps = [],
    earningsTitle,
    earningsParagraphs = [],
    faqTitle,
    faqs = [],
    formTitle,
    formSubtitle,
    children,
}: Props) {
    return (
        <div className="min-h-screen bg-white font-sans text-black">
            <nav className="flex items-center justify-between border-b border-[#E5E5E5] px-6 py-4">
                <Link href="/" className="text-2xl font-bold tracking-tight text-black">
                    Swypik
                </Link>
                <div className="rounded-full px-3 py-1 text-sm font-bold" style={{ color: accent, backgroundColor: `${accent}14` }}>
                    {portalLabel}
                </div>
            </nav>

            {/* Hero */}
            <section className="relative mx-auto max-w-4xl px-6 py-20 text-center md:py-28">
                <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-[0.07]"
                    style={{ background: `radial-gradient(ellipse at top, ${accent}, transparent 70%)` }}
                    aria-hidden
                />
                <h1 className="mb-6 text-5xl font-extrabold tracking-tight md:text-7xl">
                    <span style={{ color: accent }}>{headline}</span>
                    <br className="hidden md:block" />
                    <span className="text-gray-400"> {headlineMuted}</span>
                </h1>
                <p className="mx-auto mb-10 max-w-2xl text-lg text-gray-600 md:text-xl">{subheadline}</p>
                <a
                    href="#apply"
                    className="inline-flex items-center gap-2 rounded-full px-8 py-4 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
                    style={{ backgroundColor: accent }}
                >
                    {ctaLabel} <ArrowRight className="h-4 w-4" />
                </a>
            </section>

            {/* De ce noi */}
            <section className="border-y border-[#E5E5E5] bg-gray-50/50">
                <div className="mx-auto max-w-5xl px-6 py-16">
                    <h2 className="mb-10 text-center text-2xl font-bold tracking-tight md:text-3xl">{whyTitle}</h2>
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
                        {features.map((f) => (
                            <div key={f.title} className="flex flex-col items-center text-center">
                                <div
                                    className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
                                    style={{ backgroundColor: `${accent}14` }}
                                >
                                    <CheckCircle2 className="h-6 w-6" style={{ color: accent }} />
                                </div>
                                <h3 className="mb-2 text-lg font-semibold">{f.title}</h3>
                                <p className="text-sm leading-relaxed text-gray-500">{f.description}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Cum functioneaza */}
            {steps.length > 0 && (
                <section className="mx-auto max-w-4xl px-6 py-16">
                    <h2 className="mb-10 text-center text-2xl font-bold tracking-tight md:text-3xl">{stepsTitle}</h2>
                    <ol className="space-y-6">
                        {steps.map((s, i) => (
                            <li key={s.title} className="flex gap-4">
                                <span
                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-black text-white"
                                    style={{ backgroundColor: accent }}
                                >
                                    {i + 1}
                                </span>
                                <div className="min-w-0 pt-1">
                                    <h3 className="text-[16px] font-bold">{s.title}</h3>
                                    <p className="mt-1 text-[14px] leading-relaxed text-gray-500">{s.description}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>
            )}

            {/* Castiguri / detalii */}
            {earningsParagraphs.length > 0 && (
                <section className="border-y border-[#E5E5E5]" style={{ backgroundColor: `${accent}08` }}>
                    <div className="mx-auto max-w-3xl px-6 py-16">
                        <h2 className="mb-6 text-center text-2xl font-bold tracking-tight md:text-3xl" style={{ color: accent }}>
                            {earningsTitle}
                        </h2>
                        <div className="space-y-4">
                            {earningsParagraphs.map((p) => (
                                <p key={p.slice(0, 40)} className="text-[15px] leading-relaxed text-gray-700">{p}</p>
                            ))}
                        </div>
                    </div>
                </section>
            )}

            {/* FAQ */}
            {faqs.length > 0 && (
                <section className="mx-auto max-w-3xl px-6 py-16">
                    <h2 className="mb-8 text-center text-2xl font-bold tracking-tight md:text-3xl">{faqTitle}</h2>
                    <div className="divide-y divide-[#E5E5E5] rounded-2xl border border-[#E5E5E5]">
                        {faqs.map((f) => (
                            <FaqItem key={f.q} q={f.q} a={f.a} accent={accent} />
                        ))}
                    </div>
                </section>
            )}

            {/* Formular */}
            <section id="apply" className="border-t border-[#E5E5E5] bg-gray-50/50">
                <div className="mx-auto max-w-xl px-6 py-20">
                    <div className="mb-10 text-center">
                        <h2 className="mb-3 text-3xl font-bold tracking-tight" style={{ color: accent }}>{formTitle}</h2>
                        <p className="text-gray-500">{formSubtitle}</p>
                    </div>
                    {children}
                </div>
            </section>
        </div>
    );
}

function FaqItem({ q, a, accent }: Faq & { accent: string }) {
    const [open, setOpen] = useState(false);
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-[15px] font-bold hover:bg-gray-50"
            >
                {q}
                <ChevronDown size={18} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} style={{ color: accent }} />
            </button>
            {open && <p className="px-5 pb-5 text-[14px] leading-relaxed text-gray-600">{a}</p>}
        </div>
    );
}
