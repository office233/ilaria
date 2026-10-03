/**
 * Order fraud risk scoring — heuristic 0-100
 * Mai mare = risc mai mare (opus față de win-score).
 * Folosit pentru a marca comenzi care merită review manual înainte de fulfillment.
 *
 * Calibrat din pattern-uri publice Stripe Radar + experiență marketplace.
 * Toate weights sunt empirice și pot fi recalibrate după ce avem outcome real (dispute won/lost).
 */

export type OrderRiskInput = {
  totalCents: number;
  currency: string;
  itemCount: number;
  hasShippingAddress: boolean;
  shippingCountry?: string | null;       // ex: "RO"
  billingCountry?: string | null;
  ipCountry?: string | null;             // din Cloudflare cf-ipcountry la checkout
  email?: string | null;
  phone?: string | null;
  // User signals
  buyerAccountAgeDays?: number | null;   // null = guest
  emailVerified?: boolean;
  phoneVerified?: boolean;
  priorPaidOrders?: number;              // câte comenzi paid/fulfilled anterior
  priorDisputes?: number;                // câte dispute anterior
  priorChargebacksLost?: number;         // dispute pierdute (lost)
  // Order signals
  highRiskCountry?: boolean;             // țară cu rate fraud mare
  fastCheckout?: boolean;                // <30s între cart add și pay
};

export type RiskFactor = { tag: string; delta: number; note: string };

export type OrderRiskScore = {
  score: number;                          // 0-100
  level: "low" | "medium" | "high" | "critical";
  factors: RiskFactor[];
  recommendation: string;
  blockSuggested: boolean;                // true = nu fulfilla automat
};

// Țări cu rate dispute mare conform Stripe Radar public benchmarks
const HIGH_RISK_COUNTRIES = new Set(["NG", "PK", "BD", "VN", "ID", "IN", "BR", "RU", "UA"]);

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function scoreOrderRisk(input: OrderRiskInput): OrderRiskScore {
  const factors: RiskFactor[] = [];
  let score = 5; // baseline minim — orice comandă are un mic risc

  factors.push({ tag: "baseline", delta: 5, note: "Risc minim de bază" });

  // ====== USER SIGNALS ======

  if (input.buyerAccountAgeDays == null) {
    score += 25;
    factors.push({ tag: "guest_checkout", delta: +25, note: "Guest checkout (fără cont)" });
  } else {
    if (input.buyerAccountAgeDays < 1) {
      score += 20;
      factors.push({ tag: "brand_new_account", delta: +20, note: "Cont creat azi" });
    } else if (input.buyerAccountAgeDays < 7) {
      score += 12;
      factors.push({ tag: "young_account", delta: +12, note: "Cont creat acum <7 zile" });
    } else if (input.buyerAccountAgeDays < 30) {
      score += 5;
      factors.push({ tag: "newish_account", delta: +5, note: "Cont creat acum <30 zile" });
    } else if (input.buyerAccountAgeDays > 180) {
      score -= 5;
      factors.push({ tag: "established_account", delta: -5, note: "Cont vechi (>6 luni)" });
    }
  }

  if (!input.emailVerified) {
    score += 8;
    factors.push({ tag: "email_unverified", delta: +8, note: "Email NEverificat" });
  }
  if (input.phone && !input.phoneVerified) {
    score += 4;
    factors.push({ tag: "phone_unverified", delta: +4, note: "Telefon furnizat dar NEverificat" });
  } else if (input.phoneVerified) {
    score -= 3;
    factors.push({ tag: "phone_verified", delta: -3, note: "Telefon verificat" });
  }

  // ====== HISTORY SIGNALS ======

  if (input.priorPaidOrders && input.priorPaidOrders >= 3) {
    score -= 10;
    factors.push({
      tag: "loyal_customer",
      delta: -10,
      note: `${input.priorPaidOrders} comenzi anterioare livrate cu succes`,
    });
  } else if (input.priorPaidOrders === 0 || input.priorPaidOrders == null) {
    score += 6;
    factors.push({ tag: "first_order", delta: +6, note: "Prima comandă a clientului" });
  }

  if (input.priorChargebacksLost && input.priorChargebacksLost > 0) {
    score += 30;
    factors.push({
      tag: "prior_chargeback",
      delta: +30,
      note: `${input.priorChargebacksLost} chargeback(uri) pierdute anterior`,
    });
  } else if (input.priorDisputes && input.priorDisputes > 0) {
    score += 12;
    factors.push({
      tag: "prior_dispute",
      delta: +12,
      note: `${input.priorDisputes} dispute anterior (rezolvate)`,
    });
  }

  // ====== ORDER SIGNALS ======

  const amountEUR =
    input.currency.toLowerCase() === "ron"
      ? input.totalCents / 100 / 5
      : input.totalCents / 100;

  if (amountEUR > 500) {
    score += 15;
    factors.push({ tag: "high_value", delta: +15, note: `Valoare mare (>€500)` });
  } else if (amountEUR > 200) {
    score += 7;
    factors.push({ tag: "medium_high_value", delta: +7, note: "Valoare €200-500" });
  } else if (amountEUR < 5) {
    score += 8;
    factors.push({ tag: "very_low_value", delta: +8, note: "Valoare suspicios de mică (<€5) — card testing" });
  }

  if (input.itemCount > 10) {
    score += 6;
    factors.push({ tag: "many_items", delta: +6, note: `${input.itemCount} produse — comandă neobișnuit de mare` });
  }

  // ====== ADDRESS SIGNALS ======

  if (!input.hasShippingAddress) {
    score += 15;
    factors.push({ tag: "no_shipping", delta: +15, note: "Fără adresă de livrare" });
  }

  if (input.shippingCountry && input.billingCountry && input.shippingCountry !== input.billingCountry) {
    score += 10;
    factors.push({
      tag: "country_mismatch",
      delta: +10,
      note: `Țara billing (${input.billingCountry}) ≠ shipping (${input.shippingCountry})`,
    });
  }

  if (input.shippingCountry && HIGH_RISK_COUNTRIES.has(input.shippingCountry.toUpperCase())) {
    score += 12;
    factors.push({
      tag: "high_risk_country",
      delta: +12,
      note: `Livrare către țară cu rate fraud ridicat (${input.shippingCountry})`,
    });
  }

  // IP signals — Cloudflare cf-ipcountry capturat la checkout
  const ipCountry = input.ipCountry?.toUpperCase() || null;
  const shipCountry = input.shippingCountry?.toUpperCase() || null;
  if (ipCountry && shipCountry && ipCountry !== shipCountry) {
    // Stripe Radar: ~3x dispute rate când IP-country diferă de ship-country.
    score += 12;
    factors.push({
      tag: "ip_ship_mismatch",
      delta: +12,
      note: `IP (${ipCountry}) ≠ livrare (${shipCountry})`,
    });
  }
  if (ipCountry && HIGH_RISK_COUNTRIES.has(ipCountry)) {
    score += 10;
    factors.push({
      tag: "ip_high_risk_country",
      delta: +10,
      note: `IP din țară cu rate fraud ridicat (${ipCountry})`,
    });
  }
  if (!ipCountry && input.buyerAccountAgeDays == null) {
    // Guest fără IP capturat — semnal slab (proxy/VPN/Tor sau request direct la origin)
    score += 5;
    factors.push({ tag: "no_ip_country", delta: +5, note: "IP country lipsă (posibil VPN/proxy)" });
  }

  if (input.highRiskCountry) {
    score += 8;
    factors.push({ tag: "ip_country_mismatch_legacy", delta: +8, note: "IP din țară cu risc ridicat (deprecated)" });
  }

  // ====== BEHAVIOR ======

  if (input.fastCheckout) {
    score += 6;
    factors.push({ tag: "fast_checkout", delta: +6, note: "Checkout în <30s (posibil bot)" });
  }

  score = clamp(score);

  let level: OrderRiskScore["level"];
  let recommendation: string;
  let blockSuggested = false;

  if (score >= 70) {
    level = "critical";
    recommendation = "BLOCHEAZĂ fulfillment. Contactează clientul prin telefon înainte de a trimite.";
    blockSuggested = true;
  } else if (score >= 50) {
    level = "high";
    recommendation = "Review manual obligatoriu. Verifică emailul + telefonul înainte de fulfillment.";
    blockSuggested = true;
  } else if (score >= 30) {
    level = "medium";
    recommendation = "Atenție: monitorizează comanda. Fulfillment OK dar fii pregătit pentru dispute.";
  } else {
    level = "low";
    recommendation = "Risc minim — fulfillment automat OK.";
  }

  return { score, level, factors, recommendation, blockSuggested };
}
