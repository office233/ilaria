/**
 * Județele României cu codurile ISO 3166-2:RO — CIUS-RO cere codul (ex. „RO-CJ”)
 * în `cbc:CountrySubentity` pentru adresele din România (BR-RO-110/111).
 * Numele sunt substantive proprii (date, nu text de interfață).
 */
export const RO_COUNTIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "RO-AB", name: "Alba" },
  { code: "RO-AR", name: "Arad" },
  { code: "RO-AG", name: "Argeș" },
  { code: "RO-BC", name: "Bacău" },
  { code: "RO-BH", name: "Bihor" },
  { code: "RO-BN", name: "Bistrița-Năsăud" },
  { code: "RO-BT", name: "Botoșani" },
  { code: "RO-BR", name: "Brăila" },
  { code: "RO-BV", name: "Brașov" },
  { code: "RO-B", name: "București" },
  { code: "RO-BZ", name: "Buzău" },
  { code: "RO-CL", name: "Călărași" },
  { code: "RO-CS", name: "Caraș-Severin" },
  { code: "RO-CJ", name: "Cluj" },
  { code: "RO-CT", name: "Constanța" },
  { code: "RO-CV", name: "Covasna" },
  { code: "RO-DB", name: "Dâmbovița" },
  { code: "RO-DJ", name: "Dolj" },
  { code: "RO-GL", name: "Galați" },
  { code: "RO-GR", name: "Giurgiu" },
  { code: "RO-GJ", name: "Gorj" },
  { code: "RO-HR", name: "Harghita" },
  { code: "RO-HD", name: "Hunedoara" },
  { code: "RO-IL", name: "Ialomița" },
  { code: "RO-IS", name: "Iași" },
  { code: "RO-IF", name: "Ilfov" },
  { code: "RO-MM", name: "Maramureș" },
  { code: "RO-MH", name: "Mehedinți" },
  { code: "RO-MS", name: "Mureș" },
  { code: "RO-NT", name: "Neamț" },
  { code: "RO-OT", name: "Olt" },
  { code: "RO-PH", name: "Prahova" },
  { code: "RO-SJ", name: "Sălaj" },
  { code: "RO-SM", name: "Satu Mare" },
  { code: "RO-SB", name: "Sibiu" },
  { code: "RO-SV", name: "Suceava" },
  { code: "RO-TR", name: "Teleorman" },
  { code: "RO-TM", name: "Timiș" },
  { code: "RO-TL", name: "Tulcea" },
  { code: "RO-VL", name: "Vâlcea" },
  { code: "RO-VS", name: "Vaslui" },
  { code: "RO-VN", name: "Vrancea" },
];

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Codul ISO al județului din cod („RO-CJ”, „CJ”) sau nume („Cluj”, „judetul Cluj”). */
export function normalizeRoCounty(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const byCode = RO_COUNTIES.find((c) => c.code === upper || c.code === `RO-${upper}`);
  if (byCode) return byCode.code;
  const folded = fold(raw).replace(/^(judetul|judet|jud)/, "");
  if (folded === "bucuresti" || folded === "municipiulbucuresti" || folded === "bucharest") return "RO-B";
  return RO_COUNTIES.find((c) => fold(c.name) === folded)?.code ?? null;
}

/** În București, CIUS-RO cere orașul ca „SECTOR1”…„SECTOR6”. */
export function normalizeBucharestSector(city: string | null | undefined): string | null {
  const m = /sector\s*([1-6])\b/i.exec(city ?? "") ?? /^\s*s\s*([1-6])\s*$/i.exec(city ?? "");
  return m ? `SECTOR${m[1]}` : null;
}
