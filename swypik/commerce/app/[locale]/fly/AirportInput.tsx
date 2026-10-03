"use client";

/**
 * Input aeroport cu autocomplete: scrii "bucur" sau "roma" și alegi din listă.
 * Căutare locală instant (lib/fly/airports.ts); ținem în state codul IATA
 * pentru API și afișăm orașul prietenos pentru om.
 */
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { searchAirports, AIRPORTS, Airport } from "@/lib/fly/airports";
import { localizedCityName } from "@/lib/fly/city-names";
import { Plane } from "lucide-react";

// `Airport.country` in lib/fly/airports.ts only stores the Romanian country
// name (no ISO code in the data). Map the known names to ISO 3166-1 alpha-2
// so every locale can show the country in its own language via
// Intl.DisplayNames instead of always showing the Romanian name.
const RO_COUNTRY_TO_ISO: Record<string, string> = {
    "România": "RO", Austria: "AT", UK: "GB", "Franța": "FR", Italia: "IT",
    Olanda: "NL", Spania: "ES", Portugalia: "PT", Grecia: "GR", Turcia: "TR",
    Germania: "DE", Belgia: "BE", "Elveția": "CH", Danemarca: "DK", Suedia: "SE",
    Norvegia: "NO", Finlanda: "FI", Irlanda: "IE", Cehia: "CZ", Ungaria: "HU",
    Polonia: "PL", Bulgaria: "BG", Serbia: "RS", "Croația": "HR", Albania: "AL",
    "Macedonia de Nord": "MK", Moldova: "MD", Cipru: "CY", Malta: "MT",
    EAU: "AE", Qatar: "QA", SUA: "US", Israel: "IL", Egipt: "EG", Maroc: "MA",
    Thailanda: "TH",
};

/** Localizes an `Airport.country` / destination country name for the given locale. */
export function localizeCountryName(country: string, locale: string): string {
    const code = RO_COUNTRY_TO_ISO[country];
    if (!code) return country;
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? country;
    } catch {
        return country;
    }
}

export default function AirportInput({
    label,
    value, // IATA curent (ex: "OTP")
    onChange,
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (iata: string) => void;
    placeholder?: string;
}) {
    const t = useTranslations("fly");
    const locale = useLocale();
    const known = AIRPORTS.find((a) => a.iata === value);
    const [text, setText] = useState(known ? `${localizedCityName(known.city, locale)} (${known.iata})` : value);
    const [open, setOpen] = useState(false);
    const [results, setResults] = useState<Airport[]>([]);
    const [hi, setHi] = useState(0);
    const boxRef = useRef<HTMLDivElement>(null);

    // Sincronizează afișajul când valoarea vine din exterior (ex: click pe destinație).
    useEffect(() => {
        const a = AIRPORTS.find((x) => x.iata === value);
        setText(a ? `${localizedCityName(a.city, locale)} (${a.iata})` : value);
    }, [value, locale]);

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, []);

    const handleInput = (raw: string) => {
        setText(raw);
        const trimmed = raw.trim();
        // Cod IATA introdus direct (3 litere) — acceptăm imediat.
        if (/^[A-Za-z]{3}$/.test(trimmed) && AIRPORTS.some((a) => a.iata === trimmed.toUpperCase())) {
            onChange(trimmed.toUpperCase());
        }
        const r = searchAirports(trimmed);
        setResults(r);
        setHi(0);
        setOpen(r.length > 0);
        // Text liber care nu mai corespunde selecției → invalidează IATA
        if (!trimmed) onChange("");
    };

    const pick = (a: Airport) => {
        onChange(a.iata);
        setText(`${localizedCityName(a.city, locale)} (${a.iata})`);
        setOpen(false);
    };

    return (
        <div ref={boxRef} className="relative">
            <label className="text-xs font-medium text-neutral-500">
                {label}
                <input
                    value={text}
                    onChange={(e) => handleInput(e.target.value)}
                    onFocus={() => { if (results.length) setOpen(true); }}
                    onKeyDown={(e) => {
                        if (!open) return;
                        if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
                        else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                        else if (e.key === "Enter") { e.preventDefault(); if (results[hi]) pick(results[hi]); }
                        else if (e.key === "Escape") setOpen(false);
                    }}
                    placeholder={placeholder ?? t("airportInputPlaceholder")}
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={open}
                    aria-autocomplete="list"
                    aria-controls="airport-input-listbox"
                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-800"
                />
            </label>
            {open && (
                <ul id="airport-input-listbox" role="listbox" className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                    {results.map((a, i) => (
                        <li key={a.iata} role="option" aria-selected={i === hi}>
                            <button
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); pick(a); }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${i === hi ? "bg-sky-50 dark:bg-sky-950" : ""}`}
                            >
                                <Plane size={14} className="shrink-0 text-sky-500" />
                                <span className="flex-1">
                                    <span className="font-semibold">{localizedCityName(a.city, locale)}</span>
                                    <span className="text-neutral-500"> — {a.name}, {localizeCountryName(a.country, locale)}</span>
                                </span>
                                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-bold tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                    {a.iata}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
