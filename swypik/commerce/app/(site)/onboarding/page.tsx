"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { TOPICS } from "@/lib/topics";

export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const toggleTopic = (id: string) => {
    const newSet = new Set(selected);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      if (newSet.size < 7) {
        newSet.add(id);
      }
    }
    setSelected(newSet);
  };

  const handleContinue = async () => {
    if (selected.size < 3) return;
    setLoading(true);
    try {
      await fetch("/api/onboarding/interests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: Array.from(selected) }),
      });
      router.push("/explore");
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const handleSkip = async () => {
    try {
      await fetch("/api/onboarding/skip", { method: "POST" });
    } catch (e) {
      console.error(e);
    }
    router.push("/explore");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Ambient glowing blobs */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-[#0D0D0D] opacity-20 rounded-full blur-[100px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-[#0D0D0D] opacity-10 rounded-full blur-[100px]"></div>
      </div>

      <div className="z-10 w-full max-w-md flex flex-col h-full mt-12 mb-12">
        <div className="flex-1">
          <h1 className="text-4xl font-black mb-2 text-center tracking-tight">{t("title")}</h1>
          <p className="text-gray-400 text-center mb-8">
            
            {t("selecteaza35IntereseFeedul")}
          </p>

          <div className="grid grid-cols-2 gap-3 mb-8">
            {TOPICS.map((topic) => {
              const isSelected = selected.has(topic.id);
              return (
                <button
                  key={topic.id}
                  onClick={() => toggleTopic(topic.id)}
                  className={`
                    flex items-center gap-2 p-4 rounded-2xl transition-all duration-300 ease-out transform
                    ${isSelected
                      ? 'bg-[#0D0D0D]/20 border-2 border-[#0D0D0D] scale-105 shadow-[0_0_15px_rgba(16,163,127,0.3)]'
                      : 'bg-white/5 border-2 border-transparent hover:bg-white/10 hover:scale-102'
                    }
                  `}
                >
                  <span className="text-2xl">{topic.icon}</span>
                  <span className="font-semibold text-sm">{topic.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 mt-auto">
          <p className="text-sm font-medium text-gray-400">
            <span className={selected.size >= 3 ? "text-[#0D0D0D]" : "text-white"}>{selected.size}</span>/5 selectate
          </p>

          <button
            onClick={handleContinue}
            disabled={selected.size < 3 || loading}
            className={`
              w-full py-4 rounded-full font-bold text-lg transition-all duration-300
              ${selected.size >= 3
                ? 'bg-[#0D0D0D] hover:bg-[#0e8c6c] text-white shadow-[0_0_20px_rgba(16,163,127,0.4)]'
                : 'bg-white/10 text-gray-500 cursor-not-allowed'
              }
            `}
          >
            {loading ? "Se configurează..." : "Începe →"}
          </button>

          <button
            onClick={handleSkip}
            className="text-sm text-gray-500 hover:text-white transition-colors"
          >
            Sari peste →
          </button>
        </div>
      </div>
    </div>
  );
}
