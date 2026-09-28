/**
 * DATE DE EXEMPLU — catalog „viral" pentru selleri.
 *
 * Nu există (încă) un feed real de furnizor. Aceste 6 produse sunt fictive:
 * poze stock Unsplash, clipuri demo Google, SKU-uri și coduri de bare
 * inventate. Sunt expuse doar cu FEATURE_VIRAL_CATALOG=1 și nu trebuie să
 * ajungă în producție ca „Depozit Partener".
 */

export type ViralProductSeed = {
  id: string;
  title: string;
  description: string;
  category: string;
  wholesaleCostRon: number;
  recommendedPriceRon: number;
  sku: string;
  barcode: string;
  imageUrl: string;
  videoUrl: string;
  [key: string]: unknown;
};

export const VIRAL_PRODUCTS: ViralProductSeed[] = [
  {
    id: "viral-magsafe-car",
    title: "Suport Auto Telefon MagSafe cu Încărcare Wireless 15W & Rotație 360°",
    description: "⚡ Încărcare rapidă 15W MagSafe. Magnet ultra-puternic N52 ce nu lasă telefonul să cadă pe drumuri accidentate. Rotație 360 de grade și prindere sigură în grila de ventilație a oricărei mașini.",
    category: "Auto & Moto",
    wholesaleCostRon: 22.0,
    recommendedPriceRon: 59.9,
    imageUrl: "https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    sku: "AUTO-MAG-15W",
    barcode: "5949012300018",
    rating: 4.9,
    ordersCount: 1420,
  },
  {
    id: "viral-g-lamp-rgb",
    title: "Lampă Ambientală RGB Inteligentă cu Boxă Bluetooth, Ceas & Încărcare Wireless G-Style",
    description: "🌈 256 de moduri de lumini ambientale sincronizate pe muzică. Boxă Bluetooth Hi-Fi integrată, ceas digital cu alarmă de răsărit și încărcător wireless rapid pentru telefon.",
    category: "Casa & Smart Home",
    wholesaleCostRon: 35.0,
    recommendedPriceRon: 89.9,
    imageUrl: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    sku: "LAMP-G-RGB",
    barcode: "5949012300025",
    rating: 4.8,
    ordersCount: 2890,
  },
  {
    id: "viral-mini-printer",
    title: "Mini Imprimantă Termică Portabilă Bluetooth pentru Poze, Notițe & Etichete",
    description: "🖨️ Imprimă instantaneu fără cerneală (tehnologie termică). Conectare prin Bluetooth cu aplicație gratuită pe iOS și Android. Include o rolă de hârtie termică gata de imprimat.",
    category: "Electronice",
    wholesaleCostRon: 28.0,
    recommendedPriceRon: 69.9,
    imageUrl: "https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
    sku: "PRN-MINI-TH",
    barcode: "5949012300032",
    rating: 4.9,
    ordersCount: 3100,
  },
  {
    id: "viral-tws-anc-pro",
    title: "Căști Wireless TWS Pro cu Anulare Activă a Zgomotului (ANC) & Autonomie 24h",
    description: "🎧 Sunet imersiv cu bas profund și mod Transparență. Anulare activă a zgomotului de fond pentru apeluri clare. Carcasă cu afișaj digital LED al nivelului bateriei.",
    category: "Audio & Accesorii",
    wholesaleCostRon: 32.0,
    recommendedPriceRon: 79.9,
    imageUrl: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyBlazes.mp4",
    sku: "AUDIO-TWS-ANC",
    barcode: "5949012300049",
    rating: 4.7,
    ordersCount: 4500,
  },
  {
    id: "viral-astronaut-projector",
    title: "Proiector Astronomic Astronaut Galaxy 360° cu Stele, Nebuloase & Telecomandă",
    description: "🌌 Transformă camera într-un cer înstelat spectaculos. Capul astronautului se rotește la 360° magnetic. 8 moduri de proiecție a galaxiei cu temporizator automat de somn.",
    category: "Copii & Gadgeturi",
    wholesaleCostRon: 45.0,
    recommendedPriceRon: 119.9,
    imageUrl: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
    sku: "TOY-ASTRO-GALAXY",
    barcode: "5949012300056",
    rating: 5.0,
    ordersCount: 5200,
  },
  {
    id: "viral-auto-vacuum",
    title: "Aspirator Auto Portabil Wireless 120W cu Putere Înaltă de Aspirație & Funcție Suflantă",
    description: "🚗 Curățenie impecabilă în mașină în 3 minute. Baterie reîncărcabilă USB-C, filtru HEPA lavabil și 4 accesorii pentru spații înguste și praf pe tastatură.",
    category: "Auto & Moto",
    wholesaleCostRon: 30.0,
    recommendedPriceRon: 79.9,
    imageUrl: "https://images.unsplash.com/photo-1558317374-067fb5f30001?w=800&q=80",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4",
    sku: "AUTO-VAC-120W",
    barcode: "5949012300063",
    rating: 4.8,
    ordersCount: 1980,
  },
];
