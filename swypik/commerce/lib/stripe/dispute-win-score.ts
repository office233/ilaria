/**
 * Estimates the probability of winning a Stripe dispute (chargeback) based on
 * evidence completeness + reason code + order context.
 *
 * Score 0-100 (heuristic, NOT statistical — based on public Stripe guides + best
 * practices). Note: actual outcome depends on the issuing bank + the concrete
 * evidence, not on the score.
 *
 * IMPORTANT (i18n): this module must stay locale-free. It returns stable keys +
 * params only; callers (e.g. app/admin/disputes/page.tsx) translate them via the
 * `adminDisputeScore` i18n namespace. Do NOT add hardcoded human-readable strings
 * here — add a new key + translations in the i18n fragment instead.
 */

export type DisputeReason =
  | "credit_not_processed"
  | "duplicate"
  | "fraudulent"
  | "general"
  | "incorrect_account_details"
  | "insufficient_funds"
  | "product_not_received"
  | "product_unacceptable"
  | "subscription_canceled"
  | "unrecognized"
  | string;

export type EvidenceFields = Record<string, unknown> | null | undefined;

/** Translation key + interpolation params, resolved client-side via t(labelKey, params). */
export type I18nMessage = {
  key: string;
  params?: Record<string, string | number>;
};

export type WinScore = {
  score: number; // 0-100
  label: "low" | "medium" | "high";
  factors: { tag: string; delta: number; noteKey: string; noteParams?: Record<string, string | number> }[];
  recommendationKey: string;
  missing: MissingSuggestion[]; // top missing fields sorted by impact
  combos: ComboScenario[]; // top 2 + top 3 if there are enough suggestions
};

export type MissingSuggestion = {
  key: string;
  labelKey: string; // translation key for the field label
  potentialDelta: number; // score points gained if this field is completed
  newScore: number; // estimated score after completion
};

export type ComboScenario = {
  size: number; // how many fields in the combo (2 or 3)
  keys: string[]; // combo keys
  labelKeys: string[]; // translation keys for display
  newScore: number; // estimated score if all are completed together
  delta: number; // difference vs baseline
};

// Translation key for each evidence field label — see `adminDisputeScore.field.*`
// in the i18n fragment. Keep in sync with FIELD_LABEL_KEYS below.
const FIELD_LABEL_KEYS: Record<string, string> = {
  receipt: "field.receipt",
  shipping_documentation: "field.shippingDocumentation",
  service_documentation: "field.serviceDocumentation",
  customer_signature: "field.customerSignature",
  customer_communication: "field.customerCommunication",
  refund_policy: "field.refundPolicy",
  shipping_tracking_number: "field.shippingTrackingNumber",
  shipping_carrier: "field.shippingCarrier",
  shipping_address: "field.shippingAddress",
  shipping_date: "field.shippingDate",
  customer_name: "field.customerName",
  customer_email_address: "field.customerEmailAddress",
  customer_communication_text: "field.customerCommunicationText",
  product_description: "field.productDescription",
  refund_policy_disclosure: "field.refundPolicyDisclosure",
};

// Relevant fields to propose + alias per field-name for "what input to fill in the UI"
const ALL_FIELDS = Object.keys(FIELD_LABEL_KEYS);

const REASON_BASELINE: Record<string, number> = {
  // Approximate baseline win-rate per Stripe guide + public experience
  fraudulent: 20, // hard to win without AVS+CVV match + 3DS
  unrecognized: 25, // similar to fraudulent
  product_not_received: 55, // proven with tracking → good chance
  product_unacceptable: 45, // depends on photos + return policy
  duplicate: 65, // easy to prove with 2 charge IDs
  credit_not_processed: 60, // proven with refund receipt
  subscription_canceled: 50, // proven with logs
  incorrect_account_details: 40,
  insufficient_funds: 70, // usually won (buyer responsibility)
  general: 45,
};

function has(ev: EvidenceFields, key: string): boolean {
  if (!ev || typeof ev !== "object") return false;
  // Index access on a type with known keys: `Record<string, unknown>` is exactly
  // what's needed, and `unknown` forces us to check the type below — unlike
  // `as any`, which would let anything through.
  const v = (ev as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0;
}

function computeRaw(
  reason: string,
  ev: EvidenceFields,
  hasOrderLink: boolean,
): { score: number; factors: WinScore["factors"] } {
  const factors: WinScore["factors"] = [];
  let score = REASON_BASELINE[reason] ?? 45;
  factors.push({
    tag: `reason:${reason}`,
    delta: 0,
    noteKey: "factor.reasonBaseline",
    noteParams: { reason, score },
  });

  // Strong evidence files (Stripe weights file_ids the most)
  if (has(ev, "receipt")) {
    score += 6;
    factors.push({ tag: "receipt", delta: +6, noteKey: "factor.receipt" });
  }
  if (has(ev, "shipping_documentation")) {
    score += 10;
    factors.push({ tag: "shipping_doc", delta: +10, noteKey: "factor.shippingDoc" });
  }
  if (has(ev, "customer_signature")) {
    score += 8;
    factors.push({ tag: "signature", delta: +8, noteKey: "factor.signature" });
  }
  if (has(ev, "customer_communication")) {
    score += 5;
    factors.push({ tag: "comm_file", delta: +5, noteKey: "factor.commFile" });
  }
  if (has(ev, "service_documentation")) {
    score += 5;
    factors.push({ tag: "service_doc", delta: +5, noteKey: "factor.serviceDoc" });
  }
  if (has(ev, "refund_policy")) {
    score += 3;
    factors.push({ tag: "refund_policy", delta: +3, noteKey: "factor.refundPolicy" });
  }

  // Text evidence
  if (has(ev, "shipping_tracking_number")) {
    score += 10;
    factors.push({ tag: "tracking", delta: +10, noteKey: "factor.tracking" });
  }
  if (has(ev, "shipping_carrier")) {
    score += 3;
    factors.push({ tag: "carrier", delta: +3, noteKey: "factor.carrier" });
  }
  if (has(ev, "shipping_address")) {
    score += 4;
    factors.push({ tag: "shipping_addr", delta: +4, noteKey: "factor.shippingAddr" });
  }
  if (has(ev, "shipping_date")) {
    score += 3;
    factors.push({ tag: "shipping_date", delta: +3, noteKey: "factor.shippingDate" });
  }
  if (has(ev, "customer_name") && has(ev, "customer_email_address")) {
    score += 3;
    factors.push({ tag: "customer_id", delta: +3, noteKey: "factor.customerId" });
  }
  if (has(ev, "customer_communication_text")) {
    score += 4;
    factors.push({ tag: "comm_text", delta: +4, noteKey: "factor.commText" });
  }
  if (has(ev, "product_description")) {
    score += 2;
    factors.push({ tag: "product_desc", delta: +2, noteKey: "factor.productDesc" });
  }
  if (has(ev, "refund_policy_disclosure")) {
    score += 3;
    factors.push({ tag: "refund_text", delta: +3, noteKey: "factor.refundText" });
  }

  // Penalty: dispute with no evidence at all
  const evKeys = ev && typeof ev === "object" ? Object.keys(ev).filter((k) => has(ev, k)) : [];
  if (evKeys.length === 0) {
    score -= 25;
    factors.push({ tag: "no_evidence", delta: -25, noteKey: "factor.noEvidence" });
  }

  // Bonus if there's an order link (means we can prove the sale)
  if (hasOrderLink) {
    score += 4;
    factors.push({ tag: "order_linked", delta: +4, noteKey: "factor.orderLinked" });
  } else {
    score -= 5;
    factors.push({ tag: "no_order", delta: -5, noteKey: "factor.noOrder" });
  }

  // Strong synergy: shipping_documentation + tracking + signature for product_not_received
  if (
    reason === "product_not_received" &&
    has(ev, "shipping_documentation") &&
    has(ev, "shipping_tracking_number")
  ) {
    score += 8;
    factors.push({ tag: "synergy_pnr", delta: +8, noteKey: "factor.synergyPnr" });
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), factors };
}

export function scoreDispute(input: {
  reason?: string | null;
  evidence?: EvidenceFields;
  hasOrderLink?: boolean;
}): WinScore {
  const reason = (input.reason || "general").toLowerCase();
  const ev: Record<string, unknown> = (input.evidence as Record<string, unknown> | undefined) ?? {};
  const hasOrderLink = Boolean(input.hasOrderLink);

  const baseline = computeRaw(reason, ev, hasOrderLink);

  // Compute what each unfilled field would gain if it were completed
  const missing: MissingSuggestion[] = [];
  for (const key of ALL_FIELDS) {
    if (has(ev, key)) continue;
    const hypothetical = { ...ev, [key]: "filled" };
    const sim = computeRaw(reason, hypothetical, hasOrderLink);
    const delta = sim.score - baseline.score;
    if (delta > 0) {
      missing.push({
        key,
        labelKey: FIELD_LABEL_KEYS[key] || key,
        potentialDelta: delta,
        newScore: sim.score,
      });
    }
  }
  missing.sort((a, b) => b.potentialDelta - a.potentialDelta);

  const score = baseline.score;
  let label: WinScore["label"];
  let recommendationKey: string;
  if (score >= 65) {
    label = "high";
    recommendationKey = "recommendation.high";
  } else if (score >= 40) {
    label = "medium";
    recommendationKey = "recommendation.medium";
  } else {
    label = "low";
    recommendationKey =
      reason === "fraudulent" || reason === "unrecognized"
        ? "recommendation.lowFraud"
        : "recommendation.low";
  }

  const topMissing = missing.slice(0, 5);

  // Combo calculation: what would happen if top 2 or top 3 are completed together
  const combos: ComboScenario[] = [];
  for (const size of [2, 3]) {
    if (topMissing.length < size) continue;
    const keys = topMissing.slice(0, size).map((m) => m.key);
    const hypothetical: Record<string, unknown> = { ...ev };
    for (const k of keys) hypothetical[k] = "filled";
    const sim = computeRaw(reason, hypothetical, hasOrderLink);
    const delta = sim.score - score;
    if (delta > 0) {
      combos.push({
        size,
        keys,
        labelKeys: keys.map((k) => FIELD_LABEL_KEYS[k] || k),
        newScore: sim.score,
        delta,
      });
    }
  }

  return {
    score,
    label,
    factors: baseline.factors,
    recommendationKey,
    missing: topMissing,
    combos,
  };
}
