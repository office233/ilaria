"use client";

/**
 * Panou cauze (Swypik Cares): înregistrare beneficiar, creare campanii
 * (doar cauze verificate) și raportare cheltuieli cu dovezi (prin /api/upload).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { apiErrorMessage } from "@/lib/i18n/api-error";

type Cause = {
  id: string;
  kind: string;
  name: string;
  verification_status: string;
  location_city: string | null;
};

type Campaign = {
  id: string;
  cause_id: string;
  title: string;
  status: string;
  goal_cents: number;
  raised_cents: number;
  currency: string;
};

type Expense = {
  id: string;
  amount_cents: number;
  purpose: string;
  proof_url: string | null;
  status: string;
  created_at: string;
};

function lei(cents: number): string {
  return (cents / 100).toLocaleString("ro-RO", { maximumFractionDigits: 2 });
}

export default function CausesPanelClient() {
  const t = useTranslations("causesPanel");
  const locale = useLocale();
  const VERIF_LABELS: Record<string, string> = {
    pending: t("verifPending"),
    in_review: t("verifInReview"),
    verified: t("verifVerified"),
    rejected: t("verifRejected"),
  };
  const [causes, setCauses] = useState<Cause[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [expenses, setExpenses] = useState<Record<string, Expense[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [regForm, setRegForm] = useState({
    kind: "ngo", name: "", description: "", legal_id: "",
    contact_name: "", contact_email: "", contact_phone: "", location_city: "",
  });
  const [campForm, setCampForm] = useState({ cause_id: "", title: "", story: "", goal: "" });
  const [expForm, setExpForm] = useState({ campaign_id: "", amount: "", purpose: "", proof_url: "" });
  const [uploading, setUploading] = useState(false);

  const verifiedCauses = causes.filter((c) => c.verification_status === "verified");

  const load = useCallback(async () => {
    try {
      const [cRes, campRes] = await Promise.all([
        fetch("/api/causes"),
        fetch("/api/campaigns/manage"),
      ]);
      if (cRes.status === 401) {
        setError(t("authRequired"));
        return;
      }
      const cData = (await cRes.json()) as { causes?: Cause[] };
      const campData = (await campRes.json()) as { campaigns?: Campaign[] };
      setCauses(cData.causes ?? []);
      setCampaigns(campData.campaigns ?? []);
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function registerCause(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/causes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: regForm.kind,
        name: regForm.name,
        description: regForm.description || undefined,
        legal_id: regForm.legal_id || undefined,
        contact_name: regForm.contact_name,
        contact_email: regForm.contact_email,
        contact_phone: regForm.contact_phone || undefined,
        location_city: regForm.location_city || undefined,
      }),
    });
    const data = (await res.json()) as { success?: boolean; error?: string; code?: string };
    if (res.ok && data.success) {
      setMsg(t("registered"));
      setRegForm({ kind: "ngo", name: "", description: "", legal_id: "", contact_name: "", contact_email: "", contact_phone: "", location_city: "" });
      void load();
    } else {
      setMsg(apiErrorMessage(data, locale, t("registerError")));
    }
  }

  async function createCampaign(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg(null);
    const goalCents = Math.round(Number(campForm.goal) * 100);
    if (!campForm.cause_id || !Number.isFinite(goalCents) || goalCents < 100) {
      setMsg(t("campaignInvalid"));
      return;
    }
    const res = await fetch("/api/campaigns/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cause_id: campForm.cause_id,
        title: campForm.title,
        story: campForm.story || undefined,
        goal_cents: goalCents,
      }),
    });
    const data = (await res.json()) as { success?: boolean; error?: string; code?: string };
    if (res.ok && data.success) {
      setMsg(t("campaignCreated"));
      setCampForm({ cause_id: "", title: "", story: "", goal: "" });
      void load();
    } else {
      setMsg(apiErrorMessage(data, locale, t("createError")));
    }
  }

  async function uploadProof(file: File): Promise<void> {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("scope", "cares-proofs");
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { success?: boolean; url?: string; error?: string };
      if (res.ok && data.url) {
        setExpForm((p) => ({ ...p, proof_url: data.url ?? "" }));
      } else {
        setMsg(data.error ?? t("uploadError"));
      }
    } finally {
      setUploading(false);
    }
  }

  async function reportExpense(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg(null);
    const amountCents = Math.round(Number(expForm.amount) * 100);
    if (!expForm.campaign_id || !Number.isFinite(amountCents) || amountCents <= 0 || !expForm.proof_url) {
      setMsg(t("expenseInvalid"));
      return;
    }
    const res = await fetch("/api/campaigns/manage/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_id: expForm.campaign_id,
        amount_cents: amountCents,
        purpose: expForm.purpose,
        proof_url: expForm.proof_url,
      }),
    });
    const data = (await res.json()) as { success?: boolean; error?: string; code?: string };
    if (res.ok && data.success) {
      setMsg(t("expenseReported"));
      const cid = expForm.campaign_id;
      setExpForm({ campaign_id: "", amount: "", purpose: "", proof_url: "" });
      void loadExpenses(cid);
    } else {
      setMsg(apiErrorMessage(data, locale, t("reportError")));
    }
  }

  const loadExpenses = useCallback(async (campaignId: string) => {
    const res = await fetch(`/api/campaigns/manage/expenses?campaign_id=${campaignId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { expenses?: Expense[] };
    setExpenses((prev) => ({ ...prev, [campaignId]: data.expenses ?? [] }));
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-500">{t("loading")}</div>;
  if (error) return <div className="p-8 text-center text-red-600">{error}</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4">
      <header>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-gray-500">{t("subtitle")}</p>
      </header>

      {msg && <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{msg}</div>}

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">{t("myCauses")}</h2>
        {causes.length === 0 ? (
          <p className="text-sm text-gray-400">{t("noCauses")}</p>
        ) : (
          <ul className="space-y-2">
            {causes.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded border p-3 text-sm">
                <span>{c.name} <span className="text-gray-400">({c.kind})</span></span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.verification_status === "verified" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                  }`}>
                  {VERIF_LABELS[c.verification_status] ?? c.verification_status}
                </span>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(e) => void registerCause(e)} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select className="rounded border px-3 py-2 text-sm" value={regForm.kind}
            onChange={(e) => setRegForm((p) => ({ ...p, kind: e.target.value }))}>
            <option value="ngo">{t("kindNgo")}</option>
            <option value="family">{t("kindFamily")}</option>
            <option value="small_business">{t("kindSmallBusiness")}</option>
            <option value="community">{t("kindCommunity")}</option>
            <option value="emergency">{t("kindEmergency")}</option>
          </select>
          <input required className="rounded border px-3 py-2 text-sm" placeholder={t("causeName")}
            value={regForm.name} onChange={(e) => setRegForm((p) => ({ ...p, name: e.target.value }))} />
          <input className="rounded border px-3 py-2 text-sm" placeholder={t("legalId")}
            value={regForm.legal_id} onChange={(e) => setRegForm((p) => ({ ...p, legal_id: e.target.value }))} />
          <input className="rounded border px-3 py-2 text-sm" placeholder={t("city")}
            value={regForm.location_city} onChange={(e) => setRegForm((p) => ({ ...p, location_city: e.target.value }))} />
          <input required className="rounded border px-3 py-2 text-sm" placeholder={t("contactName")}
            value={regForm.contact_name} onChange={(e) => setRegForm((p) => ({ ...p, contact_name: e.target.value }))} />
          <input required type="email" className="rounded border px-3 py-2 text-sm" placeholder={t("contactEmail")}
            value={regForm.contact_email} onChange={(e) => setRegForm((p) => ({ ...p, contact_email: e.target.value }))} />
          <input className="rounded border px-3 py-2 text-sm" placeholder={t("contactPhone")}
            value={regForm.contact_phone} onChange={(e) => setRegForm((p) => ({ ...p, contact_phone: e.target.value }))} />
          <textarea className="rounded border px-3 py-2 text-sm sm:col-span-2" rows={2} placeholder={t("description")}
            value={regForm.description} onChange={(e) => setRegForm((p) => ({ ...p, description: e.target.value }))} />
          <button type="submit" className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 sm:col-span-2">
            {t("registerBtn")}
          </button>
        </form>
      </section>

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">{t("campaigns")}</h2>
        {campaigns.length > 0 && (
          <ul className="mb-4 space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.title}</span>
                  <span className="text-xs text-gray-500">{c.status}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded bg-gray-100">
                  <div className="h-full bg-rose-500" style={{ width: `${Math.min(100, (c.raised_cents / Math.max(1, c.goal_cents)) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-gray-500">{lei(c.raised_cents)} / {lei(c.goal_cents)} {c.currency}</p>
                <button onClick={() => void loadExpenses(c.id)} className="mt-1 text-xs text-blue-600 underline">
                  {t("viewExpenses")}
                </button>
                {expenses[c.id] && (
                  <ul className="mt-2 space-y-1 border-t pt-2 text-xs text-gray-600">
                    {expenses[c.id].length === 0 && <li>{t("noExpenses")}</li>}
                    {expenses[c.id].map((x) => (
                      <li key={x.id}>
                        {t("expenseLine", { amount: lei(x.amount_cents) })} — {x.purpose} ({x.status})
                        {x.proof_url && (
                          <a href={x.proof_url} target="_blank" rel="noopener noreferrer" className="ml-1 text-blue-600 underline">{t("proofLink")}</a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {verifiedCauses.length === 0 ? (
          <p className="text-sm text-amber-600">{t("needVerified")}</p>
        ) : (
          <form onSubmit={(e) => void createCampaign(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <select required className="rounded border px-3 py-2 text-sm" value={campForm.cause_id}
              onChange={(e) => setCampForm((p) => ({ ...p, cause_id: e.target.value }))}>
              <option value="">{t("chooseCause")}</option>
              {verifiedCauses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input required className="rounded border px-3 py-2 text-sm" placeholder={t("campaignTitle")}
              value={campForm.title} onChange={(e) => setCampForm((p) => ({ ...p, title: e.target.value }))} />
            <input required inputMode="decimal" className="rounded border px-3 py-2 text-sm" placeholder={t("goalPlaceholder")}
              value={campForm.goal} onChange={(e) => setCampForm((p) => ({ ...p, goal: e.target.value }))} />
            <textarea className="rounded border px-3 py-2 text-sm sm:col-span-2" rows={2} placeholder={t("storyPlaceholder")}
              value={campForm.story} onChange={(e) => setCampForm((p) => ({ ...p, story: e.target.value }))} />
            <button type="submit" className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 sm:col-span-2">
              {t("createCampaign")}
            </button>
          </form>
        )}
      </section>

      {campaigns.length > 0 && (
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">{t("reportExpenseTitle")}</h2>
          <form onSubmit={(e) => void reportExpense(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <select required className="rounded border px-3 py-2 text-sm" value={expForm.campaign_id}
              onChange={(e) => setExpForm((p) => ({ ...p, campaign_id: e.target.value }))}>
              <option value="">{t("chooseCampaign")}</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <input required inputMode="decimal" className="rounded border px-3 py-2 text-sm" placeholder={t("amountPlaceholder")}
              value={expForm.amount} onChange={(e) => setExpForm((p) => ({ ...p, amount: e.target.value }))} />
            <input required className="rounded border px-3 py-2 text-sm sm:col-span-2" placeholder={t("purposePlaceholder")}
              value={expForm.purpose} onChange={(e) => setExpForm((p) => ({ ...p, purpose: e.target.value }))} />
            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-600">
                {t("proofLabel")}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block text-sm"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadProof(f); }} />
              </label>
              {uploading && <p className="text-xs text-gray-400">{t("loading")}</p>}
              {expForm.proof_url && <p className="text-xs text-green-600">{t("proofUploaded")}</p>}
            </div>
            <button type="submit" disabled={uploading}
              className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50 sm:col-span-2">
              {t("reportBtn")}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
