import { dbQuery } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, ShieldCheck, CreditCard, User, Store } from "lucide-react";
import { updateSellerProfile } from "../actions";
import SaveSellerButton from "./SaveSellerButton";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

type SellerDetail = {
  user_id: string;
  email: string | null;
  user_status: string;
  profile_id: string;
  handle: string;
  display_name: string | null;
  verification_status: string;
  payout_status: string;
  bio: string | null;
  website_url: string | null;
  created_at: string;
};

export default async function EditSellerPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminPage("commerce"))) return <AdminForbidden />;
  const { id } = await params;
  const t = await getTranslations("adminSellers");
  const { rows } = await dbQuery<SellerDetail>(`
    SELECT
      u.id as user_id,
      u.email,
      u.status as user_status,
      c.id as profile_id,
      c.handle,
      c.display_name,
      c.verification_status,
      c.payout_status,
      c.bio,
      c.website_url,
      c.created_at
    FROM users u
    JOIN creator_profiles c ON u.id = c.user_id
    WHERE c.id = $1
  `, [id]);

  if (rows.length === 0) {
    notFound();
  }

  const seller = rows[0];

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <Link href="/admin/sellers" className="inline-flex items-center text-sm font-bold text-slate-500 hover:text-slate-900 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> {t("backToSellers")}
        </Link>
      </div>

      <form action={updateSellerProfile.bind(null, seller.profile_id)}>
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-black text-slate-900 mb-2">{t("manageSeller")}</h1>
            <p className="text-slate-500 font-mono text-sm">{seller.profile_id}</p>
          </div>
          <div className="flex gap-4">
            <SaveSellerButton />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2 space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <Store className="w-5 h-5 text-slate-400" /> {t("storeProfile")}
              </h2>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-bold text-slate-700 mb-1">{t("displayName")}</label>
                    <input
                      type="text"
                      name="display_name"
                      defaultValue={seller.display_name ?? ""}
                      className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-700 mb-1">{t("handleLabel")}</label>
                    <input
                      type="text"
                      name="handle"
                      required
                      defaultValue={seller.handle}
                      className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("bioLabel")}</label>
                  <textarea
                    name="bio"
                    rows={3}
                    defaultValue={seller.bio ?? ""}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("websiteUrlLabel")}</label>
                  <input
                    type="url"
                    name="website_url"
                    defaultValue={seller.website_url ?? ""}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <User className="w-5 h-5 text-slate-400" /> {t("userAccount")}
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("emailLabel")}</label>
                  <input
                    type="email"
                    defaultValue={seller.email ?? ""}
                    disabled
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-500 cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("accountStatus")}</label>
                  <input
                    type="text"
                    defaultValue={seller.user_status}
                    disabled
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-500 cursor-not-allowed"
                  />
                  <Link
                    href={`/admin/users?q=${encodeURIComponent(seller.email ?? "")}`}
                    className="mt-1 inline-block text-xs font-bold text-orange-600 hover:underline"
                  >
                    {t("manageStatusInUsers")} &rarr;
                  </Link>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-slate-400" /> {t("verification")}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("statusLabel")}</label>
                  <select
                    name="verification_status"
                    defaultValue={seller.verification_status}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                  >
                    <option value="unverified">{t("verificationUnverified")}</option>
                    <option value="pending">{t("verificationPending")}</option>
                    <option value="verified">{t("verificationVerified")}</option>
                    <option value="rejected">{t("verificationRejected")}</option>
                  </select>
                </div>
                {seller.verification_status === "verified" && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700 font-medium">
                    {t("verifiedBadgeNote")}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-slate-400" /> {t("payouts")}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">{t("stripeConnect")}</label>
                  <select
                    name="payout_status"
                    defaultValue={seller.payout_status}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-colors outline-none"
                  >
                    <option value="not_connected">{t("payoutNotConnected")}</option>
                    <option value="pending">{t("payoutPending")}</option>
                    <option value="connected">{t("payoutConnected")}</option>
                    <option value="restricted">{t("payoutRestricted")}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
