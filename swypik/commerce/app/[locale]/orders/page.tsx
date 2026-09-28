import type { Metadata } from "next";
import ActivityClient from "./ActivityClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Comenzile mele — Swypik",
  description: "Comenzile tale Eats și cursele Go, într-o singură listă.",
  robots: { index: false, follow: false },
};

export default function OrdersPage() {
  return <ActivityClient />;
}
