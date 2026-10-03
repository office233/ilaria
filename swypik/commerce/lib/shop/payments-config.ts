/**
 * Plățile magazinului sunt utilizabile? În producție cheile Stripe pot fi încă
 * placeholder (decizia owner-ului, PROVISIONAL_NO_PAYMENTS_EMAIL) — atunci
 * checkout-ul răspunde imediat `payments_unavailable`, fără să mai creeze o
 * comandă care ar fi marcată `failed` la primul apel Stripe.
 *
 * Aceeași regulă de placeholder ca infra/azure/preflight.sh (`is_placeholder`).
 */
const PLACEHOLDER_RE = /placeholder|changeme|<owner:/i;
const SECRET_KEY_RE = /^(sk|rk)_(test|live)_\S+$/;
const PUBLISHABLE_KEY_RE = /^pk_(test|live)_\S+$/;

function usable(value: string | undefined, re: RegExp): boolean {
  const v = value?.trim();
  return Boolean(v) && re.test(v!) && !PLACEHOLDER_RE.test(v!);
}

export function shopPaymentsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  const publishable = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  // Local/teste fără chei: nu blocăm (Stripe e mock-uit); în producție lipsa = indisponibil.
  if (!secret && !publishable) return env.NODE_ENV !== "production";
  if (secret && !usable(secret, SECRET_KEY_RE)) return false;
  if (publishable && !usable(publishable, PUBLISHABLE_KEY_RE)) return false;
  return env.NODE_ENV !== "production" || Boolean(secret && publishable);
}

/** Varianta pentru browser: doar cheia publică (inline-uită la build). */
export function publishableKeyLooksValid(key: string | undefined): key is string {
  return usable(key, PUBLISHABLE_KEY_RE);
}
