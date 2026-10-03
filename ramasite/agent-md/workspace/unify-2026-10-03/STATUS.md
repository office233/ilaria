# Unificare Nexus — stare la 3 octombrie 2026, 11:05

Coordonator: sesiunea Antigravity `03c60614-6480-4261-a141-09706e2172a2`. Execuția: agenți „flash”.
Ținta: **un singur folder `E:\nexus`**, cu Git curat și la zi pe GitHub. În `E:\arhiva-ceo` nu mai rămâne nimic legat de Nexus.

## Deciziile utilizatorului
1. Commit pe ramură → push → CI verde pe GitHub → merge în `main`.
2. Ramurile neintegrate se integrează una câte una, cu review și teste.
3. Ce ține de Nexus din CEO și din folderele externe se mută în `ramasite/`. Uneltele, datele și binarele ajung în `ramasite/local`, care e ignorat de Git. Sursele externe se șterg după verificarea hash-urilor. Meister ERP, GPT Bridge și materialele CEO generale rămân în `E:\arhiva-ceo`.
4. Swypik (commerce, mobile, site) intră în nexus **cu istoricul Git**.

## Ce s-a făcut

| # | Pas | Rezultat | Dovezi |
|---|---|---|---|
| 0 | Audit inițial | Go trecea; Forge avea 27 de teste picate; 728 de modificări necomise; 68 de worktree-uri | raportul de audit din conversație |
| 0 | Backup de siguranță | `git bundle --all` (18,5 MB) + tar cu 4.195 de fișiere necomise, refs și lista de worktree-uri | `ramasite/local/backups/2026-10-03/` |
| 1A | Comiterea reorganizării | ramura **`chore/nexus-unify-20261003`**, 12 commit-uri (`4790607d` … `667609df`). Forge 735/735, Go vet/test pe toate modulele, contractele, gate-urile effects/supervisor, checkout-ul public 57/57 și `diff --check`: toate PASS | `git log 06a5f39..chore/nexus-unify-20261003` |
| 1B | Inventarul folderelor externe | 133 de elemente clasificate (Nexus vs. non-Nexus) | `external-inventory.md/json` |
| 1C | Triajul celor 37 de ramuri | 5 de integrat, 16 înglobate deja în altele, 16 candidate la ștergere (snapshot-uri) | `branch-triage.md/json` |
| 1D | Inventarul `E:\Swypik` | 6 repo-uri; „mobile” = aplicația Expo nativă (`swypik/mobile`); `commerce/mobile` = shell-ul Capacitor vechi. Snapshot-urile din nexus sunt identice ca hash | `swypik-inventory.md/json` |
| 3a | Păstrarea worktree-urilor | toate cele 67 de worktree-uri externe au fost șterse, după 54 de commit-uri `wip(preserve)` pe ramurile lor și 67 de tag-uri `archive/wt/*`. A rămas doar `E:\nexus`. Fără secrete, niciun blob peste 4 MB | `worktree-preservation.md/json` |
| 3b | Importul istoricului Swypik (pregătit) | `refs/imports/swypik-commerce` (istoric curat, nu shallow, arborele identic cu `3fbaf9f6`), `refs/imports/swypik-mobile`, `refs/imports/swypik-site`. Secret check: PASS. Cele 6 repo-uri sunt salvate ca bundle-uri (inclusiv istoricul vechi cu secrete, păstrat **doar offline**), plus 3.377 de fișiere rămase din worktree-uri | `swypik-import.md/json`, `ramasite/local/archive/swypik-*` |

## În lucru acum
- **Integratorul de ramuri:** în 6 loturi pe `chore/nexus-unify-20261003`. (1) `integration/nexus-git-order-20261003`, cu 13 funcționalități de kernel/Swyp/plan approval; (2) `office233-swypik-mobile-delivery`; (3) `agent/ceo-benchmark-evidence` + `agent/swyp-broker-host-v1`; (4) `codex/imc1b-azure-a100`; (5) documentele de finanțare din `agent/ternary-pretrain`; (6) `computefabric`, dacă nu dublează cod existent. Log: `integration-log.md`.
- **Migratorul de active externe:** mută `E:\arhiva-ceo\tools`, benchmark-urile vechi, `E:\nexus-sources` și `E:\nexus-training` în `ramasite/local/...`. Ce trebuie urmărit în Git stă temporar în `ramasite/local/incoming/`. Log: `external-migration.md`.
- **Atenție:** o altă sesiune a utilizatorului (agentul „site builder”) editează live `site/`, fără commit. Agenții de unificare nu ating `site/`.

## Ce mai rămâne
1. Atașarea istoricului Swypik la ramură: merge `-s ours` cu prefixele `swypik/commerce`, `swypik/mobile` și `site`, fără să se schimbe conținutul. Se face după integrator și după ce agentul de site comite.
2. Comiterea elementelor din `ramasite/local/incoming/` (documente, înregistrări, dovezi mici) și a snapshot-urilor de cod ca ramuri `archive/*`. Corectarea căilor hardcodate către `E:\nexus-sources`, `E:\nexus-training` și `E:\arhiva-ceo`.
3. Comiterea, în repo-ul `E:\arhiva-ceo`, a eliminării fișierelor Nexus mutate.
4. Gate-urile complete (`verify-workspace.ps1`) → **push** `chore/nexus-unify-20261003` → CI pe GitHub → merge în `main` → push `main`.
5. Curățenia ramurilor: cele integrate se șterg, iar cele neintegrate rămân ca tag-uri `archive/*`, cu confirmarea utilizatorului.
6. Ștergerea `E:\Swypik` (58 GB, din care 52 GB e scratch în `_work`; agentul a dat verdictul READY FOR DELETION) și a folderelor externe goale. **Doar cu confirmarea utilizatorului.**
7. Commit-ul acestor rapoarte (`ramasite/agent-md/workspace/unify-2026-10-03/`).

## Revenire în caz de problemă
- Toate ramurile și tag-urile de dinainte: `git clone ramasite/local/backups/2026-10-03/nexus-all-refs.bundle`.
- Starea necomisă inițială: `tar -xf ramasite/local/backups/2026-10-03/dirty-worktree.tar`.
- Starea fiecărui worktree șters: tag-ul `archive/wt/<nume>`.
