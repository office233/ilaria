# Corecții autentificare mobilă — 27 septembrie 2026

Modificări locale, încă nepublicate în Azure:

- `/api/auth/me` folosește resolverul comun cu Bearer numai când resolverul cookie raportează guest. Identitatea seller/admin existentă nu este combinată cu alt Bearer.
- Refresh-ul folosește un singur statement PostgreSQL: consumă sesiunea și inserează succesorul în aceeași operație atomică. Tokenul trebuie să aibă formatul exact de 64 caractere hex.
- Emiterea și refresh-ul resping banned/suspended/deleted și suspendarea temporară activă.

Validare efectuată:
- 1933 teste Vitest / 204 fișiere: trecute, inclusiv 13 teste noi mobile-auth.
- TypeScript fără emitere: trecut.
- Lint pe fișierele modificate: trecut.
- i18n guard: trecut.
- PostgreSQL 16.14 local, bază postgres, schemă izolată cu fixture-uri eliminată după test: un singur succesor la refresh concurent; rollback la eșecul inserării; conturi restricționate respinse. Nu s-au utilizat date reale sau credențiale din aplicație.
- Buildul Next.js: reușit (exit 0), 690 pagini generate. Avertismente lint preexistente; conexiunea DB locală de build la portul 15433 a fost indisponibilă pentru secțiunile discover, care au folosit fallback. Nu este o verificare end-to-end a datelor de producție.

Pilotul mobil: Studio a fost eliminat din rute și navigare; exporturile Android/iOS/web au trecut după eliminare. Numai Descoperă și Magazin sunt expuse. Nu s-a activat loginul în pilot înainte de publicarea backendului compatibil.

Test reproductibil PostgreSQL local: `node tests/integration/mobile-token-rotation.local.mjs`. Scriptul folosește explicit containerul WSL local existent și o schemă proprie, fără acces la Azure.

