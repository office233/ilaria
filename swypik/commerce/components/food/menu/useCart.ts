"use client";

/**
 * Coșul Food — unul per restaurant (localStorage `swypik_food_cart_<merchantId>`).
 * Prețurile din coș sunt orientative; serverul recalculează totul la plasare.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CartLine, MenuChoice, MenuItem } from "@/lib/food/types";

const cartKey = (merchantId: string) => `swypik_food_cart_${merchantId}`;

/** Id-ul stabil al unei opțiuni (id explicit sau „grup:nume”) — același ca în POST /api/local-orders. */
export const choiceId = (groupName: string, c: MenuChoice) => c.id ?? `${groupName}:${c.name}`;

const lineKey = (menuItemId: string, optionIds: string[]) => `${menuItemId}|${[...optionIds].sort().join(",")}`;

export function useCart(merchantId: string) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(cartKey(merchantId));
      if (raw) setLines(JSON.parse(raw) as CartLine[]);
    } catch {
      /* coș corupt — pornim gol */
    }
    setLoaded(true);
  }, [merchantId]);

  useEffect(() => {
    if (!loaded) return;
    try {
      if (lines.length) localStorage.setItem(cartKey(merchantId), JSON.stringify(lines));
      else localStorage.removeItem(cartKey(merchantId));
    } catch {
      /* ignore */
    }
  }, [lines, loaded, merchantId]);

  const add = useCallback((item: MenuItem, optionIds: string[]) => {
    const choices = (item.options ?? []).flatMap((o) => (o.choices ?? []).map((c) => ({ ...c, _id: choiceId(o.name, c) })));
    const chosen = optionIds.map((id) => choices.find((c) => c._id === id)).filter((c): c is MenuChoice & { _id: string } => !!c);
    const unit = item.price_cents + chosen.reduce((s, c) => s + (c.price_cents ?? 0), 0);
    const key = lineKey(item.id, optionIds);
    setLines((prev) => {
      const i = prev.findIndex((l) => lineKey(l.menu_item_id, l.option_ids) === key);
      if (i >= 0) return prev.map((l, j) => (j === i ? { ...l, qty: Math.min(99, l.qty + 1) } : l));
      return [
        ...prev,
        { menu_item_id: item.id, name: item.name, unit_price_cents: unit, qty: 1, option_ids: optionIds, option_names: chosen.map((c) => c.name) },
      ];
    });
  }, []);

  const changeQty = useCallback((index: number, delta: number) => {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, qty: Math.min(99, l.qty + delta) } : l)).filter((l) => l.qty > 0),
    );
  }, []);

  const replace = useCallback((next: CartLine[]) => setLines(next), []);
  const clear = useCallback(() => setLines([]), []);

  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.unit_price_cents * l.qty, 0), [lines]);
  const count = useMemo(() => lines.reduce((s, l) => s + l.qty, 0), [lines]);

  return { lines, add, changeQty, replace, clear, subtotal, count };
}
