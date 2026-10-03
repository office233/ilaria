import { dbQuery } from "@/lib/db";
import { getTranslations } from "next-intl/server";
import { logger } from "@/lib/logger";
import { approveSeller } from "./actions";
import ApproveSellerButton from "./ApproveSellerButton";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

type SellerRow = {
  id: string;
  name: string | null;
  cui: string | null;
  email: string | null;
  phone: string | null;
  product_type: string | null;
  status: string | null;
};

export default async function SellersAdminPage() {
  if (!(await requireAdminPage("commerce"))) return <AdminForbidden />;
  const t = await getTranslations("adminSellers");
  let sellers: SellerRow[] = [];
  try {
    const res = await dbQuery<SellerRow>("SELECT id, name, cui, email, phone, product_type, status FROM sellers ORDER BY created_at DESC");
    sellers = res.rows;
  } catch (err) {
    // Fallback if created_at doesn't exist
    try {
      const resFallback = await dbQuery<SellerRow>("SELECT id, name, cui, email, phone, product_type, status FROM sellers");
      sellers = resFallback.rows;
    } catch (fallbackErr) {
      logger.error({ err, fallbackErr }, "[admin/sellers] sellers table might not exist or columns differ");
    }
  }

  return (
    <div className="p-4 md:p-8">
      <h1 className="text-3xl font-black text-[#0D0D0D] mb-6">{t("pageTitle")}</h1>
      <div className="bg-white rounded-2xl shadow-sm border border-[#E5E5E5] overflow-x-auto">
        <table className="w-full text-left min-w-[640px]">
          <thead className="bg-[#F7F7F8] border-b border-[#E5E5E5] text-sm font-bold text-[#0D0D0D]">
            <tr>
              <th className="px-6 py-4">{t("thId")}</th>
              <th className="px-6 py-4">{t("thName")}</th>
              <th className="px-6 py-4">{t("thEmail")}</th>
              <th className="px-6 py-4">{t("thStatus")}</th>
              <th className="px-6 py-4 text-right">{t("thActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E5] text-sm">
            {sellers.map((seller) => (
              <tr key={seller.id} className="hover:bg-[#F7F7F8]/50 transition">
                <td className="px-6 py-4 font-mono text-xs text-gray-500">
                  {String(seller.id).split("-")[0]}...
                </td>
                <td className="px-6 py-4 font-medium text-[#0D0D0D]">{seller.name}</td>
                <td className="px-6 py-4 text-gray-600">{seller.email}</td>
                <td className="px-6 py-4">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                      seller.status === "approved"
                        ? "bg-neutral-100 text-neutral-900"
                        : seller.status === "pending"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {seller.status || t("unknownStatus")}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  {seller.status !== "approved" && seller.status !== "active" ? (
                    <form action={approveSeller.bind(null, seller.id)}>
                      <ApproveSellerButton />
                    </form>
                  ) : (
                    <span className="text-xs text-gray-400">&mdash;</span>
                  )}
                </td>
              </tr>
            ))}
            {sellers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                  {t("noSellersRegistered")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
