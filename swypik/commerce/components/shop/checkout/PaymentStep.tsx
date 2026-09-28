"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AddressElement, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Link } from "@/lib/i18n/navigation";
import { APP_URL } from "@/lib/app-url";

type SavedAddress = {
  id: string;
  label: string | null;
  recipient_name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country_code: string;
  is_default: boolean;
};

const SHIPPING_COUNTRIES = (process.env.NEXT_PUBLIC_SHOP_SHIPPING_COUNTRIES || "RO")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter((c) => /^[A-Z]{2}$/.test(c));

type Props = { orderId: string; lookupToken: string; payLabel: string; nativeApp?: boolean };

/** Adresă (salvată sau nouă) + plată Stripe; butonul de plată e în bara fixă de jos. */
export function PaymentStep({ orderId, lookupToken, payLabel, nativeApp = false }: Props) {
  const t = useTranslations("shopBuyer.checkout");
  const stripe = useStripe();
  const elements = useElements();
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [addressId, setAddressId] = useState("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me/addresses", { cache: "no-store", credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { addresses?: SavedAddress[] } | null) => {
        if (cancelled || !data?.addresses?.length) return;
        setAddresses(data.addresses);
        setAddressId((data.addresses.find((a) => a.is_default) ?? data.addresses[0]).id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const saved = addresses.find((a) => a.id === addressId);
  const defaults = saved
    ? {
        name: saved.recipient_name,
        phone: saved.phone ?? undefined,
        address: {
          line1: saved.line1,
          line2: saved.line2 ?? undefined,
          city: saved.city,
          state: saved.region ?? undefined,
          postal_code: saved.postal_code,
          country: saved.country_code,
        },
      }
    : { address: { country: SHIPPING_COUNTRIES[0] ?? "RO" } };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError(null);
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message || t("errorValidation"));
      setBusy(false);
      return;
    }
    // return_url pe originea canonică (swypik.com), nu pe window.location.origin:
    // întoarcerea de la bancă/wallet trebuie să ajungă pe domeniul pe care îl
    // deschide aplicația (App Links pe https://swypik.com).
    const successPath = window.location.pathname.replace(/\/checkout\/?$/, "/checkout/success");
    const returnUrl = `${APP_URL}${successPath}?order_id=${encodeURIComponent(orderId)}&order_token=${encodeURIComponent(lookupToken)}`;
    if (nativeApp) {
      // În aplicație PaymentIntent-ul e creat fără metode cu redirect: plata se
      // confirmă în pagină (3DS în iframe), apoi mergem singuri la confirmare.
      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      if (confirmError) {
        setError(confirmError.message || t("errorPayment"));
        setBusy(false);
        return;
      }
      window.location.assign(`${returnUrl}&payment_intent=${encodeURIComponent(paymentIntent?.id ?? "")}&redirect_status=${encodeURIComponent(paymentIntent?.status ?? "")}`);
      return;
    }
    const { error: confirmError } = await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } });
    // La succes Stripe redirecționează; aici ajungem doar cu eroare.
    if (confirmError) setError(confirmError.message || t("errorPayment"));
    setBusy(false);
  };

  return (
    <form id="checkout-payment" onSubmit={submit} className="space-y-4">
      <Card padding="md" className="space-y-3">
        <h2 className="text-base font-semibold text-fg">{t("address")}</h2>
        {addresses.length > 0 ? (
          <Field label={t("savedAddress")}>
            {(f) => (
              <Select
                {...f}
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                options={[
                  ...addresses.map((a) => ({ value: a.id, label: `${a.label ? `${a.label} — ` : ""}${a.recipient_name}, ${a.line1}, ${a.city}` })),
                  { value: "new", label: t("newAddress") },
                ]}
              />
            )}
          </Field>
        ) : null}
        <AddressElement
          key={addressId}
          options={{ mode: "shipping", allowedCountries: SHIPPING_COUNTRIES, fields: { phone: "always" }, defaultValues: defaults }}
        />
        <Link href="/account/addresses" className="inline-flex min-h-[2.75rem] items-center text-sm text-brand">
          {t("manageAddresses")}
        </Link>
      </Card>

      <Card padding="md" className="space-y-3">
        <h2 className="text-base font-semibold text-fg">{t("payment")}</h2>
        <PaymentElement options={{ layout: "tabs" }} />
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {t("secure")}
        </p>
      </Card>

      {error ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div
        className="fixed inset-x-0 z-header border-t border-subtle bg-surface/95 px-gutter py-3 shadow-elev-3 backdrop-blur-xl lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none"
        style={{ bottom: "var(--bottom-inset)" }}
      >
        <div className="mx-auto max-w-5xl">
          <Button type="submit" form="checkout-payment" block size="lg" loading={busy} disabled={!stripe || !elements}>
            {busy ? t("processing") : payLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
