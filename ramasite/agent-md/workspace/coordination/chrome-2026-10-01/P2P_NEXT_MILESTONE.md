# Următoarea etapă P2P: contribuție reală, evaluare și adoptare controlată

Evidență inspectată la 1 octombrie 2026. Această etapă este restantă;
nu certifică training distribuit, apărare Sybil sau superioritate a modelului.

## Situație demonstrată în sursa curentă

- `swypik-os/core/federated/federated.go`, `ComputeMicroBatch`: gradientele
  provin din `rand.Float64`, iar loss-ul este înmulțit cu `0.985`. Este simulator,
  fără forward/backward al modelului Ilaria IMC în această cale.
- `NewFederatedAggregator` inițializează vectori demonstrativi LoRA prin rand;
  acești vectori nu dovedesc actualizarea checkpointului Ilaria antrenat.
- `VerifyProofOfCompute` recalculează un hash al câmpurilor trimise. Din această
  verificare rezultă integritatea mesajului; nu rezultă dovada muncii GPU,
  proveniența datasetului sau calitatea unei contribuții.
- `swypik-os/core/swarm/swarm.go` invocă acest simulator. Cheile Ed25519,
  plafonul cozii și filtrele existente sunt mecanisme utile, dar nu reprezintă
  fluxul complet de învățare P2P cerut în Goal.

## Rezultat necesar pentru prima demonstrație funcțională

Două procese participante comunică printr-un protocol explicit și contribuie
la un model IMC propriu. Un participant calculează o actualizare prin modelul
real; contribuția este validată, evaluată și adoptată numai dacă gate-ul trece.
Versiunea precedentă poate fi restaurată. Toate rezultatele sunt reproductibile.

1. Inventariază contractele și runtime-ul public existente înainte de modificări.
   Reutilizează modelul IMC și schema existentă dacă există; nu crea o familie
   pretrained, un validator duplicat sau un al doilea simulator cu același rol.
2. Ilaria deține calculul actualizării, agregarea și evaluarea modelului. Swyp
   deține semantica/schema unde este potrivit. OS deține transportul, resursele,
   consent/capabilities și execuția efectelor, fără import de internals Ilaria.
   Planul trebuie să elimine dublarea actuală a rolurilor, cu migrare verificabilă.
3. Contractul fixează versiunea/model/base hash/round, formele și tipurile,
   identitatea, consimțământul, nonce/replay, limita de mărime și bugetele.
   Semnătura și checksum-ul nu sunt prezentate drept dovadă a calității/muncii.
4. Gate-ul folosește public synthetic fixtures și o configurație mică a
   arhitecturii IMC existente, pentru backprop și loss evaluate realmente.
   Este probă de mecanism, nu înlocuire a țintei IMC-125M/1B sau benchmark global.
5. Acoperă contribuție validă, bază/stare expirată, participant necunoscut,
   replay, consimțământ revocat, payload invalid/supradimensionat, shape/NaN/Inf,
   peer dispărut, suprasarcină, evaluare regresivă și rollback. Promovarea
   candidatului respins nu schimbă modelul activ. Actualizarea/rollback sunt atomice.
6. Măsoară scalar loss înainte/după, bytes transportați, limitele de memorie/coadă
   și timpii de contribuție/evaluare/adoptare. Nu credita TFLOPS auto-declarate.

## Limitele execuției curente

Antrenarea Colab și controllerul ei rămân neatinse. Fără corpus/date private,
weights ignorate, secrete, schimbări Forge, alocări sau training Colab suplimentar.
Probele locale folosesc numai date publice sintetice și stare temporară proprie.
Nu edita claims vechi de swarm/CLI/cache/energy fără predare confirmată.
Implementarea se face în worktree dedicat, pe claims exacte, cu baseline și gates.

Prioritate imediată: finalizarea corecției kernel OC3 și a runnerului OC2.
Următorul job OpenCode poate produce inventarul/planul concret pentru această
etapă numai după terminarea jobului curent și pregătirea guardianului de buget.
Maximum un model job OpenCode simultan; nu trata acest document drept implementare.
