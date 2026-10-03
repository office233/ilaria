/**
 * Handoff către aplicațiile de navigare (coordonate, nu adrese — adresele din
 * geocoding pot fi ambigue). Baza URL-urilor e configurabilă prin env.
 */
const GMAPS_BASE = process.env.NEXT_PUBLIC_NAV_GMAPS_URL || "https://www.google.com/maps/dir/";
const WAZE_BASE = process.env.NEXT_PUBLIC_NAV_WAZE_URL || "https://waze.com/ul";

export function googleMapsLink(lat: number, lng: number): string {
  return `${GMAPS_BASE}?api=1&destination=${lat},${lng}&travelmode=driving`;
}

export function wazeLink(lat: number, lng: number): string {
  return `${WAZE_BASE}?ll=${lat},${lng}&navigate=yes`;
}
