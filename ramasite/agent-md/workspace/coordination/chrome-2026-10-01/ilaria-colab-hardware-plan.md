# Ilaria — comparație economică a hardware-ului Colab

PROPUNERE, 2026-10-01; nicio alocare, antrenare, achiziție sau schimbare de controller/Forge în acest turn.

## Ce există și ce încă nu știm
- Pilotul seed7 este COMPLETE/NOT_PROMOTED: fiecare variantă3815 pași și1.000.079.360 tokenuri, confirmate prin metadatele publicării la12:10UTC. Best validation CE: FP2.048409217596054; ternary2.175886482000351. Un singur seed nu dovedește superioritate generală.
- Ambele semnături publicate indică torch2.11.0+cu128, CUDA, calcul BF16, batch32/accum4/context2048; diferă parametrizarea ternary. „FP control” nu înseamnă calcul FP32. Schimbarea hardware-ului trebuie izolată de schimbarea reprezentării/modelului.
- „G4” este eticheta din registrul pilotului, nu un model NVIDIA verificat. Metadatele publicate spun numai device=cuda. Verificarea permisă `colab status --session imc125-genesis-seed7` a raportat session not found și a eliminat un record local stale; nu a oprit/restartat/alocat vreun runtime remote.
- GPU-ul NVIDIA efectiv, VRAM și rata CU a pilotului nu sunt demonstrate de aceste metadate. A100 și orice alt GPU sunt candidați condiționați de identificarea efectivă și disponibilitatea aprobate, nu resurse rezervate. Tipurile disponibile/limitele se pot schimba. [Google Colab FAQ](https://research.google.com/colaboratory/faq.html#resource-limits)

## Contract comun înaintea oricărei lansări
- Reutilizăm `forge/imc_model.py`, `forge/config/imc_125m_recipe.json`, `forge/imc_125m_launch.py`, `forge/train_ilaria.py` și `forge/training_state.py`; fără trainer/controller duplicat și fără editarea lor în acest plan.
- Model identic: preset imc-125m,125.882.112 parametri, vocab65536, d768/layers12/heads12/KV4/FFN2048, context/max-seq2048. Fără comparație A100+IMC1B contra G4+IMC125M.
- SHA train `7f5a4fdee4295f8600dbff1701d42eac888dae826d9e0f71ce4270aaaa611988`; validation `7dfd45041e1267b88c34d7c9bdfb36ba705cb12a2fac7229309ad15f5607400e`; tokenizer `54f5f3b8d0d490e2fed3c3e1cd23c4a35efaa2e0a02468437f7fa9a471be3019`.
- Dataset-manifest SHA `4fa9a5166c57926df56e867eed5001510e1b3c92b3dd6477de9e0ee09af6a935`; recipe SHA `c68e6b220a3f184fdb43ced1f0f0b843768a1e94b97ccca80f409f1d231fa32d`. Se fixează și freeze/curriculum/source hashes din manifestul emis, fără deschiderea corpusului/greutăților în acest turn.
- Date numai curate și aprobate explicit pentru scopul experimentului; semnătura/hashul nu acordă drepturi asupra datelor. Date personale locale nu se mută implicit în cloud/global. Un smoke sintetic public rămâne separat de verdictul pe corpusul pilotului.
- Etapa hardware-only folosește FP-control, seed7, world_size1, aceeași inițializare/RNG și ordine de eșantionare. O schimbare de microbatch, kernel, AMP sau reprezentare este un factor experimental separat, înregistrat înainte de lansare.
- Fixăm batch32/accum4:2048×32×4=262.144 tokenuri/update; target1.000.000.000 →3815 updates →1.000.079.360 tokenuri efective. AdamW lr6e-4/min6e-5, warmup200, cosine, wd0.1, betas0.9/0.95, eps1e-8, clip1; chunked-loss și grad-checkpoint ON, compile OFF.
- Precision explicit BF16 numai pentru GPU-uri care îl suportă efectiv; fără `auto` între brațe. Dacă un GPU impune FP16 sau un batch mai mic, se propune o pereche nouă cu aceleași setări pe toate brațele; OOM/unsupported se raportează, nu se ascunde prin fallback.
- Înregistrăm toate flags/valorile rezolvate, source/build/CUDA/driver/PyTorch/NumPy versions, TF32/determinism/compile/checkpoint settings, initial/parent hashes și seed. Nu pretindem checkpointuri bit-identice între platforme/runtime-uri. [PyTorch reproducibility](https://docs.pytorch.org/docs/2.14/notes/randomness.html)

## Trei etape, admise separat
| Etapă | Lucrare egală / dovadă | Limită propusă, încă neautorizată |
|---|---|---|
|1: throughput+corectitudine|Maximum2 GPU-uri efectiv identificate; FP seed7,64 updates/16.777.216 tokenuri per braț;10 warmup updates excluse din rata steady-state,54 măsurate; finite loss/gradient și validare identică.|Maximum15 minute wall per GPU, maximum1 runtime de comparație activ; CU_CAP_1 numeric stabilit de root înainte de alocare.|
|2: replay de calitate|Numai GPU-ul care trece etapa1 și justifică eficiența; replay FP seed7 cu același orizont1B/eval250×20; comparăm CE/ancore la aceleași updates/tokenuri cu curba pilotului existent, fără repetarea implicită a referinței complete.|Maximum2 ore wall per invocare; CU_CAP_2 și total cumulat pentru toate resume-urile stabilite înainte de lansare.|
|3: seeduri independente|Numai după comparația hardware: seed11 și19, același contract; FP/ternary se tratează separat, cu medie/dispersie și regresii comune; zero „fuziune” automată de checkpointuri.|Buget nou pe seed/variantă și total; wall și CU caps scrise explicit; neautorizat în acest turn.|
- Etapa1 păstrează orizontul LR1B prin `--target-tokens 1000000000 --stop-after 64`; folosește `--eval-every 16 --eval-iters 20 --sample-tokens 0`. Aceste diferențe față de pilot sunt comune ambelor GPU-uri și consemnate; warmup-ul de benchmark nu înlocuiește warmup-ul LR200.
- La etapa2 se restaurează eval-every250/eval-iters20 și ceilalți parametri ai contractului; checkpointul etapei1 nu este resume exact al acestui contract diferit. Startul/replay-ul este emis separat din aceeași inițializare aprobată.
- Dacă targetul complet nu încape în wall/CU aprobate, oprire la limită cu checkpoint valid și verdict INCOMPLETE. Prefixele se compară numai cu metricele pilotului păstrate la aceiași pași/tokenuri; dacă lipsesc, se cere buget pentru o referință scurtă, nu se inventează valori.
- Estimare înaintea etapei2: tokenuri rămase/tokens-s măsurat + validare/checkpoint/I/O/startup. Decizia folosește CU/token și timp efectiv, nu presupunerea că GPU-ul mai puternic este mai ieftin sau îmbunătățește calitatea singur.

## Măsurători și oprire
- Inventar la admitere, numai după autorizare: nume GPU real/vendor/capability/VRAM, pool label separat, RAM/CPU, runtime și driver; operatorul furnizează planul, soldul CU/rata observată și limitele numerice. Nu presupunem gratuitate, preț sau disponibilitate.
- Măsurăm tokens/s steady-state și end-to-end separat, startup/warmup/eval/checkpoint/upload seconds, tokenuri/update, total wall și checkpoint/publication hashes. Același input/politică de caching; nu atribuim cache-ul de date diferenței de GPU.
- GPU timing cu sincronizare sau CUDA events; peak allocated și reserved VRAM cu reset separat după warmup, plus peak host/process RSS și sistem RAM. Valorile PyTorch descriu allocatorul/tensorii, nu toată VRAM a procesului/dispozitivului. [Timing](https://docs.pytorch.org/docs/stable/notes/cuda.html), [allocated](https://docs.pytorch.org/docs/stable/generated/torch.cuda.memory.max_memory_allocated.html), [reserved](https://docs.pytorch.org/docs/2.14/generated/torch.cuda.memory.max_memory_reserved.html)
- Trainerul curent raportează tok/s din wall și nu dovedește peakVRAM/RSS/consum CU; instrumentarea aprobată a probei încă trebuie demonstrată, fără modificări aici. Joules/token=UNMEASURED dacă nu există contor energetic efectiv; CPU%, TDP sau CU nu devin energie.
- CU folosite se înregistrează înainte/după, inclusiv overhead și orice braț abandonat; unde rata există, CU≈rate_CU_per_hour×wall_hours este estimare, nu factură. Cost monetar numai din tarif/document operator verificat. Sold/rate/cost necunoscut persistent → nu se lansează/nu se continuă.
- Nu există flags canonice `--max-cu`/`--max-walltime`: enforcement trebuie validat prin mecanismul operațional existent, deținut de root, înainte de launch. Nu creăm controller nou și nu presupunem că `--stop-after` limitează CU sau timpul.
- STOP la wall/CU/total cap, lipsă consent, identitate/hash/contract diferit, OOM/nonfinite, checkpoint/publication coruptă sau imposibilitatea verificării bugetului; persistăm un receipt scalar și un checkpoint coerent când e posibil. Nicio promovare automată.

## Colab și oprirea PC-ului
- Nu folosim Colab pentru mesh/server P2P ori workers distribuiți pe un plan neeligibil; restricțiile pentru remote/distributed free-tier și interdicțiile generale rămân aplicabile. Nu ocolim limite prin alte conturi/keepalive. Comparația propusă este batch ML, nu file sharing sau serviciu de rețea. [Google Colab FAQ](https://research.google.com/colaboratory/faq.html)
- PC-ul se oprește la02:00 Europe/Bucharest pe2 octombrie; root impune safe paid-local STOP01:30 =2026-10-01T22:30:00Z. Nicio probă nouă aproape de cutoff fără timp pentru checkpoint+verificare; aceste mecanisme/bugete nu sunt schimbate aici.
- Trainingul rulează pe VM remote; checkpoint/resume persistent, optimizer/scaler/RNG/step/tokenuri+signature și publication atomic/hash trebuie să permită reluarea independent de browser/PC, prin mecanismul existent. `--resume` verifică signature; `--init-from` este warm start cu reset, nu resume exact.
- Închiderea browserului nu oferă durată de viață garantată: Colab poate termina VM-ul și resursele sunt dinamice. Root aprobă separat dacă un job remote poate continua după cutoff și verifică checkpointul persistent; un helper local oprit nu poate garanta stop remote. [Google Colab FAQ](https://research.google.com/colaboratory/faq.html)

Dovezi folosite: numai surse publice canonice, cele două checkpoint.publish metadata și coordinator-observation COMPLETE; CLI help/status read-only, fără kernel exec/corpus/tensors/weights/secrets. Network20claims și ceilalți owners nu au fost modificați. Acesta este un plan, nu benchmark hardware executat sau rezervare Colab.
