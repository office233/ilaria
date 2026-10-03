"use client";

import React from "react";
import { CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import PartnerLanding from "@/components/join/PartnerLanding";
import { logger } from "@/lib/logger";

export default function BecomeASellerPage() {
  const t = useTranslations("becomeaseller");
  const tj = useTranslations("join");
  return (
    <PartnerLanding
      accent="#7C3AED"
      portalLabel={t("portalLabel")}
      headline={t("zeroBataiDeCap")}
      headlineMuted={t("expuiProduseleLaMii")}
      subheadline={tj("sellerHeroSub")}
      ctaLabel={t("aplicaAcum")}
      whyTitle={tj("whyUs")}
      features={[
        { title: t("vanzariAccelerate"), description: tj("sellerF1d") },
        { title: t("platformaAutonoma"), description: tj("sellerF2d") },
        { title: t("faraCosturiAscunse"), description: tj("sellerF3d") },
      ]}
      stepsTitle={tj("howItWorks")}
      steps={[
        { title: tj("sellerS1t"), description: tj("sellerS1d") },
        { title: tj("sellerS2t"), description: tj("sellerS2d") },
        { title: tj("sellerS3t"), description: tj("sellerS3d") },
        { title: tj("sellerS4t"), description: tj("sellerS4d") },
      ]}
      earningsTitle={tj("earningsTitleSeller")}
      earningsParagraphs={[tj("sellerE1"), tj("sellerE2")]}
      faqTitle={tj("faqTitle")}
      faqs={[
        { q: tj("sellerQ1"), a: tj("sellerA1") },
        { q: tj("sellerQ3"), a: tj("sellerA3") },
        { q: tj("sellerQ4"), a: tj("sellerA4") },
      ]}
      formTitle={tj("sellerFormTitle")}
      formSubtitle={t("completeazaDetaliileCompanieiTale")}
    >
      <SellerForm />
    </PartnerLanding>
  );
}

function SellerForm() {
  const t = useTranslations("becomeaseller");
  const [status, setStatus] = React.useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("loading");

    const formData = new FormData(e.currentTarget);
    const data = {
      companyName: formData.get("companyName"),
      cui: formData.get("cui"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      productType: formData.get("productType"),
    };

    try {
      const res = await fetch("/api/apply-seller", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (res.ok) {
        setStatus("success");
      } else {
        setStatus("error");
      }
    } catch (err) {
      logger.error({ err }, "Failed to submit seller application");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="p-8 border border-[#E5E5E5] rounded-2xl bg-white text-center">
        <div className="w-16 h-16 bg-black text-white rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h3 className="text-2xl font-bold mb-2">{t("aplicatiaTaAFost")}</h3>
        <p className="text-gray-500">{t("oVomAnalizaIn")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 border border-[#E5E5E5] p-6 md:p-8 rounded-2xl bg-white">
      {status === "error" && (
        <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg">

          {t("aAparutOEroare")}
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="companyName" className="text-sm font-medium text-black block">
          {t("companyNameLabel")}
        </label>
        <input
          type="text"
          id="companyName"
          name="companyName"
          required
          autoComplete="organization"
          className="w-full px-4 py-2.5 border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition-all"
          placeholder="ex. SC Swypik SRL"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="cui" className="text-sm font-medium text-black block">
          {t("cuiLabel")}
        </label>
        <input
          type="text"
          id="cui"
          name="cui"
          required
          className="w-full px-4 py-2.5 border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition-all"
          placeholder="ex. RO12345678"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium text-black block">
            {t("emailLabel")}
          </label>
          <input
            type="email"
            id="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            className="w-full px-4 py-2.5 border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition-all"
            placeholder="contact@companie.ro"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="phone" className="text-sm font-medium text-black block">
            {t("phoneLabel")}
          </label>
          <input
            type="tel"
            id="phone"
            name="phone"
            required
            autoComplete="tel"
            inputMode="tel"
            className="w-full px-4 py-2.5 border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition-all"
            placeholder="07xx xxx xxx"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="productType" className="text-sm font-medium text-black block">

          {t("ceTipDeProduse")}
        </label>
        <textarea
          id="productType"
          name="productType"
          required
          rows={3}
          className="w-full px-4 py-2.5 border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition-all resize-none"
          placeholder={t("haineElectroniceDecoratiuniEtc")}
        />
      </div>

      <button
        type="submit"
        disabled={status === "loading"}
        className="w-full py-3.5 bg-black text-white font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
      >
        {status === "loading" ? t("submitting") : t("submitApplication")}
      </button>
    </form>
  );
}
