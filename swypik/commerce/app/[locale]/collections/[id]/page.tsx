"use client";

import { useEffect, useState, use, useCallback } from "react";
import { Link, useRouter } from "@/lib/i18n/navigation";
import Image from "next/image";
import { ArrowLeft, Edit2, Trash2, X, Play, Folder, Bookmark, ShoppingCart, Lightbulb, Heart, Star, Music, Plane, UtensilsCrossed, Gamepad2, Inbox, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/ConfirmDialog";

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

function CollectionIcon({ name, size = 28 }: { name?: string | null; size?: number }) {
  const Icon = (name && ICON_MAP[name]) || Folder;
  return <Icon size={size} />;
}

type Collection = {
  id: string;
  title: string;
  icon: string;
  color: string;
  is_default: boolean;
};

type CollectionItem = {
  id: string;
  video_id: string;
  title: string;
  thumbnail_url: string;
  creator_name: string;
  view_count: number;
};

export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations("collections");
  const tCommon = useTranslations("common");
  const [confirm, confirmDialog] = useConfirm();
  const resolvedParams = use(params);
  const collectionId = resolvedParams.id;

  const [collection, setCollection] = useState<Collection | null>(null);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editColor, setEditColor] = useState("");
  const router = useRouter();

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/collections/${collectionId}`);
      if (res.ok) {
        const data = await res.json();
        setCollection(data.collection);
        setItems(data.items || []);
        setEditTitle(data.collection.title);
        setEditIcon(data.collection.icon || "folder");
        setEditColor(data.collection.color || "#0D0D0D");
      } else {
        router.push('/collections');
      }
    } catch (e) {
      console.error("Failed to fetch collection details", e);
    } finally {
      setLoading(false);
    }
  }, [collectionId, router]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleUpdate = async () => {
    try {
      const res = await fetch(`/api/collections/${collectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle, icon: editIcon, color: editColor })
      });
      if (res.ok) {
        const data = await res.json();
        setCollection(data.collection);
        setShowEdit(false);
      }
    } catch (e) {
      console.error("Failed to update collection", e);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ title: t("confirmDelete"), confirmLabel: t("sterge"), tone: "danger" }))) return;
    try {
      const res = await fetch(`/api/collections/${collectionId}`, {
        method: "DELETE"
      });
      if (res.ok) {
        router.push('/collections');
      }
    } catch (e) {
      console.error("Failed to delete collection", e);
    }
  };

  const ICON_KEYS = Object.keys(ICON_MAP);
  const COLORS = ["#0D0D0D", "#4F46E5", "#F59E0B", "#EC4899", "#8B5CF6", "#EF4444", "#3B82F6"];

  if (loading) {
    return <div className="min-h-screen bg-[#0D0D0D] text-white flex items-center justify-center">{tCommon("loading")}</div>;
  }

  if (!collection) return null;

  return (
    <div className="min-h-screen bg-[#0D0D0D] text-white p-6 max-w-6xl mx-auto">
      <Link href="/collections" className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={20} />  {t("inapoiLaColectii")}
      </Link>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-10 bg-[#1A1A1A] p-6 rounded-3xl border border-gray-800">
        <div className="flex items-center gap-4">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-lg"
            style={{ backgroundColor: collection.color ? `${collection.color}30` : '#333' }}
          >
            <CollectionIcon name={collection.icon} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">{collection.title}</h1>
            <p className="text-gray-400 mt-1">{t("savedItemsCount", { count: items.length })}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEdit(true)}
            className="bg-[#222] hover:bg-[#333] text-white px-4 py-2 rounded-xl flex items-center gap-2 transition-colors border border-gray-700"
          >
            <Edit2 size={16} />  {t("editeaza")}
          </button>
          {!collection.is_default && (
            <button
              onClick={handleDelete}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-500 px-4 py-2 rounded-xl flex items-center gap-2 transition-colors border border-red-500/20"
            >
              <Trash2 size={16} />  {t("sterge")}
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-20 text-gray-500 bg-[#141414] rounded-3xl border border-gray-800/50">
          <div className="mb-4 flex justify-center opacity-50"><Inbox size={48} /></div>
          <p className="text-xl">{t("aceastaColectieEsteGoala")}</p>
          <Link href="/explore" className="text-[#0D0D0D] hover:underline mt-2 inline-block">

            {t("exploreazaClipuri")}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {items.map(item => (
            <Link key={item.id} href={`/explore?v=${item.video_id}`} className="group">
              <div className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-[#222] border border-gray-800">
                {item.thumbnail_url ? (
                  <Image
                    src={item.thumbnail_url}
                    alt={item.title}
                    fill
                    sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">{t("noImage")}</div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex flex-col justify-end p-4 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <h3 className="font-semibold text-white line-clamp-2 text-sm mb-1">{item.title}</h3>
                  <div className="flex justify-between items-center text-xs text-gray-300">
                    <span>@{item.creator_name || 'user'}</span>
                    <span className="flex items-center gap-1"><Play size={10} /> {item.view_count || 0}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showEdit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1A1A1A] border border-gray-800 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">{t("editeazaColectia")}</h2>
              <button onClick={() => setShowEdit(false)} className="text-gray-400 hover:text-white" aria-label={t("inchide")}>
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">{t("nameLabel")}</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="w-full bg-[#0D0D0D] border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#0D0D0D]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">{t("iconLabel")}</label>
                <div className="flex flex-wrap gap-2">
                  {ICON_KEYS.map(key => (
                    <button
                      key={key}
                      onClick={() => setEditIcon(key)}
                      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${editIcon === key ? 'bg-[#333] border border-[#0D0D0D]' : 'hover:bg-[#222] border border-transparent'}`}
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
                      onClick={() => setEditColor(color)}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${editColor === color ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <button
                onClick={handleUpdate}
                disabled={!editTitle.trim()}
                className="w-full bg-[#0D0D0D] hover:bg-[#0e8a6b] text-white py-3 rounded-xl font-medium mt-4 disabled:opacity-50 transition-colors"
              >

                {t("salveazaModificarile")}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
