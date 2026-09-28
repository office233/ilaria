import type Stripe from "stripe";
import { persistConnectAccount } from "@/lib/stripe/connect";

export async function handleAccountUpdated(event: Stripe.Event) {
  const acc = event.data.object as Stripe.Account;
  await persistConnectAccount(acc);
}
