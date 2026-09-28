"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  Users,
  Plus,
  Search,
  Building,
  Phone,
  Mail,
  X,
} from "lucide-react";
import { logger } from "@/lib/logger";

export type ClientRow = {
  id: string;
  name: string;
  cui: string | null;
  reg_com: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  notes: string | null;
  created_at: string;
};

type Props = {
  initialClients: ClientRow[];
};

export default function ClientsClient({ initialClients }: Props) {
  const t = useTranslations("sellerBilling.clients");
  const locale = useLocale();
  const [clients, setClients] = useState<ClientRow[]>(initialClients);
  const [searchQuery, setSearchQuery] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [cui, setCui] = useState("");
  const [regCom, setRegCom] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [notes, setNotes] = useState("");

  const errorMessage = (code: string | undefined): string => {
    switch (code) {
      case "unauthorized":
        return t("errUnauthorized");
      case "rate_limited":
        return t("errRateLimited");
      case "validation_error":
        return t("errValidation");
      default:
        return t("errUnknown");
    }
  };

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/seller/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          cui,
          regCom,
          phone,
          email,
          address,
          city,
          county,
          notes,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        alert(errorMessage(data?.error));
        return;
      }

      // Use the server-returned row verbatim (normalized/trimmed server-side)
      // instead of re-deriving it from local form state.
      const newClient: ClientRow = data.client;

      setClients((prev) => [newClient, ...prev]);
      setIsModalOpen(false);
      // Reset form
      setName("");
      setCui("");
      setRegCom("");
      setPhone("");
      setEmail("");
      setAddress("");
      setCity("");
      setCounty("");
      setNotes("");
    } catch (err) {
      logger.error({ err }, "[SellerClients] create client failed");
      alert(t("errNetwork"));
    } finally {
      setSubmitting(false);
    }
  };

  const filteredClients = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.cui && c.cui.includes(searchQuery)) ||
      (c.phone && c.phone.includes(searchQuery)) ||
      (c.city && c.city.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch {
      return "—";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-3 text-neutral-400 w-4 h-4" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>

        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 bg-[#0D0D0D] hover:bg-neutral-800 text-white px-5 py-2.5 min-h-[44px] rounded-xl font-bold text-sm shadow-sm transition"
        >
          <Plus size={16} /> {t("newClient")}
        </button>
      </div>

      <div className="bg-white border border-[#E5E5E5] rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#F7F7F8] border-b border-[#E5E5E5] text-xs font-bold text-neutral-500 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">{t("thName")}</th>
                <th className="px-6 py-4">{t("thCui")}</th>
                <th className="px-6 py-4">{t("thContact")}</th>
                <th className="px-6 py-4">{t("thCity")}</th>
                <th className="px-6 py-4">{t("thAddress")}</th>
                <th className="px-6 py-4 text-right">{t("thCreatedAt")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredClients.map((c) => (
                <tr key={c.id} className="hover:bg-[#F7F7F8]/60 transition">
                  <td className="px-6 py-4 max-w-[220px]">
                    <div className="font-bold text-[#0D0D0D] flex items-center gap-2 break-words">
                      <Building className="w-4 h-4 text-violet-600 shrink-0" />
                      <span className="break-words">{c.name}</span>
                    </div>
                    {c.reg_com && (
                      <div className="text-[11px] text-neutral-400 font-mono pl-6 break-words">
                        {c.reg_com}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs font-semibold text-neutral-700 whitespace-nowrap">
                    {c.cui || "—"}
                  </td>
                  <td className="px-6 py-4 text-xs text-neutral-600 max-w-[200px]">
                    {c.phone && (
                      <div className="flex items-center gap-1.5 font-medium break-words">
                        <Phone size={12} className="text-neutral-400 shrink-0" /> {c.phone}
                      </div>
                    )}
                    {c.email && (
                      <div className="flex items-center gap-1.5 text-neutral-500 break-words">
                        <Mail size={12} className="text-neutral-400 shrink-0" /> {c.email}
                      </div>
                    )}
                    {!c.phone && !c.email && "—"}
                  </td>
                  <td className="px-6 py-4 text-xs font-medium text-neutral-700 whitespace-nowrap">
                    {c.city ? `${c.city}${c.county ? `, ${c.county}` : ""}` : "—"}
                  </td>
                  <td className="px-6 py-4 text-xs text-neutral-500 break-words max-w-xs">
                    {c.address || "—"}
                  </td>
                  <td className="px-6 py-4 text-right text-xs text-neutral-400 font-mono whitespace-nowrap">
                    {fmtDate(c.created_at)}
                  </td>
                </tr>
              ))}

              {filteredClients.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center text-neutral-400 text-sm">
                    {t("emptyState")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Adaugă Client */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full shadow-2xl space-y-5 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-4">
              <div className="flex items-center gap-2 text-lg font-black text-[#0D0D0D]">
                <Users className="w-5 h-5 text-violet-600" />
                {t("modalTitle")}
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-700"
                aria-label={t("closeModal")}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateClient} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                  {t("nameLabel")}
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("cuiLabel")}
                  </label>
                  <input
                    type="text"
                    value={cui}
                    onChange={(e) => setCui(e.target.value)}
                    placeholder={t("cuiPlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("regComLabel")}
                  </label>
                  <input
                    type="text"
                    value={regCom}
                    onChange={(e) => setRegCom(e.target.value)}
                    placeholder={t("regComPlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("phoneLabel")}
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={t("phonePlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("emailLabel")}
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("emailPlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("cityLabel")}
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder={t("cityPlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                    {t("countyLabel")}
                  </label>
                  <input
                    type="text"
                    value={county}
                    onChange={(e) => setCounty(e.target.value)}
                    placeholder={t("countyPlaceholder")}
                    className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1">
                  {t("addressLabel")}
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t("addressPlaceholder")}
                  className="w-full px-3 py-2 border border-[#E5E5E5] rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 min-h-[44px] rounded-xl border border-neutral-200 text-xs font-bold hover:bg-neutral-50"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2.5 min-h-[44px] rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold shadow-sm disabled:opacity-50"
                >
                  {submitting ? t("saving") : t("save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
