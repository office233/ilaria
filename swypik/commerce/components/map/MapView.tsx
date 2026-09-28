"use client";
import { useTranslations } from "next-intl";

/**
 * MapView — hartă Leaflet + OpenStreetMap.
 *
 * ALEGERE LIBRĂRIE: react-leaflet + OSM, NU Google Maps, pentru că:
 *  1. în package.json nu exista nicio librărie de hartă;
 *  2. nu există NEXT_PUBLIC_GOOGLE_MAPS_API_KEY nicăieri în cod/env —
 *     serverul folosește GOOGLE_MAPS_API_KEY doar OPȚIONAL pentru Directions,
 *     cu fallback haversine; deci UI-ul nu poate presupune o cheie de client;
 *  3. OSM = zero cost, zero cheie, funcționează imediat în PWA.
 *
 * IMPORTANT: importă componenta DOAR prin `next/dynamic` cu `ssr: false`
 * (Leaflet atinge `window` la import).
 */
import { useEffect, useState } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Plus, Minus, Navigation, Moon, Sun, Compass } from "lucide-react";
import "leaflet/dist/leaflet.css";

// Fix icon-uri default Leaflet în bundler (altfel marker-ele apar sparte).
// @ts-expect-error _getIconUrl e privat
delete L.Icon.Default.prototype._getIconUrl;
// Imaginile sunt copiate din node_modules/leaflet/dist/images în public/leaflet —
// servite de noi, nu de un CDN terț.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  iconUrl: "/leaflet/marker-icon.png",
  shadowUrl: "/leaflet/marker-shadow.png",
});

/** Furnizorul de tile-uri e configurabil (NEXT_PUBLIC_MAP_TILE_URL); OSM HOT e doar fallback. */
const MAP_TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png";

export type MapViewProps = {
  center: { lat: number; lng: number };
  zoom?: number;
  className?: string;
  children?: React.ReactNode;
  /** Când se schimbă, harta face flyTo. */
  flyTo?: { lat: number; lng: number } | null;
  /** Când e setat, harta încadrează toate punctele. */
  fitBounds?: { lat: number; lng: number }[] | null;
  /** Click pe hartă — folosit pentru ajustarea pinului de livrare. */
  onMapClick?: (p: { lat: number; lng: number }) => void;
  /** Callback pentru butonul „Locația mea”. */
  onLocate?: () => void;
  /** Afișează controalele moderne de zoom/locate (implicit: true). */
  showControls?: boolean;
  /** Mod de afișare hartă: light (curat stil Uber/Bolt) sau dark (Uber Black nocturn) */
  initialTheme?: "light" | "dark";
  /** Mod 3D Perspective activat (implicit: true pentru experiență imersivă) */
  initial3D?: boolean;
};

function ClickCapture({ onMapClick }: { onMapClick: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({
    click(e) {
      onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function MapController({ flyTo, fitBounds }: Pick<MapViewProps, "flyTo" | "fitBounds">) {
  const map = useMap();
  useEffect(() => {
    if (fitBounds && fitBounds.length >= 2) {
      map.fitBounds(
        L.latLngBounds(fitBounds.map((p) => [p.lat, p.lng] as [number, number])),
        { padding: [60, 60], maxZoom: 16 },
      );
    } else if (flyTo) {
      map.flyTo([flyTo.lat, flyTo.lng], Math.max(map.getZoom(), 15), { duration: 1.2 });
    }
  }, [map, flyTo, fitBounds]);
  return null;
}

function ModernMapControls({
  onLocate,
  isDark,
  onToggleTheme,
  is3D,
  onToggle3D,
}: {
  onLocate?: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  is3D: boolean;
  onToggle3D: () => void;
}) {
  const t = useTranslations("map");
  const map = useMap();
  return (
    <div className="absolute right-4 top-20 z-[400] flex flex-col gap-2.5 pointer-events-auto select-none">
      {/* Zoom in/out */}
      <div className="flex flex-col overflow-hidden rounded-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl border border-black/10 dark:border-white/10">
        <button
          type="button"
          aria-label={t("zoomIn")}
          onClick={() => map.zoomIn()}
          className="flex h-11 w-11 items-center justify-center text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-zinc-800 active:bg-neutral-200 border-b border-black/5 dark:border-white/5 transition"
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          aria-label={t("zoomOut")}
          onClick={() => map.zoomOut()}
          className="flex h-11 w-11 items-center justify-center text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-zinc-800 active:bg-neutral-200 transition"
        >
          <Minus size={18} />
        </button>
      </div>

      {/* Comutare mod 3D Perspective / 2D Classic */}
      <button
        type="button"
        aria-label={is3D ? t("mode2d") : t("mode3d")}
        onClick={onToggle3D}
        className={`flex h-11 w-11 items-center justify-center rounded-2xl backdrop-blur-md shadow-xl border transition active:scale-95 ${
          is3D
            ? "bg-neutral-950 text-white border-emerald-500/50 shadow-emerald-950/30 ring-2 ring-emerald-500/25"
            : "bg-white/95 dark:bg-zinc-900/95 border-black/10 dark:border-white/10 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-zinc-800"
        }`}
      >
        <span className={`text-[11px] font-black tracking-tighter ${is3D ? "text-emerald-400" : "text-neutral-700 dark:text-neutral-300"}`}>
          3D
        </span>
      </button>

      {/* Comutare mod Noapte / Zi (Uber Black Night Map) */}
      <button
        type="button"
        aria-label={isDark ? t("dayMode") : t("nightMode")}
        onClick={onToggleTheme}
        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl border border-black/10 dark:border-white/10 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-zinc-800 active:scale-95 transition"
      >
        {isDark ? <Sun size={17} className="text-amber-400" /> : <Moon size={17} className="text-indigo-600" />}
      </button>

      {/* Resetare orientare Nord */}
      <button
        type="button"
        aria-label={t("resetNorth")}
        onClick={() => map.setView(map.getCenter(), map.getZoom())}
        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl border border-black/10 dark:border-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-zinc-800 active:scale-95 transition"
      >
        <Compass size={18} className="text-rose-500" />
      </button>

      {/* Re-centrare pe locația curentă */}
      {onLocate && (
        <button
          type="button"
          aria-label={t("myLocation")}
          onClick={onLocate}
          className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl border border-black/10 dark:border-white/10 text-neutral-800 hover:bg-neutral-100 dark:hover:bg-zinc-800 active:scale-95 transition"
        >
          <Navigation size={18} className="text-emerald-500 fill-emerald-500" />
        </button>
      )}
    </div>
  );
}

export default function MapView({
  center,
  zoom = 14,
  className,
  children,
  flyTo,
  fitBounds,
  onMapClick,
  onLocate,
  showControls = true,
  initialTheme = "light",
  initial3D = true,
}: MapViewProps) {
  const [isDark, setIsDark] = useState(initialTheme === "dark");
  const [is3D, setIs3D] = useState(initial3D);

  return (
    <div className={`relative h-full w-full overflow-hidden ${is3D ? "uber-map-container-3d" : "uber-map-container-2d"}`}>
      {/* Stiluri CSS avansate pentru randarea stil Uber / Bolt Luxury & 3D Perspective */}
      <style jsx global>{`
        /* Calibrare cromatică stil Uber/Bolt: drumuri curate, clădiri estompate, spații verzi calme */
        .uber-tiles-light .leaflet-tile-pane {
          filter: contrast(104%) brightness(101%) saturate(70%) sepia(3%);
        }
        /* Uber Black Luxury Night Mode: drumuri iluminate, fond obsidian */
        .uber-tiles-dark .leaflet-tile-pane {
          filter: invert(100%) hue-rotate(180deg) brightness(90%) contrast(115%) saturate(55%);
        }
        .leaflet-container {
          background-color: ${isDark ? "#121214" : "#F4F4F5"} !important;
          font-family: inherit;
        }

        /* Perspective 3D veritabilă stil Navigație Bord / Uber 3D Driving View */
        .uber-map-container-3d {
          perspective: 1100px;
        }
        .uber-map-container-3d .leaflet-map-pane {
          transform: rotateX(38deg) scale(1.2);
          transform-origin: 50% 88%;
          transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .uber-map-container-2d .leaflet-map-pane {
          transform: rotateX(0deg) scale(1);
          transform-origin: 50% 50%;
          transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Ceață atmosferică orizont pentru efect de adâncime 3D infinită */
        .uber-horizon-dark {
          background: linear-gradient(180deg, rgba(14,14,16,0.96) 0%, rgba(14,14,16,0.65) 45%, rgba(14,14,16,0) 100%);
        }
        .uber-horizon-light {
          background: linear-gradient(180deg, rgba(244,244,245,0.96) 0%, rgba(244,244,245,0.6) 45%, rgba(244,244,245,0) 100%);
        }

        @keyframes uber-radar-expand {
          0% {
            transform: scale(0.6);
            opacity: 0.85;
          }
          50% {
            opacity: 0.45;
          }
          100% {
            transform: scale(2.4);
            opacity: 0;
          }
        }
        @keyframes car-light-glow {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 0.95; }
        }
      `}</style>

      {/* Ceață atmosferică orizont pentru profunzime 3D reală */}
      {is3D && (
        <div
          className={`pointer-events-none absolute top-0 inset-x-0 h-36 z-[390] transition-opacity duration-500 ${
            isDark ? "uber-horizon-dark" : "uber-horizon-light"
          }`}
        />
      )}

      <MapContainer
        center={[center.lat, center.lng]}
        zoom={zoom}
        className={`${className ?? "h-full w-full"} ${isDark ? "uber-tiles-dark" : "uber-tiles-light"}`}
        zoomControl={false}
        attributionControl={false}
      >
        <TileLayer
          url={MAP_TILE_URL}
          subdomains="abc"
          maxZoom={19}
        />
        <MapController flyTo={flyTo} fitBounds={fitBounds} />
        {onMapClick && <ClickCapture onMapClick={onMapClick} />}
        {showControls && (
          <ModernMapControls
            onLocate={onLocate}
            isDark={isDark}
            onToggleTheme={() => setIsDark((d) => !d)}
            is3D={is3D}
            onToggle3D={() => setIs3D((v) => !v)}
          />
        )}
        {children}
      </MapContainer>
    </div>
  );
}
