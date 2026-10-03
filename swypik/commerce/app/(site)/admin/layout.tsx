import type { ReactNode } from "react";
import type { Metadata } from "next";
import { getAdminActor, isBreakGlassEnabled } from "@/lib/security/admin-auth";
import AdminLoginForm from "./AdminLoginForm";
import AdminShell from "./AdminShell";

export const metadata: Metadata = {
  title: "Swypik Admin",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await getAdminActor();
  if (!actor || actor.role === "machine") {
    return <AdminLoginForm breakGlass={isBreakGlassEnabled()} />;
  }

  return (
    <AdminShell
      identity={{
        email: actor.email,
        username: actor.username,
        role: actor.role,
        breakGlass: actor.kind === "break_glass",
      }}
    >
      {children}
    </AdminShell>
  );
}
