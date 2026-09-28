"use client";

import { useEffect, useState } from "react";
import { MapPin, Plus, Pencil, Trash2, Star, Loader2, X } from "lucide-react";
import { useTranslations, useLocale } from "next-intl";
import { apiErrorMessage } from "@/lib/i18n/api-error";

type Address = {
  id: string;
  label: string | null;
  recipient_name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country_code: string;
  is_default: boolean;
};

const COUNTRIES = [
  { code: "RO", name: "România" },
  { code: "MD", name: "Republica Moldova" },
  { code: "BG", name: "Bulgaria" },
  { code: "HU", name: "Ungaria" },
  { code: "DE", name: "Germania" },
  { code: "FR", name: "Franța" },
  { code: "IT", name: "Italia" },
  { code: "ES", name: "Spania" },
  { code: "GB", name: "Marea Britanie" },
];

type FormState = {
  id?: string;
  label: string;
  recipient_name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  is_default: boolean;
};

const EMPTY_FORM: FormState = {
  label: "",
  recipient_name: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postal_code: "",
  country_code: "RO",
  is_default: false,
};

export default function AddressesClient() {
  const t = useTranslations("addresses");
  const locale = useLocale();
  const [items, setItems] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/users/me/addresses");
      const j = await r.json();
      setItems(j.addresses || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const startCreate = () => setEditing({ ...EMPTY_FORM, is_default: items.length === 0 });
  const startEdit = (a: Address) =>
    setEditing({
      id: a.id,
      label: a.label || "",
      recipient_name: a.recipient_name,
      phone: a.phone || "",
      line1: a.line1,
      line2: a.line2 || "",
      city: a.city,
      region: a.region || "",
      postal_code: a.postal_code,
      country_code: a.country_code,
      is_default: a.is_default,
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? "PATCH" : "POST";
      const url = editing.id ? `/api/users/me/addresses/${editing.id}` : "/api/users/me/addresses";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(apiErrorMessage(j, locale, t("eroareLaSalvare")));
        return;
      }
      if (!editing.id && editing.is_default) {
        // is_default set via POST already
      }
      setEditing(null);
      showToast(t("adresaSalvata"));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (id: string) => {
    await fetch(`/api/users/me/addresses/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set_default: true }),
    });
    showToast(t("adresaImplicitaActualizata"));
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm(t("confirmStergeAdresa"))) return;
    await fetch(`/api/users/me/addresses/${id}`, { method: "DELETE" });
    showToast(t("adresaStearsa"));
    await load();
  };

  return (
    <main className="mx-auto max-w-2xl p-5 text-white">
      <h1 className="mb-1 text-2xl font-black">{t("adreseDeLivrare")}</h1>
      <p className="mb-6 text-sm text-white/60">{t("gestioneazaAdreseleUndePrimesti")}</p>

      <button
        onClick={startCreate}
        className="mb-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#7C3AED] py-3 text-sm font-black text-white hover:bg-[#E0264A]"
      >
        <Plus size={16} />  {t("adaugaAdresaNoua")}
      </button>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-white/40" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center text-sm text-white/50">
          
          {t("nuAiNicioAdresa")}
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MapPin size={16} className="text-white/60" />
                  <span className="text-sm font-bold">{a.label || a.recipient_name}</span>
                  {a.is_default && (
                    <span className="rounded-full bg-[#10A37F]/20 px-2 py-0.5 text-[10px] font-bold text-[#10A37F]">
                      IMPLICIT
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  {!a.is_default && (
                    <button
                      onClick={() => setDefault(a.id)}
                      title={t("seteazaCaImplicit")}
                      className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                     aria-label={t("apreciaza")}>
                      <Star size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => startEdit(a)}
                    title={t("editeaza")}
                    className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                   aria-label={t("editeaza2")}>
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => remove(a.id)}
                    title={t("sterge")}
                    className="rounded-lg p-1.5 text-white/60 hover:bg-[#7C3AED]/20 hover:text-[#7C3AED]"
                   aria-label={t("sterge2")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <p className="text-sm font-semibold">{a.recipient_name}</p>
              <p className="text-xs text-white/70">
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ""}
              </p>
              <p className="text-xs text-white/70">
                {a.postal_code} {a.city}
                {a.region ? `, ${a.region}` : ""} · {a.country_code}
              </p>
              {a.phone && <p className="mt-1 text-xs text-white/50">Tel: {a.phone}</p>}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center sm:p-4">
          <form
            onSubmit={save}
            className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-[#161616] p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-black">{editing.id ? t("editeazaAdresa") : t("adresaNoua")}</h2>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
               aria-label={t("inchide")}>
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <Input label={t("etichetaOptional")} value={editing.label} onChange={(v) => setEditing({ ...editing, label: v })} placeholder={t("acasaBirou")} />
              <Input label={t("destinatar")} value={editing.recipient_name} onChange={(v) => setEditing({ ...editing, recipient_name: v })} required />
              <Input label={t("telefon")} value={editing.phone} onChange={(v) => setEditing({ ...editing, phone: v })} placeholder="+40..." />
              <Input label={t("adresaLinia1")} value={editing.line1} onChange={(v) => setEditing({ ...editing, line1: v })} required />
              <Input label={t("adresaLinia2")} value={editing.line2} onChange={(v) => setEditing({ ...editing, line2: v })} />
              <div className="grid grid-cols-2 gap-3">
                <Input label={t("oras")} value={editing.city} onChange={(v) => setEditing({ ...editing, city: v })} required />
                <Input label={t("judet")} value={editing.region} onChange={(v) => setEditing({ ...editing, region: v })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label={t("codPostal")} value={editing.postal_code} onChange={(v) => setEditing({ ...editing, postal_code: v })} required />
                <div>
                  <label className="mb-1 block text-xs font-bold text-white/60">{t("tara")}</label>
                  <select
                    value={editing.country_code}
                    onChange={(e) => setEditing({ ...editing, country_code: e.target.value })}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm focus:outline-none focus:border-[#7C3AED]"
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code} className="bg-[#161616]">{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.is_default}
                  onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
                  className="accent-[#7C3AED]"
                />
                <span className="text-white/80">{t("seteazaCaAdresaImplicita")}</span>
              </label>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#7C3AED] py-3 text-sm font-black text-white hover:bg-[#E0264A] disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("salveaza")}
            </button>
          </form>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-[#10A37F] px-5 py-2 text-sm font-bold text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}

function Input(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  const t = useTranslations("addresses");
  return (
    <div>
      <label className="mb-1 block text-xs font-bold text-white/60">{props.label}</label>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        required={props.required}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm focus:outline-none focus:border-[#7C3AED]"
      />
    </div>
  );
}
