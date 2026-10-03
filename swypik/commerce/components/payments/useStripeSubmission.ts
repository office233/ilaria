"use client";

import { useEffect, useRef, useState } from "react";
import { useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe, StripeElements } from "@stripe/stripe-js";

/** Keep payment forms recoverable when the SDK or network rejects unexpectedly. */
export function useStripeSubmission(validationError: string, paymentError: string) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submitPayment = async (confirm: (stripe: Stripe, elements: StripeElements) => Promise<void>) => {
    // A ref also blocks two submissions before React commits the busy state.
    if (!stripe || !elements || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await elements.submit();
      if (!mounted.current) return;
      if (result.error) {
        setError(result.error.message || validationError);
        return;
      }
      await confirm(stripe, elements);
    } catch {
      if (mounted.current) setError(paymentError);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return { stripe, elements, busy, error, setError, submitPayment };
}
