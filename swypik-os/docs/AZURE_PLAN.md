# Azure + NVIDIA Brev — plan de infrastructură OS

27 septembrie 2026. Nu au fost create/modificate resurse cloud în această etapă.

## Amplasare

Utilizatorul a confirmat: Colab inițial, apoi 8 NVIDIA H200 prin brev.nvidia.com. Azure găzduiește serviciile OS. Nu solicităm GPU H200 Azure pentru această configurație.

```text
SwypikOS Windows ── loopback ── Ilaria/Nexus local
       │
       └── HTTPS autentificat ── Azure: dispozitive/sarcini/versiuni
                                      │
                               artefacte/checkpointuri
                                      │
                               Colab → Brev: 8 H200
```

Conexiunile cloud sunt planificate. Contractul implementat observat este local.

## Inventar verificat în citire

Subscription activă: Azure subscription 1. În rg-swypik-prod, Sweden Central:

| VM | SKU |
| --- | --- |
| swypik-prod-data | Standard_E2as_v7 |
| swypik-prod-web-1 | Standard_D2as_v7 |
| swypik-prod-web-2 | Standard_D2as_v7 |
| swypik-prod-worker-1 | Standard_D2as_v7 |

Inventarul nu este test de sănătate/capacitate. Producția existentă rămâne separată.

## Instanță nouă propusă

- Grup: rg-swypik-os-dev; VM: swypik-os-control-dev-01.
- Linux, fără GPU; inițial 2–4 vCPU și 8–16 GB RAM, SKU validat la provisioning.
- Sweden Central ca alegere inițială, revizuită după regiunea reală Brev și măsurarea latenței/transferurilor.
- Serviciu OS separat, portabil: identitate dispozitiv, sarcini, versiuni; HTTPS, revocare și jurnal. Fără expunerea API-ului local de shell.
- Artefacte/checkpointuri în stocare separată; identitate gestionată; backup și restaurare testată. Secretele nu intră în repo.
- O instanță de dezvoltare pentru MVP. Redundanța producției urmează măsurătorile.

VM-ul necesită patching și mentenanță; estimarea include discuri, stocare și trafic. Quota și capacitatea sunt distincte. [Microsoft: Azure VMs](https://learn.microsoft.com/en-us/azure/virtual-machines/overview).

Nu copiem executabilul Windows pe Ubuntu ca soluție de migrare. Coordonatorul cloud este un livrabil nou. Backendul dinamic GPU Go Nexus are build tags `gpu && windows`; compatibilitatea Linux trebuie demonstrată de Nexus înaintea servirii GPU în Brev.

## Colab → Brev

Nexus deține rețeta de training: dependențe fixate, dataset manifest, checkpoint/hash, tokenizer, configurație, optimizer/scheduler și RNG pentru resume. OS consumă starea joburilor și rezultatele.

Verificare pe instanța reală: 8 H200, VRAM, driver/CUDA, topologie interconectare și test distribuit cu resume. Rezervarea, regiunea și capacitatea nu sunt încă verificate în cont. [NVIDIA Brev Quickstart](https://docs.nvidia.com/brev/getting-started/quickstart).

Checkpointurile au copie independentă și restaurare testată. Workspace-ul Brev persistă la oprire, dar ștergerea instanței elimină datele; restartul depinde de capacitate. [NVIDIA GPU Instances](https://docs.nvidia.com/brev/concepts/gpu-instances).

## Ordinea migrării

1. Închidem integrarea locală și testele OS.
2. Implementăm coordonatorul minim și protocolul worker, cu contract Nexus.
3. Confirmăm regiunea Brev, costul Azure, transferurile și retenția checkpointurilor. Sunt costuri de infrastructură, nu bugete de tokenuri.
4. Pregătim infrastructură declarativă pentru VM, rețea, identitate, stocare, monitorizare și backup.
5. Deployment în grupul nou; test un dispozitiv, reboot, retry, revocare, backup/restore.
6. Extindere după rezultate reale; rollback de serviciu fără pierderea checkpointurilor.

Rămân de stabilit: regiunea/rezervarea Brev, profilul joburilor GPU și costul estimat. Creditele și cotele istorice nu dovedesc bugetul disponibil acum.
