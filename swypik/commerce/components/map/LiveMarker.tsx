"use client";

/**
 * LiveMarker — marker pe hartă (pickup, dropoff, șofer live, mașini din apropiere).
 * HTML/SVG modern stil Uber / Bolt cu animație de puls și badge-uri lizibile.
 */
import { Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { useMemo } from "react";

export type LiveMarkerProps = {
  position: { lat: number; lng: number };
  kind?: "pickup" | "dropoff" | "driver" | "nearby";
  label?: string;
  heading?: number;
  eta?: string;
  /**
   * Texte afișate pe marker — parametrizabile prin props (nu prin
   * useTranslations aici) fiindcă LiveMarker e o componentă hartă comună mai
   * multor verticale (go/food/fly); apelantul, care are propriul namespace
   * de traduceri, poate transmite textele localizate. Implicit rămân textele
   * în română, ca să nu schimbe comportamentul apelanților existenți.
   */
  boardHereText?: string;
  pickupFallbackLabel?: string;
  destinationText?: string;
  dropoffFallbackLabel?: string;
};

function renderMarkerHtml(
  kind: "pickup" | "dropoff" | "driver" | "nearby",
  label: string | undefined,
  heading = 0,
  eta: string | undefined,
  boardHereText: string,
  pickupFallbackLabel: string,
  destinationText: string,
  dropoffFallbackLabel: string,
): string {
  if (kind === "pickup") {
    const cleanLabel = label ? (label.length > 26 ? label.slice(0, 24) + "…" : label) : pickupFallbackLabel;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none;user-select:none;transform-style:preserve-3d;">
        <!-- Floating 3D Hologram Pill -->
        <div style="margin-bottom:6px;background:rgba(10,10,12,0.96);backdrop-filter:blur(16px);color:white;padding:6px 14px;border-radius:16px;font-size:11.5px;font-weight:900;letter-spacing:-0.2px;box-shadow:0 12px 32px rgba(0,0,0,0.5), 0 0 1px 1px rgba(16,185,129,0.35);display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid rgba(255,255,255,0.2);">
          <span style="width:9px;height:9px;border-radius:50%;background:#10B981;box-shadow:0 0 12px #10B981;display:inline-block;animation:car-light-glow 2s infinite ease-in-out;"></span>
          <span style="color:#FFFFFF;font-weight:900;letter-spacing:-0.3px;">${boardHereText}</span>
          <span style="color:#94A3B8;font-weight:600;font-size:10px;">• ${cleanLabel}</span>
        </div>
        <!-- 3D Holographic Vertical Needle -->
        <div style="width:2px;height:12px;background:linear-gradient(180deg, #10B981 0%, rgba(16,185,129,0.2) 100%);box-shadow:0 0 8px #10B981;"></div>
        <!-- Ground Projection Target -->
        <div style="position:relative;width:38px;height:38px;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;width:48px;height:48px;border-radius:50%;background:rgba(16,185,129,0.22);border:1.5px solid rgba(16,185,129,0.75);animation:uber-radar-expand 2.2s infinite ease-out;"></div>
          <div style="position:absolute;width:30px;height:30px;border-radius:50%;background:rgba(16,185,129,0.18);"></div>
          <div style="width:18px;height:18px;border-radius:50%;background:#0A0A0C;border:3px solid #10B981;box-shadow:0 4px 16px rgba(16,185,129,0.8);display:flex;align-items:center;justify-content:center;">
            <div style="width:6px;height:6px;border-radius:50%;background:#10B981;"></div>
          </div>
        </div>
      </div>
    `;
  }

  if (kind === "dropoff") {
    const cleanLabel = label ? (label.length > 26 ? label.slice(0, 24) + "…" : label) : dropoffFallbackLabel;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none;user-select:none;transform-style:preserve-3d;">
        <!-- Floating 3D Hologram Pill -->
        <div style="margin-bottom:6px;background:rgba(225,29,72,0.96);backdrop-filter:blur(16px);color:white;padding:6px 14px;border-radius:16px;font-size:11.5px;font-weight:900;letter-spacing:-0.2px;box-shadow:0 12px 32px rgba(225,29,72,0.5), 0 0 1px 1px rgba(255,255,255,0.4);display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid rgba(255,255,255,0.25);">
          <span>🏁</span>
          <span style="font-weight:900;letter-spacing:-0.3px;">${destinationText}</span>
          <span style="color:rgba(255,255,255,0.85);font-weight:600;font-size:10px;">• ${cleanLabel}</span>
        </div>
        <!-- 3D Holographic Vertical Needle -->
        <div style="width:2px;height:12px;background:linear-gradient(180deg, #E11D48 0%, rgba(225,29,72,0.2) 100%);box-shadow:0 0 8px #E11D48;"></div>
        <!-- Ground Concentric Target -->
        <div style="position:relative;width:38px;height:38px;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;width:48px;height:48px;border-radius:50%;background:rgba(225,29,72,0.22);border:1.5px solid rgba(225,29,72,0.7);animation:uber-radar-expand 2.2s infinite ease-out;"></div>
          <div style="width:20px;height:20px;border-radius:50%;background:#0A0A0C;border:3px solid #E11D48;box-shadow:0 4px 16px rgba(225,29,72,0.7);display:flex;align-items:center;justify-content:center;">
            <div style="width:6px;height:6px;border-radius:2px;background:#E11D48;"></div>
          </div>
        </div>
      </div>
    `;
  }

  // Șofer live sau mașină din apropiere — Model 3D Izometric Super-Sport stil Uber Black & Bolt Electric
  const isNearby = kind === "nearby";
  const carSize = isNearby ? 42 : 46;
  const etaBadge = eta
    ? `<div style="position:absolute;top:-24px;left:50%;transform:translateX(-50%);background:rgba(10,10,12,0.96);backdrop-filter:blur(10px);color:#FFFFFF;padding:2.5px 9px;border-radius:12px;font-size:10px;font-weight:900;letter-spacing:-0.2px;box-shadow:0 6px 16px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.2);white-space:nowrap;display:flex;align-items:center;gap:4.5px;">
        <span style="color:#10B981;font-size:11px;">⚡</span><span>${eta}</span>
      </div>`
    : "";

  return `
    <div style="position:relative;width:${carSize}px;height:${carSize}px;display:flex;align-items:center;justify-content:center;user-select:none;">
      ${etaBadge}
      <div style="transform:rotate(${heading}deg);transition:transform 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);filter:drop-shadow(0 8px 14px rgba(0,0,0,0.55));">
        <svg width="${carSize}" height="${carSize}" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <!-- Con de lumină faruri (Headlight forward beam cu cădere graduală) -->
            <linearGradient id="headlightBeam-${heading}" x1="22" y1="6" x2="22" y2="-18" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#FEF08A" stop-opacity="0.55"/>
              <stop offset="60%" stop-color="#FEF08A" stop-opacity="0.2"/>
              <stop offset="100%" stop-color="#FEF08A" stop-opacity="0"/>
            </linearGradient>
            <!-- Corp metalic mașină cu finisaj ceramic lucios -->
            <linearGradient id="carBody" x1="12" y1="4" x2="32" y2="38" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#2D2D32"/>
              <stop offset="30%" stop-color="#1E1E22"/>
              <stop offset="70%" stop-color="#121215"/>
              <stop offset="100%" stop-color="#050506"/>
            </linearGradient>
            <!-- Reflexie parbriz sticlă fumurie -->
            <linearGradient id="windshieldGlass" x1="14" y1="9" x2="30" y2="16" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.95"/>
              <stop offset="50%" stop-color="#0284C7" stop-opacity="0.85"/>
              <stop offset="100%" stop-color="#0369A1" stop-opacity="0.75"/>
            </linearGradient>
          </defs>

          <!-- Conuri de lumină Xenon proiectate pe asfalt -->
          <polygon points="14,6 3,-16 20,-16 17,6" fill="url(#headlightBeam-${heading})" style="animation:car-light-glow 2.8s infinite ease-in-out;"/>
          <polygon points="27,6 24,-16 41,-16 30,6" fill="url(#headlightBeam-${heading})" style="animation:car-light-glow 2.8s infinite ease-in-out;"/>

          <!-- Umbră contur roți exterioare -->
          <rect x="8.5" y="8" width="3.5" height="7" rx="1.5" fill="#000000"/>
          <rect x="32" y="8" width="3.5" height="7" rx="1.5" fill="#000000"/>
          <rect x="8.5" y="27" width="3.5" height="7" rx="1.5" fill="#000000"/>
          <rect x="32" y="27" width="3.5" height="7" rx="1.5" fill="#000000"/>

          <!-- Șasiu caroserie aerodinamică cu margini cromate -->
          <rect x="11" y="4" width="22" height="34" rx="8" fill="url(#carBody)" stroke="#52525B" stroke-width="1.1"/>
          
          <!-- Linii capotă sculptată -->
          <path d="M16 6H28" stroke="#71717A" stroke-width="0.8" stroke-linecap="round"/>
          <path d="M15 9H29" stroke="#3F3F46" stroke-width="0.6" stroke-linecap="round"/>

          <!-- Parbriz față cu reflexie curbată -->
          <path d="M14 12.5H30L28.5 7.5H15.5L14 12.5Z" fill="url(#windshieldGlass)"/>

          <!-- Plafon caroserie (Panoramic Tinted Glass) -->
          <rect x="13.5" y="13.5" width="17" height="10.5" rx="2" fill="#0A0A0C" stroke="#27272A" stroke-width="0.6"/>

          <!-- Lunetă spate -->
          <path d="M14 25H30L28.5 29.5H15.5L14 25Z" fill="url(#windshieldGlass)"/>

          <!-- Oglinzi laterale cu semnalizator -->
          <rect x="7" y="11.5" width="4.5" height="2.2" rx="1" fill="#27272A" stroke="#52525B" stroke-width="0.5"/>
          <rect x="32.5" y="11.5" width="4.5" height="2.2" rx="1" fill="#27272A" stroke="#52525B" stroke-width="0.5"/>
          <circle cx="8" cy="12.5" r="0.6" fill="#F59E0B"/>
          <circle cx="36" cy="12.5" r="0.6" fill="#F59E0B"/>

          <!-- Faruri LED Xenon cu inele Angel Eyes -->
          <circle cx="14" cy="5.2" r="2" fill="#FEF08A"/>
          <circle cx="30" cy="5.2" r="2" fill="#FEF08A"/>
          <circle cx="14" cy="5.2" r="0.8" fill="#FFFFFF"/>
          <circle cx="30" cy="5.2" r="0.8" fill="#FFFFFF"/>

          <!-- Stopuri spate Neon Red (Lightbar continuu) -->
          <rect x="13" y="36.5" width="18" height="1.6" rx="0.8" fill="#EF4444"/>
          <rect x="13" y="36.5" width="4" height="1.6" rx="0.8" fill="#FF2020"/>
          <rect x="27" y="36.5" width="4" height="1.6" rx="0.8" fill="#FF2020"/>

          <!-- Indicator Categorie Glowing Emblem (Emerald Bolt / Amber Uber) -->
          <circle cx="22" cy="18.5" r="3.2" fill="${isNearby ? "#10B981" : "#F59E0B"}" stroke="#FFFFFF" stroke-width="0.9" style="filter:drop-shadow(0 0 4px ${isNearby ? "#10B981" : "#F59E0B"});"/>
        </svg>
      </div>
    </div>
  `;
}

export default function LiveMarker({
  position,
  kind = "pickup",
  label,
  heading = 0,
  eta,
  boardHereText = "Urcă aici",
  pickupFallbackLabel = "Punct de preluare",
  destinationText = "Destinație",
  dropoffFallbackLabel = "Destinație",
}: LiveMarkerProps) {
  const icon = useMemo(
    () =>
      L.divIcon({
        html: renderMarkerHtml(kind, label, heading, eta, boardHereText, pickupFallbackLabel, destinationText, dropoffFallbackLabel),
        className: "custom-leaflet-marker",
        iconSize: [36, 36],
        iconAnchor: kind === "pickup" || kind === "dropoff" ? [18, 36] : [18, 18],
      }),
    [kind, label, heading, eta, boardHereText, pickupFallbackLabel, destinationText, dropoffFallbackLabel],
  );

  return (
    <Marker position={[position.lat, position.lng]} icon={icon}>
      {label ? <Popup className="custom-popup">{label}</Popup> : null}
    </Marker>
  );
}
