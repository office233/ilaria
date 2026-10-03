# Ilaria: plan multimodal și eficiență — 2026-10-01

State: COMPLETE pentru acest plan documentar; experimentele de mai jos sunt PROPOSED, neexecutate.
Scope: un singur document nou; fără modificări de produs, antrenare, instalări sau citirea greutăților/datelor private.

## Reguli și suprafețe actuale verificate

- `ilaria/AGENTS.md`: o singură familie IMC, pornită de la inițializare aleatoare; experții sunt instanțe IMC specializate, cu proveniență și evaluare înghețată înainte de promovare.
- Encoderele propuse sunt proprii, antrenate de la zero, sau interfețe pentru componente proprii. Encodere pretrained externe necesită autorizare viitoare explicită; checkpoints LM externe rămân excluse de regulile actuale.
- `ilaria/forge/imc_model.py:30–50`: proiecții ternare cu STE și activări int8 simulate în tensori floating point; nu înseamnă automat kernel packed sau antrenare în 1,58 biți.
- `ilaria/forge/imc_model.py:218`: `hidden(ids)` începe cu embeddinguri de tokeni; nu oferă încă intrare pentru secvențe de embeddinguri audio/vizuale. În suprafețele publice inspectate nu am identificat encoder multimodal/conector antrenat.
- `ilaria/forge/imc_model.py:253`: această funcție greedy recalculează contextul la fiecare pas; nu implementează KV cache. Nu extrapolăm observația la toate runtime-urile.
- `ilaria/forge/train_ilaria.py:373–441`: autocast BF16/FP16 sau FP32, AdamW, model mutat pe dispozitiv fără conversie explicită a parametrilor. `save_imc:265` păstrează greutăți latente, nu un export compact pentru inferență.
- `ilaria/runtime/tritpack20/README.md`: codec și MatVec CPU de referință, cu limite explicite; nu transformer complet, encoder, kernel de dispozitiv sau sistem distribuit.
- `ilaria/specs/myriad.swyp:9–48`: `CorticalRequest.modality` și `CorticalResponse.latent_summary` sunt stringuri, nu un contract tensor cu shape/dtype/byte budget.
- `ilaria/runtime/router/router.go:52` + `connectome/connectome.go:148`: rang de experți întregi după domeniu, prag și fallback; nu gating MoE pe token în blocurile IMC.
- `runtime/protocol/contract.go:81`, `world/world.go:74`, `pce/capsule.go:36`: filtre de transfer după privacy class și capsule din observații cu dovezi. Eticheta nu dovedește singură anonimizare sau corectitudinea observației.
- Granițe păstrate: Ilaria deține encodere/model/rutare; Swyp deține schema și verificarea; SwypikOS acordă capabilități și aplică politica dispozitivului. Nu duplicăm controllerul energetic sau lucrările de rețea existente.

## Ce susțin sursele primare

| Propunere | Concluzie verificată și limită |
| --- | --- |
| Encoder modular + conector | LLaVA conectează un encoder vizual la spațiul de embeddinguri prin proiecție antrenabilă; demonstrează o structură utilă, nu performanța unor encodere IMC proprii. Modelul său pretrained nu este adoptat aici. [LLaVA §4](https://arxiv.org/html/2304.08485v2) |
| BitLinear pentru toate modulele | BitNet original păstrează greutăți latente, gradient și optimizer în precizie mare; b1.58 folosește proiecții ternare. Aplicarea la encoder audio/vizual sau conector este o ablație de validat, nu compatibilitate garantată. [BitNet §2.2](https://arxiv.org/html/2310.11453v1), [b1.58](https://arxiv.org/html/2402.17764v1) |
| 2B4T validează multimodalul | Raportul furnizat descrie un LM antrenat de la zero; multimodalitatea este direcție viitoare. Separă weights packed pentru inferență de master BF16 pentru antrenare. [2B4T](https://arxiv.org/html/2504.12285v2) |
| Latențe anonime și mici | Embeddingurile text au fost inversate în condițiile experimentului; latentul nu este anonimizare. Rezultatele nu cuantifică automat scurgerea encoderului nostru, care trebuie testată separat. [Vec2Text](https://arxiv.org/abs/2310.06816) |
| Merge prin vot majoritar ternar | DiLoCo agregă diferențe ale parametrilor și aplică un optimizer extern; nu votează semne. MAGNET declară agregare pe latente FP32 și re-quantizare după merge; validarea sa la scară mare este încă limitată. [DiLoCo §2](https://arxiv.org/html/2311.08105v3), [MAGNET §10,13](https://arxiv.org/html/2603.25813v1) |
| Rețea de răspunsuri = MoE | Rutarea cererilor între experți întregi diferă de selecția experților în straturile unui transformer. MoE distribuit adaugă costuri de activări/comunicație și necesită alt experiment. [Switch Transformer](https://arxiv.org/abs/2101.03961) |
| Economii energetice/cache demonstrate | 2B4T raportează estimări de energie pentru aritmetică, memorie non-embedding și latențe într-un setup CPU specific; acestea nu sunt Joules/token măsurate pe Nexus și nu dovedesc cache residency pe orice host. [2B4T tabelul 1/apendice B](https://arxiv.org/html/2504.12285v2) |

## Bugete reale: memorie, latențe și transmisie

- Pentru parametri + gradients + două momente Adam toate FP32: estimarea structurală este `16 * N` bytes, circa 16 GB pentru 1B parametri, înainte de activări, temporare, allocator, encoder și conector. Dtype-urile/stările reale trebuie înregistrate după un pas; autocast nu dovedește optimizer compact.
- BF16 master dintr-un alt model nu dovedește că optimizerul sau gradients sunt BF16 în Ilaria. Sharding/offload pot reduce RAM per participant, nu costul total automat; DiLoCo păstrează o replică și stări locale, nu împarte implicit modelul.
- Payload ternar TritPack20: `4 * ceil(N_projection/20)` bytes, plus headers/scales. Embeddingurile, normele, encoderul, activările și cache-ul se contabilizează separat; nu aplicăm 1,6 bits întregului proces.
- Latent tensor: `tokens * width * bytes_per_element`, verificat fără overflow înainte de alocare. Exemplu ilustrativ: 256 × 2048 × 2 = 1 MiB, fără metadata; base64 mai adaugă aproximativ o treime. Poate depăși documentul sursă.
- Contract viitor explicit: version, modality, encoder/connector hashes, shape, dtype, decoded/encoded byte ceilings, max tokens/frames/pages, deadline, privacy class și provenance. Refuz NaN/Inf, forme incompatibile, oversized/duplicate/unknown fields; fără decode nebounded.
- Transmiterea latentelor sau update-urilor nu acordă autoritate OS și nu protejează implicit datele. Date personale și derivate rămân locale; policy de egress și dovezi independente înainte de transfer/promovare.

## Experimente incrementale propuse, fiecare cu evaluare înghețată

1. **Contract și admission, fără modele externe:** fixtures sintetice pentru envelope/modality; selectăm encoderul numai dacă este disponibil și autorizat. Documente prin fs.read scoped și limite de pagini/decompresie; audio din fișier autorizat înainte de microfon live. Refuz modality/capability lipsă, anulare, deadline, dtype/shape/hash greșit; niciun fallback la cloud.
2. **Un singur encoder propriu + conector IMC:** alegem audio sau documente după capabilitățile reale disponibile și ținta măsurabilă. Document text → IlariaLex; scanuri → encoder vizual propriu; audio → encoder propriu. Același IMC și lineage, cu intrare multimodală explicită propusă; fără a crea a doua familie LM.
3. **Ablare precizie:** FP32/BF16 referință versus ternar doar conector, apoi anumite proiecții encoder. Aceleași date publice/sintetice aprobate, seed-uri, token budget și split final separat; măsurăm grounding/doc accuracy sau WER/task success audio, loss, stabilitate, peak RAM/VRAM și bytes transmis.
4. **Inferență și cache:** comparator IMC identic, packed versus floating; apoi KV cache doar pentru această cale care recalculează contextul. Verificăm logits/calitate și limite/eviction; cold/warm, prefill/decode separat, context/concurență fixe. Cache hits și cache bytes se măsoară, nu se deduc din packing.
5. **Rutare între experți:** folosim routerul existent ca baseline cu task success, p50/p95, total RAM și bytes/retry/fallback; verificăm câștigul față de cel mai bun expert la același buget. MoE pe token rămâne cercetare separată, fără promisiune de energie redusă doar din expert count.
6. **Merge offline candidat:** aceeași arhitectură/tokenizer/ancestry, latent-delta FP32 + optimizer extern versus baseline nemergiat. Majoritatea semnelor poate fi comparator experimental, niciodată echivalent declarat: quantizarea și media nu comută în general. Testăm drift, regression, stale/poisoned updates și resume; nicio promovare automată a production weights.

## Jobs semnate, confidențialitate și dovada contribuției — propunere

- Curatorul/operatorul poate aproba jobs cu issuer pinned, expiry, recipe/model/data hashes și bugete; validate și pe coordinator, și la admission. Semnătura jobului confirmă originea, nu împiedică un client modificat să mintă despre execuție sau update.
- Trainingul PyTorch obișnuit consumă features lizibile procesului worker; tokenizarea/embeddingurile și TLS nu oferă confidențialitate față de acel worker. Matrici criptate complet inaccesibile necesită un protocol specializat și threat model verificat (de exemplu MPC), cu costuri proprii; nu există această garanție în codul inspectat. [CrypTen](https://arxiv.org/abs/2109.00984)
- Replicarea pe 3/5 noduri poate detecta unele defecte numai cu independență reală și ipoteze explicite despre adversari; coluziunea/Sybils compromit votul. Chei distincte nu dovedesc operatori independenți. [The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/)
- STE/Adam produc gradients/update-uri floating point; majoritatea valorilor ternare nu dovedește training corect, util sau complet. Receipt-ul semnat leagă job, output hash și identitate, nu certifică singur calculul. Se validează recipe/ancestry, shapes/dtype/finite values, update bounds și freshness înainte de orice evaluare.
- Propunem candidate quarantine, anchor recomputation pe subset public/sintetic, holdout independent necunoscut workerului și agregare robustă numai după validarea ipotezelor sale. Krum ilustrează agregare Byzantine cu condiții, nu o garanție generică pentru orice rețea/număr de noduri. [Krum](https://arxiv.org/abs/1703.02757)
- Teste viitoare: job emis de cheie neautorizată, recipe substitution, stale/replayed output, Sybils/coluziune și poison; separat, rezultate oneste pe backends/precizii diferite. Calibrăm toleranțe numerice și evaluăm calitatea; nu excludem automat workerul pentru diferențe FP legitime sau hashes diferite ale update-urilor nedeterministe.
- Promovarea rămâne decizie autenticată a operatorului după lineage + frozen evaluation; memorie personală locală. Jurnalul de dovezi și politica curatorului nu necesită blockchain. Măsurăm bytes/Joules totale inclusiv replicare, anchors, retry și rezultate respinse, nu doar nodul câștigător.
## Măsurarea energiei și acceptarea

- Preînregistrăm limite de RAM/VRAM, bytes, latență și degradare de calitate în manifest; un experiment trece numai dacă respectă toate, cu lineage și evaluare reproducibilă.
- Metrică energetică: `Joules/token = energy_delta / output_tokens`; pentru audio/doc adăugăm Joules/minut audio sau pagină și Joules/rezultat corect. Raportăm durata, device/backend/precizie/context/thread count și encoder + conector + inferență + comunicație.
- Folosim numai contoare efectiv disponibile prin interfețele existente: domeniul CPU-package/GPU/whole-device, units, timestamps, wrap/reset și idle baseline explicit. Power samples se integrează în timp; wați, TDP, CPU% sau frecvența nu sunt Joules/token. Domeniile suprapuse nu se însumează.
- Dacă lipsesc contoarele, raportăm `energy: unmeasured`; timpul/RAM/bytes/calitatea pot fi măsurate independent. În această etapă nu s-au probat contoare și nu există câștig energetic nou demonstrat.
- Participarea mobilă este opt-in, fără pornire implicită pe baterie; respectă politicile existente de încărcare/baterie/thermal, deadline, anulare și bugete. La telemetry lipsă refuzăm participarea energetică nesupravegheată; nu inventăm praguri universale.
- Livrabil următor recomandat: contract bounded + fixtures + un encoder propriu mic/conector experimental, după scope și buget aprobate. Acest document nu declară multimodalitate funcțională, antrenare 1B finalizată sau superioritate mondială.

Validation: surse primare accesate 2026-10-01; inspecție țintită a surselor publice enumerate. Report-only: line ceiling, whitespace și `git diff --check`; suitele produselor și experimentele nu au fost rulate.
