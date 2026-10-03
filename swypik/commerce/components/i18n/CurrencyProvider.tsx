"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CURRENCIES, type Currency } from "@/lib/i18n/config";
import { readCurrencyPreferenceCookie, saveI18nPreference } from "./preferences";

const CurrencyContext = createContext<{
  currency: Currency;
  setCurrency: (c: Currency) => void;
}>({ currency: "RON", setCurrency: () => {} });

export function useCurrency() {
  return useContext(CurrencyContext);
}

export function CurrencyProvider({
  initial,
  children,
}: {
  initial: Currency;
  children: React.ReactNode;
}) {
  const [currency, setCurrencyState] = useState<Currency>(initial);

  // Paginile [locale] sunt statice: serverul randează moneda implicită a
  // locale-ului. Preferința din cookie se aplică după hidratare (fără mismatch).
  useEffect(() => {
    const fromCookie = readCurrencyPreferenceCookie(document.cookie);
    if (fromCookie) setCurrencyState(fromCookie);
  }, []);

  const setCurrency = (c: Currency) => {
    setCurrencyState(c);
    void saveI18nPreference({ currency: c });
  };

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function CurrencySwitcher({ className }: { className?: string }) {
  const t = useTranslations("common");
  const { currency, setCurrency } = useCurrency();
  return (
    <select
      aria-label={t("currency")}
      value={currency}
      onChange={(e) => setCurrency(e.target.value as Currency)}
      className={className}
    >
      {CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}
