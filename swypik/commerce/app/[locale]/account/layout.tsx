import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contul meu — Swypik",
  robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
