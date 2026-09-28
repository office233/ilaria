# Aplicabilitatea twitter/the-algorithm pentru Swypik

Evaluare: 2026-09-27. Referință de arhitectură pentru recomandări; nu s-a importat cod și nu s-a instalat infrastructura Twitter.

## Concluzie

Este util pentru verificarea separării etapelor și a semnalelor. Swypik are deja o implementare proprie semnificativă. Prioritatea este validarea ei pe date reale, apoi îmbunătățiri măsurate; nu înlocuirea întregului backend.

| Idee din arhitectura X | Situația găsită în Swypik | Acțiune propusă |
|---|---|---|
| Mai multe surse de candidați | following, fresh, trending, topic, explore, backfill în lib/feed/candidates | Măsurarea contribuției fiecărei surse și a timpului SQL |
| Ranking după semnale | lib/feed/scoring.ts: completare, watch time, likes, comments, shares, saves, follows, skip, negative, recency, topic | Calibrare pe date proprii; ponderile existente nu sunt performanță demonstrată |
| Amestec și filtre | lib/feed/rank.ts, visibility.ts, hydrate.ts | Teste de diversitate, repetare, blocări și conținut moderat |
| Recomandări semantice | embedding.ts există, inactiv implicit | Activare numai după embeddings populate, index și măsurători; fără GPU nou acum |
| Feedback din utilizare | evenimente, validări și configurație A/B există în cod | Conectarea corectă a identității și evenimentelor mobile; măsurarea expunerilor reale |

Pentru Swypik propunem să urmărim satisfacția/revenirea utilizatorului, salvările, descoperirea creatorilor noi și semnalele negative. Pentru produse: relevanță și disponibilitate, ulterior conversii/retururi. Acestea sunt propuneri pentru Swypik, nu rezultate deja măsurate ori ponderi de copiat de la Twitter.

## Limite

README-ul proiectului Twitter spune că lipsesc fișierele Bazel de build/workspace de nivel superior. Nu este un serviciu complet gata de instalare în Azure. Existența codului nu oferă datele Swypik, un model validat pentru video-commerce sau capacitate demonstrată la milioane de utilizatori. Migrarea directă nu este justificată în acest moment în bugetul total propus de 500 USD/lună; nu s-a calculat un cost de rulare al întregului sistem Twitter.

Licența repository-ului este AGPL-3.0. Secțiunea 13 cere oferirea sursei corespunzătoare utilizatorilor care interacționează prin rețea cu o versiune modificată. Orice preluare de cod necesită verificarea obligațiilor pentru integrarea concretă. Recomandarea actuală este analiza conceptelor și dezvoltarea implementării proprii existente.

## Surse primare

- https://github.com/twitter/the-algorithm
- https://github.com/twitter/the-algorithm/blob/main/home-mixer/README.md
- https://github.com/twitter/the-algorithm/blob/main/product-mixer/README.md
- https://github.com/twitter/the-algorithm/blob/main/COPYING

Această evaluare este statică; calitatea recomandărilor și capacitatea în producție necesită date și teste separate.
