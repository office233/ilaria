"use client";

/**
 * Starea checkout-ului Food: date livrare, taxă de livrare (quote de la server,
 * aceeași logică ca la plasare), bacșiș, plată, plasarea comenzii.
 * Erorile API vin ca și coduri stabile și se traduc în UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CartLine } from "@/lib/food/types";
import { readFoodError } from "../useFoodError";

export type SavedAddress = { id: string; label: string | null; line1: string; line2: string | null; city: string; lat: number | null; lng: number | null; details: string | null; is_default: boolean };
export type PayMethod = "cash" | "card_online";
export type PlacedOrder = { id: string; order_number: string; tracking_token: string | null };
export type CardPayment = { client_secret: string; amount_cents: number };

export const TIP_PRESETS = [0, 5, 10, 15] as const;

/** Token-ul guest al unei comenzi (pentru tracking fără cont). */
export const orderTokenKey = (orderId: string) => `swypik_food_order_token_${orderId}`;

export function useCheckout(args: {
  merchantId: string;
  fixedFeeCents: number;
  open: boolean;
  lines: CartLine[];
  subtotal: number;
  /** Stripe configurat pe server — altfel cardul nu se oferă (audit #16). */
  cardAvailable: boolean;
}) {
  const { merchantId, fixedFeeCents, open, lines, subtotal, cardAvailable } = args;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const addressRef = useRef(address);
  addressRef.current = address;
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [feeQuote, setFeeQuote] = useState<number | null>(null);
  const [outOfRange, setOutOfRange] = useState(false);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [tipPct, setTipPct] = useState<number>(0);
  const [tipCustom, setTipCustom] = useState("");
  const [payMethod, setPayMethod] = useState<PayMethod>("cash");
  const [placing, setPlacing] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const applySaved = useCallback((a: SavedAddress) => {
    setAddress([a.line1, a.line2, a.city].filter(Boolean).join(", "));
    // Adresă salvată fără coordonate → clientul trebuie s-o caute / pună pinul
    // (raza de livrare se verifică pe coordonate — audit #8).
    setCoords(a.lat != null && a.lng != null && !(a.lat === 0 && a.lng === 0) ? { lat: a.lat, lng: a.lng } : null);
    if (a.details) setNotes(a.details);
  }, []);

  // Adrese salvate (doar logat; 401 → listă goală = checkout guest).
  useEffect(() => {
    if (!open) return;
    fetch("/api/users/me/addresses", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { addresses?: SavedAddress[]; data?: SavedAddress[] } | null) => {
        const list = d?.addresses ?? d?.data ?? [];
        if (!Array.isArray(list) || !list.length) return;
        setSaved(list);
        const def = list.find((a) => a.is_default) ?? list[0];
        if (def && !addressRef.current) applySaved(def);
      })
      .catch(() => undefined);
  }, [open, applySaved]);

  // Quote taxă de livrare pentru coordonatele alese.
  useEffect(() => {
    if (!coords) return;
    const ctrl = new AbortController();
    fetch(`/api/merchants/${merchantId}/delivery-quote?lat=${coords.lat}&lng=${coords.lng}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { success?: boolean; quote?: { fee_cents?: number; out_of_range?: boolean } }) => {
        if (d.success && typeof d.quote?.fee_cents === "number") setFeeQuote(d.quote.fee_cents);
        setOutOfRange(Boolean(d.quote?.out_of_range));
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [coords, merchantId]);

  const deliveryFee = feeQuote ?? fixedFeeCents;
  const tipCents = useMemo(() => {
    if (tipCustom.trim()) {
      const v = Math.round(Number(tipCustom.replace(",", ".")) * 100);
      return Number.isFinite(v) && v > 0 ? Math.min(v, 100_000) : 0;
    }
    return Math.round((subtotal * tipPct) / 100);
  }, [tipCustom, tipPct, subtotal]);
  const total = subtotal + (subtotal > 0 ? deliveryFee : 0) + tipCents;
  const needsLocation = address.trim().length >= 5 && !coords;
  const valid =
    name.trim().length >= 2 && phone.trim().length >= 5 && address.trim().length >= 5 && !!coords && !outOfRange && lines.length > 0;
  const effectivePayMethod: PayMethod = cardAvailable ? payMethod : "cash";

  const place = useCallback(async (): Promise<{ order: PlacedOrder; payment: CardPayment | null } | null> => {
    setErrorCode(null);
    setPlacing(true);
    try {
      const res = await fetch("/api/local-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant_id: merchantId,
          items: lines.map((l) => ({ menu_item_id: l.menu_item_id, qty: l.qty, option_ids: l.option_ids })),
          customer_name: name,
          customer_phone: phone,
          delivery_address: address,
          delivery_lat: coords?.lat,
          delivery_lng: coords?.lng,
          delivery_notes: notes || undefined,
          payment_method: effectivePayMethod,
          tip_cents: tipCents,
        }),
      });
      if (!res.ok) {
        setErrorCode((await readFoodError(res)) ?? "server_error");
        return null;
      }
      const data = (await res.json()) as {
        order: { id: string; order_number: string };
        tracking_token?: string | null;
        payment?: CardPayment | null;
        payment_error?: string;
      };
      const order: PlacedOrder = { id: data.order.id, order_number: data.order.order_number, tracking_token: data.tracking_token ?? null };
      if (order.tracking_token) {
        try {
          localStorage.setItem(orderTokenKey(order.id), order.tracking_token);
        } catch {
          /* ignore */
        }
      }
      if (effectivePayMethod === "card_online" && !data.payment?.client_secret) setErrorCode("payment_init_failed");
      return { order, payment: data.payment ?? null };
    } catch {
      setErrorCode("server_error");
      return null;
    } finally {
      setPlacing(false);
    }
  }, [address, coords, lines, merchantId, name, notes, effectivePayMethod, phone, tipCents]);

  return {
    fields: { name, setName, phone, setPhone, address, setAddress, coords, setCoords, notes, setNotes, saved, applySaved },
    tip: { tipPct, setTipPct, tipCustom, setTipCustom, tipCents },
    payMethod: effectivePayMethod, setPayMethod, cardAvailable,
    deliveryFee, total, outOfRange, needsLocation, valid, placing, errorCode, place,
  };
}
