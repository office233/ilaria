export type RawOrderStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "fulfilled"
  | "delivered"
  | "cancelled"
  | "refunded"
  | "failed"
  | "return_requested"
  | string;

export type FulfillmentStatus =
  | "not_started"
  | "pending"
  | "processing"
  | "submitted"
  | "manual_required"
  | "pending_seller_action"
  | "partially_shipped"
  | "shipped"
  | "fulfilled"
  | "delivered"
  | "cancelled"
  | "failed"
  | string;

export type OrderStatusInput = {
  status: RawOrderStatus;
  fulfillmentStatus?: FulfillmentStatus | null;
  metadata?: Record<string, unknown> | null;
  trackingNumber?: string | null;
};

export type DerivedOrderStatus = {
  key: string;
  label: string;
  description: string;
  step: number;
  isTerminal: boolean;
  isReturnable: boolean;
};

/** Locale-uri suportate pentru `label`/`description`. Default `"ro"` — păstrează
 * comportamentul istoric pentru apelanții care nu trec `locale` explicit. */
export type OrderStatusLocale = "ro" | "en" | "es" | "fr" | "de" | "pt" | "it";

type StatusCopy = { label: string; description: string };
type StatusKey =
  | "return_requested"
  | "refunded"
  | "cancelled"
  | "failed"
  | "pending_payment"
  | "delivered"
  | "shipped"
  | "partially_shipped"
  | "manual_required"
  | "processing"
  | "pending_seller_action"
  | "paid";

// `key` (folosit de client pentru logică/iconițe) rămâne stabil pe toate
// locale-urile — doar `label`/`description` (text afișat) se traduc.
const COPY: Record<StatusKey, Record<OrderStatusLocale, StatusCopy>> = {
  return_requested: {
    ro: { label: "Retur solicitat", description: "Cererea de retur a fost inregistrata si asteapta verificare." },
    en: { label: "Return requested", description: "The return request has been recorded and is awaiting review." },
    es: { label: "Devolución solicitada", description: "La solicitud de devolución se ha registrado y está pendiente de revisión." },
    fr: { label: "Retour demandé", description: "La demande de retour a été enregistrée et est en attente de vérification." },
    de: { label: "Rücksendung angefragt", description: "Die Rücksendeanfrage wurde erfasst und wartet auf Prüfung." },
    pt: { label: "Devolução solicitada", description: "O pedido de devolução foi registado e aguarda verificação." },
    it: { label: "Reso richiesto", description: "La richiesta di reso è stata registrata ed è in attesa di verifica." },
  },
  refunded: {
    ro: { label: "Rambursata", description: "Plata a fost rambursata catre client." },
    en: { label: "Refunded", description: "The payment has been refunded to the customer." },
    es: { label: "Reembolsado", description: "El pago ha sido reembolsado al cliente." },
    fr: { label: "Remboursée", description: "Le paiement a été remboursé au client." },
    de: { label: "Erstattet", description: "Die Zahlung wurde an den Kunden erstattet." },
    pt: { label: "Reembolsado", description: "O pagamento foi reembolsado ao cliente." },
    it: { label: "Rimborsato", description: "Il pagamento è stato rimborsato al cliente." },
  },
  cancelled: {
    ro: { label: "Anulata", description: "Comanda a fost anulata." },
    en: { label: "Cancelled", description: "The order has been cancelled." },
    es: { label: "Cancelado", description: "El pedido ha sido cancelado." },
    fr: { label: "Annulée", description: "La commande a été annulée." },
    de: { label: "Storniert", description: "Die Bestellung wurde storniert." },
    pt: { label: "Cancelado", description: "A encomenda foi cancelada." },
    it: { label: "Annullato", description: "L'ordine è stato annullato." },
  },
  failed: {
    ro: { label: "Esuata", description: "Plata sau procesarea comenzii a esuat." },
    en: { label: "Failed", description: "The payment or order processing failed." },
    es: { label: "Fallido", description: "El pago o el procesamiento del pedido ha fallado." },
    fr: { label: "Échouée", description: "Le paiement ou le traitement de la commande a échoué." },
    de: { label: "Fehlgeschlagen", description: "Die Zahlung oder Bestellabwicklung ist fehlgeschlagen." },
    pt: { label: "Falhou", description: "O pagamento ou o processamento da encomenda falhou." },
    it: { label: "Non riuscito", description: "Il pagamento o l'elaborazione dell'ordine non è riuscito." },
  },
  pending_payment: {
    ro: { label: "In asteptarea platii", description: "Comanda a fost creata, dar plata nu este confirmata." },
    en: { label: "Awaiting payment", description: "The order was created, but payment is not confirmed yet." },
    es: { label: "Esperando el pago", description: "El pedido se ha creado, pero el pago aún no está confirmado." },
    fr: { label: "En attente de paiement", description: "La commande a été créée, mais le paiement n'est pas encore confirmé." },
    de: { label: "Zahlung ausstehend", description: "Die Bestellung wurde erstellt, aber die Zahlung ist noch nicht bestätigt." },
    pt: { label: "Aguardando pagamento", description: "A encomenda foi criada, mas o pagamento ainda não foi confirmado." },
    it: { label: "In attesa di pagamento", description: "L'ordine è stato creato, ma il pagamento non è ancora confermato." },
  },
  delivered: {
    ro: { label: "Livrata", description: "Comanda a fost livrata." },
    en: { label: "Delivered", description: "The order has been delivered." },
    es: { label: "Entregado", description: "El pedido ha sido entregado." },
    fr: { label: "Livrée", description: "La commande a été livrée." },
    de: { label: "Geliefert", description: "Die Bestellung wurde geliefert." },
    pt: { label: "Entregue", description: "A encomenda foi entregue." },
    it: { label: "Consegnato", description: "L'ordine è stato consegnato." },
  },
  shipped: {
    ro: { label: "Expediata", description: "Comanda a fost expediata si are tracking disponibil." },
    en: { label: "Shipped", description: "The order has shipped and tracking is available." },
    es: { label: "Enviado", description: "El pedido ha sido enviado y el seguimiento está disponible." },
    fr: { label: "Expédiée", description: "La commande a été expédiée et le suivi est disponible." },
    de: { label: "Versandt", description: "Die Bestellung wurde versandt, die Sendungsverfolgung ist verfügbar." },
    pt: { label: "Enviado", description: "A encomenda foi enviada e o rastreamento está disponível." },
    it: { label: "Spedito", description: "L'ordine è stato spedito ed è disponibile il tracciamento." },
  },
  partially_shipped: {
    ro: { label: "Expediere partiala", description: "O parte din comanda a fost expediata." },
    en: { label: "Partially shipped", description: "Part of the order has shipped." },
    es: { label: "Envío parcial", description: "Parte del pedido ha sido enviada." },
    fr: { label: "Expédition partielle", description: "Une partie de la commande a été expédiée." },
    de: { label: "Teilweise versandt", description: "Ein Teil der Bestellung wurde versandt." },
    pt: { label: "Envio parcial", description: "Parte da encomenda foi enviada." },
    it: { label: "Spedizione parziale", description: "Parte dell'ordine è stata spedita." },
  },
  manual_required: {
    ro: { label: "Necesita procesare manuala", description: "Comanda este platita, dar are nevoie de interventie pentru fulfillment." },
    en: { label: "Needs manual processing", description: "The order is paid, but needs manual intervention for fulfillment." },
    es: { label: "Requiere procesamiento manual", description: "El pedido está pagado, pero necesita intervención manual para el envío." },
    fr: { label: "Traitement manuel requis", description: "La commande est payée, mais nécessite une intervention manuelle pour l'expédition." },
    de: { label: "Manuelle Bearbeitung nötig", description: "Die Bestellung ist bezahlt, benötigt aber manuelles Eingreifen für die Auftragsabwicklung." },
    pt: { label: "Requer processamento manual", description: "A encomenda está paga, mas precisa de intervenção manual para o cumprimento." },
    it: { label: "Richiede elaborazione manuale", description: "L'ordine è pagato, ma richiede un intervento manuale per l'evasione." },
  },
  processing: {
    ro: { label: "In procesare", description: "Comanda este platita si este pregatita pentru expediere." },
    en: { label: "Processing", description: "The order is paid and being prepared for shipping." },
    es: { label: "En procesamiento", description: "El pedido está pagado y se está preparando para el envío." },
    fr: { label: "En cours de traitement", description: "La commande est payée et en préparation pour l'expédition." },
    de: { label: "In Bearbeitung", description: "Die Bestellung ist bezahlt und wird für den Versand vorbereitet." },
    pt: { label: "Em processamento", description: "A encomenda está paga e a ser preparada para envio." },
    it: { label: "In elaborazione", description: "L'ordine è pagato ed è in preparazione per la spedizione." },
  },
  pending_seller_action: {
    ro: { label: "Asteapta sellerul", description: "Sellerul trebuie sa adauge datele de expediere." },
    en: { label: "Awaiting seller", description: "The seller still needs to add the shipping details." },
    es: { label: "Esperando al vendedor", description: "El vendedor aún debe añadir los datos de envío." },
    fr: { label: "En attente du vendeur", description: "Le vendeur doit encore ajouter les informations d'expédition." },
    de: { label: "Wartet auf Verkäufer", description: "Der Verkäufer muss noch die Versanddaten hinzufügen." },
    pt: { label: "Aguardando o vendedor", description: "O vendedor ainda precisa de adicionar os dados de envio." },
    it: { label: "In attesa del venditore", description: "Il venditore deve ancora aggiungere i dati di spedizione." },
  },
  paid: {
    ro: { label: "Platita", description: "Plata a fost confirmata." },
    en: { label: "Paid", description: "The payment has been confirmed." },
    es: { label: "Pagado", description: "El pago ha sido confirmado." },
    fr: { label: "Payée", description: "Le paiement a été confirmé." },
    de: { label: "Bezahlt", description: "Die Zahlung wurde bestätigt." },
    pt: { label: "Pago", description: "O pagamento foi confirmado." },
    it: { label: "Pagato", description: "Il pagamento è stato confermato." },
  },
};

function copyFor(key: StatusKey, locale: OrderStatusLocale): StatusCopy {
  return COPY[key][locale] ?? COPY[key].ro;
}

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function getFulfillmentStatus(input: OrderStatusInput): string {
  return normalize(
    input.fulfillmentStatus ||
      (input.metadata?.fulfillment_status as string | undefined) ||
      (input.metadata?.fulfillmentStatus as string | undefined) ||
      "",
  );
}

function getTrackingNumber(input: OrderStatusInput): string {
  return String(input.trackingNumber || (input.metadata?.tracking_number as string | undefined) || "").trim();
}

export function canRequestReturn(input: OrderStatusInput): boolean {
  const status = normalize(input.status);
  const fulfillmentStatus = getFulfillmentStatus(input);
  const terminalStatuses = new Set(["cancelled", "failed", "refunded", "return_requested"]);

  if (terminalStatuses.has(status)) return false;
  if (input.metadata?.return_reason || input.metadata?.return_requested_at) return false;

  return (
    status === "fulfilled" ||
    status === "delivered" ||
    fulfillmentStatus === "fulfilled" ||
    fulfillmentStatus === "shipped" ||
    fulfillmentStatus === "delivered"
  );
}

/**
 * `locale` e opțional (default `"ro"`) ca să nu rupem apelanții existenți din
 * `app/**` care încă nu trec locale-ul cererii — vezi COPY mai sus pentru
 * traduceri pe toate cele 7 locale suportate.
 */
export function deriveOrderStatus(input: OrderStatusInput, locale: OrderStatusLocale = "ro"): DerivedOrderStatus {
  const status = normalize(input.status);
  const fulfillmentStatus = getFulfillmentStatus(input);
  const hasTracking = getTrackingNumber(input).length > 0;

  let key: StatusKey;
  let step: number;
  let isTerminal: boolean;

  if (status === "return_requested") {
    key = "return_requested"; step = 4; isTerminal = false;
  } else if (status === "refunded") {
    key = "refunded"; step = 4; isTerminal = true;
  } else if (status === "cancelled") {
    key = "cancelled"; step = 0; isTerminal = true;
  } else if (status === "failed") {
    key = "failed"; step = 0; isTerminal = true;
  } else if (status === "pending" || status === "authorized") {
    key = "pending_payment"; step = 1; isTerminal = false;
  } else if (status === "delivered" || fulfillmentStatus === "delivered") {
    key = "delivered"; step = 4; isTerminal = false;
  } else if (hasTracking || status === "fulfilled" || fulfillmentStatus === "shipped" || fulfillmentStatus === "fulfilled") {
    key = "shipped"; step = 3; isTerminal = false;
  } else if (fulfillmentStatus === "partially_shipped") {
    key = "partially_shipped"; step = 3; isTerminal = false;
  } else if (fulfillmentStatus === "manual_required") {
    key = "manual_required"; step = 2; isTerminal = false;
  } else if (fulfillmentStatus === "processing" || fulfillmentStatus === "submitted") {
    key = "processing"; step = 2; isTerminal = false;
  } else if (fulfillmentStatus === "pending_seller_action") {
    key = "pending_seller_action"; step = 2; isTerminal = false;
  } else {
    key = "paid"; step = 2; isTerminal = false;
  }

  const { label, description } = copyFor(key, locale);

  return {
    key,
    label,
    description,
    step,
    isTerminal,
    isReturnable: canRequestReturn(input),
  };
}
