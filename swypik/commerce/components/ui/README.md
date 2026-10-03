# components/ui — primitivele Swypik

Mici, tipizate, accesibile (Radix unde contează), stilizate DOAR cu tokeni.
Compunere de clase: `cn()` din `@/lib/ui/cn` (clsx + tailwind-merge). Variante: `cva`.

## Tokeni (app/styles/tokens.css → tailwind.config.ts)

| Nevoie | Clasă |
|---|---|
| Fundal pagină / card / zonă secundară / sheet | `bg-canvas` / `bg-surface` / `bg-surface-2` / `bg-elevated` |
| Text principal / secundar / meta / pe fundal închis | `text-fg` / `text-muted` / `text-subtle` / `text-fg-inverse` |
| Bordură fină / accentuată | `border border-subtle` (implicit) / `border-strong` |
| Brand | `bg-brand text-brand-fg`, hover `bg-brand-hover`, nuanțat `bg-brand-soft text-brand-soft-fg`, `bg-brand-gradient` |
| Stări | `text-success`, `bg-success-soft`, `warning`, `danger`, `info` (+ `-soft`) |
| Raze | controale `rounded-control` (12), carduri `rounded-card` (16), sheet-uri `rounded-sheet` (24) |
| Umbre | `shadow-elev-1/2/3` |
| Mișcare | `duration-fast/base/slow`, `ease-out` (respectă prefers-reduced-motion) |
| Layout | `h-header` (56), `h-nav`, `px-gutter` (16), `pt-safe-t`, `pb-safe-b`, `pb-bottom-inset`, `z-nav/header/overlay/toast` |
| Opacitate | orice token: `bg-surface/80`, `text-fg/60` |

Reguli: fără hex în `app/` și `components/` (`npm run lint:design` blochează creșterea),
text minim 12px (`text-xs`), ținte de atingere ≥ 44px, `min-h-dvh` în loc de `min-h-screen`.

**Teme.** Light implicit; dark după sistem sau alegerea din meniu (`ThemeToggle`). Tokenurile
se schimbă singure; `dark:` funcționează (selector `[data-theme="dark"]`). Ecranele imersive
(feed, player, Movies, Music, Live) se învelesc în `<ImmersiveSurface>` (components/theme) —
forțează dark local și face bara de sistem neagră. `fullscreen` pentru feed/player full-screen.

**BottomNav.** Spațiul de jos e rezervat automat de `#main-content` (CSS, `--bottom-inset`).
NU mai adăuga `pb-20/pb-24` pe pagini. Bare fixe jos (checkout, chat): `bottom-[var(--bottom-inset)]`
sau `style={{ bottom: "var(--bottom-inset)" }}`.

## Primitive

```tsx
import { Button } from "@/components/ui/Button";           // primary|secondary|ghost|danger|soft|link · sm|md|lg · block · loading · asChild
<Button onClick={save} loading={busy}>{t("save")}</Button>
<Button asChild variant="secondary"><Link href="/shop">{t("shop")}</Link></Button>

import { IconButton, IconBadge } from "@/components/ui/IconButton"; // label OBLIGATORIU (aria-label) · ghost|secondary|primary|overlay
<IconButton label={t("share")} onClick={share}><Share2 aria-hidden /></IconButton>

import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card"; // default|elevated|muted|outline · padding · interactive
import { Badge } from "@/components/ui/Badge";              // tone: neutral|brand|success|warning|danger|info|solid|overlay
import { Avatar } from "@/components/ui/Avatar";            // src + name (inițiale fallback) · xs..xl
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";    // icon, title, description, action
import { ErrorState } from "@/components/ui/ErrorState";    // onRetry → buton „Reîncearcă” (texte implicite din `ui`)
import { ListItem } from "@/components/ui/ListItem";        // href | externalHref | onClick · icon | leading · subtitle · trailing · active

import { PageHeader } from "@/components/ui/PageHeader";
<PageHeader title={t("orders")} back />                        // pagini interne: back = router.back() sau back="/account"
<PageHeader title={t("shop")} actions={<IconButton …/>} />     // pagini de nivel întâi: ☰ meniul aplicației automat
// Header complet cu logo/căutare/coș/inbox: components/TopBar.tsx

import { Sheet, SheetClose } from "@/components/ui/Sheet";  // side: bottom (implicit) | left | right
<Sheet open={open} onOpenChange={setOpen} title={t("filters")} footer={<Button block>{t("apply")}</Button>}>…</Sheet>

import { Dialog, DialogClose } from "@/components/ui/Dialog"; // confirmări/formulare scurte
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs"; // TabsList variant="underline"|"pill", scroll orizontal
import { Input, Textarea, Field, TextField, fieldClasses } from "@/components/ui/Input";
<TextField label={t("email")} type="email" error={errors.email} />
<Field label={t("city")}>{(f) => <Select {...f} options={cities} placeholder={t("choose")} />}</Field>
import { Select } from "@/components/ui/Select";            // select nativ stilizat (picker de sistem pe mobil)
import { Switch } from "@/components/ui/Switch";            // Radix, dă-i aria-label sau <label htmlFor>
import { useToast } from "@/components/ui/Toast";           // ToastProvider e deja în AppShell
const { toast } = useToast(); toast({ title: t("saved"), tone: "success" });
```

## Navigare

- Registrul unic al modulelor: `lib/nav/modules.ts` (id, rută, iconiță, grup, flag, roluri, cheie i18n).
  Meniul (☰), BottomNav, EcosystemBar și Discover citesc de aici. Modul nou = o intrare + `appMenu.items.<id>` în 7 limbi.
- Buton de meniu în orice header: `<AppMenuButton />` (components/nav) sau `useAppMenu()?.setOpen(true)`.
- Logica de rute (ascuns/imersiv/activ): `lib/nav/visibility.ts`.
