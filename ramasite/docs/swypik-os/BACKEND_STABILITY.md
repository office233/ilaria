# Backend funcțional — prima etapă

27 septembrie 2026. Interfața este lucrată separat de alt agent; această etapă modifică motorul Ilaria, execuția comenzilor și API-ul local. Nu modifică Ilaria.

## Probleme reparate

- Timeout HTTP de 60 secunde incompatibil cu inferența locală: write timeout 150 secunde și buget total de conversație 135 secunde, inclusiv coada.
- Mutexul conversației ținea cererile anulate blocate: coadă serială care respectă contextul. Un rezultat sosit după anulare nu este păstrat în istoric.
- Istoric limitat doar ca număr de mesaje: corpul JSON este acum încadrat în 64 KiB eliminând perechi vechi complete; mesajul curent nu este trunchiat. Promptul prea mare este respins explicit.
- Răspunsurile Ilaria sunt citite integral în limita a 128 KiB și validate ca un singur document JSON.
- Comenzile ignorau contextul cererii și acumulau output nelimitat: context propagat, timeout de 30 secunde păstrat, preview de maximum 256 KiB cu marcaj de trunchiere și pipe wait limitat.

## Verificare

Teste pentru anulare în coadă, rezultat tardiv, recuperarea cozii, deconectare HTTP, eroare Ilaria fără fals succes, limita JSON după escaping, istoric invalid, răspuns invalid/prea mare, anularea comenzilor și limitarea outputului.

Suita Go și go vet au trecut. Race detector a trecut pentru core/ilaria, core/coder și ui/web; core/ilaria a fost reverificat după modificarea protocolului.

## Limite rămase

- Serviciul real Ilaria nu răspundea pe 127.0.0.1:8091 la verificare. Testele folosesc backenduri controlate; nu dovedesc calitatea modelului sau inferența GPU.
- Actualizare: executorul Windows folosește acum Job Objects, cu asocierea shellului înainte de prima instrucțiune. Anularea și încheierea comenzii opresc descendenții obișnuiți ai jobului. Testele acoperă copii reali și comenzi concurente; aceasta nu reprezintă un sandbox de securitate.
- Istoricul este în memorie, comun motorului; conversații multiple persistente necesită un contract separat cu UI.
- Limita de transport în octeți nu garantează încadrarea în contextul tokenizerului modelului. Ilaria rămâne responsabil pentru această verificare.
- Interfața finală și testul end-to-end cu model real rămân de verificat după sincronizarea lucrului celuilalt agent.
