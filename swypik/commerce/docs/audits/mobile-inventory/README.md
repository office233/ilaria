# Inventar inițial Swypik pentru mobil

Scanare: 173 pagini Next.js, 426 fișiere API, 76 familii API.

Inventar static reproductibil, nu certificare de funcționalitate. Rutele pot delega autorizarea și metodele prin importuri; listele goale cer verificare manuală. Nu sunt scanate secretele .env.

| Familie API | Rute | Semnale de dependență Next headers/navigation |
|---|---:|---:|
| [code] | 1 | 0 |
| account | 1 | 0 |
| admin | 63 | 0 |
| apply-seller | 1 | 0 |
| audio | 3 | 0 |
| auth | 10 | 4 |
| bookings | 1 | 0 |
| campaigns | 3 | 0 |
| cart | 4 | 1 |
| categories | 1 | 0 |
| causes | 1 | 0 |
| chat | 1 | 0 |
| checkout | 2 | 0 |
| collections | 4 | 0 |
| comments | 3 | 0 |
| couriers | 8 | 0 |
| creator | 23 | 0 |
| creators | 1 | 0 |
| cron | 30 | 0 |
| dispatch | 1 | 0 |
| dm | 9 | 0 |
| donations | 1 | 0 |
| explore | 1 | 0 |
| feed | 6 | 0 |
| fleet-partners | 1 | 0 |
| fly | 5 | 0 |
| founding-slots | 1 | 0 |
| fx | 1 | 0 |
| gaming | 6 | 0 |
| geo | 3 | 0 |
| go | 1 | 0 |
| health | 6 | 0 |
| host | 7 | 0 |
| hosts | 1 | 0 |
| i18n | 1 | 0 |
| ilaria | 1 | 0 |
| inquiries | 1 | 0 |
| internal | 3 | 0 |
| listings | 1 | 1 |
| live | 11 | 0 |
| local-orders | 5 | 0 |
| me | 3 | 0 |
| merchants | 8 | 0 |
| messenger | 5 | 0 |
| missions | 3 | 0 |
| movies | 8 | 0 |
| music | 14 | 0 |
| news | 4 | 0 |
| notifications | 4 | 0 |
| onboarding | 2 | 0 |
| orders | 4 | 0 |
| partner | 2 | 0 |
| posts | 3 | 0 |
| products | 8 | 2 |
| push | 3 | 0 |
| r | 1 | 0 |
| ready | 1 | 0 |
| referral | 1 | 0 |
| reviews | 2 | 0 |
| rides | 9 | 0 |
| root | 3 | 0 |
| search | 2 | 0 |
| seller | 32 | 0 |
| shop | 1 | 0 |
| sitemap | 1 | 0 |
| sitemap.xml | 1 | 0 |
| stays | 13 | 0 |
| stripe-connect | 3 | 0 |
| trips | 1 | 0 |
| unsubscribe | 1 | 0 |
| upload | 1 | 0 |
| users | 25 | 0 |
| v1 | 6 | 0 |
| videos | 15 | 0 |
| vitals | 1 | 0 |
| webhooks | 1 | 0 |

## Cod de evaluat pentru reutilizare

| Fișier | Semnale server | Semnale browser |
|---|---|---|
| lib/feed/types.ts | nu detectate | nu detectate |
| lib/feed/client/feed-source.ts | nu detectate | nu detectate |
| lib/feed/event-types.ts | nu detectate | nu detectate |
| lib/feed/event-guards.ts | nu detectate | nu detectate |
| lib/seller/invoicing.ts | nu detectate | nu detectate |
| lib/seller/product-schemas.ts | nu detectate | nu detectate |
| lib/validation/schemas.ts | nu detectate | nu detectate |
| lib/auth/session.ts | da | nu detectate |
| lib/ai/ilaria.ts | da | nu detectate |

Detaliile pe fiecare rută și importurile candidaților sunt în routes.json.
