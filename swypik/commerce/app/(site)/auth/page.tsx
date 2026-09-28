import { redirect } from "next/navigation";

type Props = {
  searchParams: Promise<{ tab?: string; next?: string }>;
};

export const dynamic = "force-dynamic";

export default async function AuthIndexPage({ searchParams }: Props) {
  const sp = await searchParams;
  const nextRaw = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "";
  const qs = nextRaw ? `?next=${encodeURIComponent(nextRaw)}` : "";
  if (sp.tab === "signup") redirect(`/auth/signup${qs}`);
  redirect(`/auth/login${qs}`);
}
