/**
 * ID-uri de conturi speciale — sursă unică, override prin env pe medii
 * diferite (dev/staging au alte UUID-uri în DB).
 *
 * NEXT_PUBLIC_ pentru că e citit și din componente client (OnboardingGate).
 */
export const SWYPIK_OFFICIAL_ID =
  process.env.NEXT_PUBLIC_SWYPIK_OFFICIAL_USER_ID ||
  "bf3ba871-b369-4669-b7f9-2e0ab5eecebe";
