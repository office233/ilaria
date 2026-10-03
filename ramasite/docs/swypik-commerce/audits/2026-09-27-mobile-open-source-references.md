# Referințe pentru aplicația mobilă — 27 septembrie 2026

## Alegere

Păstrăm aplicația Swypik și backendul comun Azure. Cele două repository-uri sunt referințe, nu înlocuitori ai platformei. Nu s-a importat cod extern.

- ProxiTok: frontend PHP pentru vizualizarea TikTok, requesturi intermediare pe server, profiluri/taguri și RSS. AGPL-3.0. Util pentru idei privind navigarea și separarea serviciilor externe; nu oferă backendul propriu Swypik, algoritm de recomandări pentru datele noastre sau UI React Native. Nu adăugăm PHP/scraping TikTok în aplicație.
- Clone-Wars: catalog de proiecte independente; fiecare proiect are propria licență și nivel de maturitate. Lista nu reprezintă un framework ori o certificare de securitate/scalare.
- Candidat relevant găsit în listă: kirkwat/tiktok, React Native + Expo + TypeScript, licență MIT. Referință pentru feed, profiluri, follow și comentarii. Package.json folosește Expo 49, expo-av și Firebase 10; pilotul nostru folosește Expo 57 și expo-video. Refolosirea literală nu este compatibilă fără adaptare. Orice cod efectiv preluat trebuie însoțit de notificarea MIT și verificat, cu integrare la API-ul Azure existent.

Propuneri pentru Swypik: navigare verticală cu un singur clip activ, profil de creator, interacțiuni legate de identitatea reală, card de produs asociat videoclipului. Nu s-au implementat aceste funcții prin copierea repository-urilor. Studio/crearea videoclipurilor rămâne inaccesibil utilizatorilor la cererea proprietarului.

## Medii

Producția Swypik este găzduită în Azure. Codul și testele acestei etape sunt locale, în E:\Swypik\swypik\app și E:\Swypik\swypik-mobile-pilot. Corecțiile de autentificare și modificările prototipului nu sunt încă publicate în Azure. Localhost este doar previzualizare. Publicarea necesită trecerea verificărilor și verificarea stării actuale a VM-urilor, fără schimbarea prematură a domeniilor.

## Surse verificate

- https://github.com/pablouser1/ProxiTok
- https://github.com/GorvGoyl/Clone-Wars
- https://github.com/kirkwat/tiktok
- https://github.com/kirkwat/tiktok/blob/main/frontend/package.json
- https://github.com/kirkwat/tiktok/blob/main/LICENSE
