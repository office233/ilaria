import Link from "next/link";
import { redirect } from "next/navigation";
import AuthFormClient from "../AuthFormClient";
import { getAuthSession, resolvePostLoginRedirect } from "@/lib/auth/session";

type Props = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export const dynamic = "force-dynamic";

function pickNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "";
}

export default async function AuthSignupPage({ searchParams }: Props) {
  const { next } = await searchParams;
  const nextPath = pickNext(next);

  const session = await getAuthSession();
  if (session) {
    redirect(resolvePostLoginRedirect(session.role, nextPath || null));
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-5 pb-12 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-white">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#7C3AED] text-base font-black">S</span>
          <span className="text-lg font-black tracking-tight">swypik</span>
        </Link>
        <Link
          href={`/auth/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`}
          className="text-sm font-bold text-white/70 hover:text-white transition"
        >
          Am deja cont →
        </Link>
      </header>

      <AuthFormClient mode="signup" nextPath={nextPath} />
    </main>
  );
}
