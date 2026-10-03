# Contract SwypikOS ↔ Ilaria

Snapshot 27 septembrie 2026; alt agent modifică activ integrarea. Ilaria a fost inspectat numai în citire.

Surse: `D:\ilaria\cmd\ilaria-serve\main.go`, `D:\swypik-os\core\ilaria\backend.go`, `D:\swypik-os\cmd\swypik-os\main.go`.

## Protocol observat

- Ilaria: HTTP `127.0.0.1:8091`; checkpoint/tokenizer furnizate explicit la pornire.
- `GET /health`: disponibilitatea serviciului.
- `POST /v1/chat`, JSON: `{"prompt":"Salut","history":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`.
- Răspuns: `reply`, `tokens`, `calls`. Clientul OS consumă `reply` și `error`.
- Maximum 20 mesaje istorice, perechi user/assistant; corp maximum 64 KiB. Serverul serializează inferența; timeout 2 minute, client 130 secunde.
- Serverul verifică host/origin. Clientul acceptă doar HTTP pe `127.0.0.1`, fără proxy/redirecturi.

Acesta este transportul către Ilaria, nu o arhitectură cu furnizori externi de modele.

## Următoarele verificări

1. Serviciu absent, model invalid, timeout, anulare și server ocupat.
2. Răspuns real pe checkpoint declarat; istoric respectând protocolul.
3. Erori vizibile fără răspuns inventat; reconectare fără duplicarea mesajelor.
4. Acțiunile OS validate separat; textul generat nu autorizează execuție arbitrară.

Nu expunem endpointul loopback direct pe internet. Inferența la distanță necesită contract cu TLS și autentificare, coordonat cu Ilaria; nu presupunem că există deja.
