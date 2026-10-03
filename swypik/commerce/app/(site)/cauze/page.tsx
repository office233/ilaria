import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import CausesPanelClient from "./CausesPanelClient";

export const metadata = { title: "Panou cauze — Swypik Cares" };

export const dynamic = "force-dynamic";

// Swypik Cares e ascuns (FEATURE_CARES=off) până există un partener ONG.
export default function CausesPanelPage() {
  if (!isEnabled("cares")) notFound();
  return <CausesPanelClient />;
}
