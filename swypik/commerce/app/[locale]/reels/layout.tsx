// Layout minimal pentru rutele /reels/*. Camera își desenează singură fundalul
// imersiv (ImmersiveSurface); pașii de după (editare/detalii) sunt light-first.
export default function ReelsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
