"use client";

import { useEffect, useState } from "react";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { Plus, X, Folder, Bookmark, ShoppingCart, Lightbulb, Heart, Star, Music, Plane, UtensilsCrossed, Gamepad2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

const ICON_MAP: Record<string, LucideIcon> = {
  folder: Folder,
  bookmark: Bookmark,
  cart: ShoppingCart,
  idea: Lightbulb,
  heart: Heart,
  star: Star,
  music: Music,
  plane: Plane,
  food: UtensilsCrossed,
  game: Gamepad2,
};

function CollectionIcon({ name, size = 24 }: { name?: string | null; size?: number }) {
  const Icon = (name && ICON_MAP[name]) || Folder;
  return <Icon size={size} />;
}

type Collection = {
  id: string;
  title: string;
  slug: string;
  icon: string;
  color: string;
  actual_count: string | number;
};

export default function CollectionsPage() {
  const t = useTranslations("collections");
  const tCommon = useTranslations("common");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newIcon, setNewIcon] = useState("folder");
  const [newColor, setNewColor] = useState("#0D0D0D");

  const router = useRouter();

  useEffect(() => {
    fetchCollections();
  }, []);

  const fetchCollections = async () => {
    try {
      const res = await fetch("/api/collections");
      if (res.ok) {
        const data = await res.json();
        setCollections(data.collections || []);
      }
    } catch (e) {
      console.error("Failed to fetch collections", e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, icon: newIcon, color: newColor })
      });
      if (res.ok) {
        const data = await res.json();
        setCollections([data.collection, ...collections]);
        setShowNewModal(false);
        setNewTitle("");
        setNewIcon("folder");
      }
    } catch (e) {
      console.error("Failed to create collection", e);
    }
  };

  const ICON_KEYS = Object.keys(ICON_MAP);
  const COLORS = ["#0D0D0D", "#4F46E5", "#F59E0B", "#EC4899", "#8B5CF6", "#EF4444", "#3B82F6"];

  if (loading) {
    return <div className="min-h-screen bg-[#0D0D0D] text-white flex items-center justify-center">{tCommon("loading")}</div>;
  }

  return (
    <div className="min-h-screen bg-[#0D0D0D] text-white p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">{t("colectiileMele")}</h1>
        <button
          onClick={() => setShowNewModal(true)}
          className="bg-[#0D0D0D] hover:bg-[#0e8a6b] text-white px-4 py-2 rounded-xl flex items-center gap-2 font-medium transition-colors"
        >
          <Plus size={20} />  {t("noua")}
        </button>
      </div>

      {collections.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-xl mb-4">{t("nuAiNicioColectie")}</p>
          <button
            onClick={() => setShowNewModal(true)}
            className="text-[#0D0D0D] hover:underline"
          >

            {t("creeazaPrimaTaColectie")}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {collections.map(col => (
            <Link key={col.id} href={`/collections/${col.id}`}>
              <div className="bg-[#1A1A1A] hover:bg-[#222] border border-gray-800 rounded-2xl p-6 transition-all h-full flex flex-col items-start gap-4 group">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-lg"
                  style={{ backgroundColor: col.color ? `${col.color}20` : '#333' }}
                >
                  <CollectionIcon name={col.icon} />
                </div>
                <div>
                  <h3 className="font-semibold text-lg group-hover:text-[#0D0D0D] transition-colors">{col.title}</h3>
                  <p className="text-gray-400 text-sm">{t("itemsCount", { count: col.actual_count || 0 })}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showNewModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1A1A1A] border border-gray-800 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">{t("colectieNoua")}</h2>
              <button onClick={() => setShowNewModal(false)} className="text-gray-400 hover:text-white" aria-label={t("inchide")}>
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">{t("nameLabel")}</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  className="w-full bg-[#0D0D0D] border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#0D0D0D]"
                  placeholder={t("exRetete")}
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">{t("iconLabel")}</label>
                <div className="flex flex-wrap gap-2">
                  {ICON_KEYS.map(key => (
                    <button
                      key={key}
                      onClick={() => setNewIcon(key)}
                      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${newIcon === key ? 'bg-[#333] border border-[#0D0D0D]' : 'hover:bg-[#222] border border-transparent'}`}
                    >
                      <CollectionIcon name={key} size={20} />
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">{t("colorLabel")}</label>
                <div className="flex flex-wrap gap-2">
                  {COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewColor(color)}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${newColor === color ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <button
                onClick={handleCreate}
                disabled={!newTitle.trim()}
                className="w-full bg-[#0D0D0D] hover:bg-[#0e8a6b] text-white py-3 rounded-xl font-medium mt-4 disabled:opacity-50 transition-colors"
              >

                {t("creeazaColectia")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
