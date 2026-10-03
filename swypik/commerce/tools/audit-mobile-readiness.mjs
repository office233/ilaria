import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'docs/audits/mobile-inventory');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const relative=p=>path.relative(root,p).replaceAll('\\','/');
function route(p){return '/'+relative(p).replace(/^app\//,'').replace(/\/(page|route)\.tsx?$/,'').split('/').filter(x=>!/^\(.+\)$/.test(x)).join('/');}
const files=walk(path.join(root,'app'));
const apis=files.filter(p=>/route\.ts$/.test(p)).map(p=>{const s=fs.readFileSync(p,'utf8');return {path:route(p),file:relative(p),methods:[...new Set([...s.matchAll(/export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map(m=>m[1]))],authSignals:[...new Set([...s.matchAll(/\b(getAuthSession|getSellerSessionId|requireAdmin|requireRole|requireInternalAuth|verifyWebhook|cookies|headers)\b/g)].map(m=>m[1]))],featureGates:[...s.matchAll(/isEnabled\(["']([^"']+)["']\)/g)].map(m=>m[1]),nextCoupled:/next\/headers|next\/navigation/.test(s)};});
const pages=files.filter(p=>/page\.tsx$/.test(p)).map(p=>({path:route(p),file:relative(p)}));
const groups={};for(const item of apis){const group=item.path.split('/')[2]||'root';(groups[group]??=[]).push(item);}
const portable=['lib/feed/types.ts','lib/feed/client/feed-source.ts','lib/feed/event-types.ts','lib/feed/event-guards.ts','lib/seller/invoicing.ts','lib/seller/product-schemas.ts','lib/validation/schemas.ts','lib/auth/session.ts','lib/ai/ilaria.ts'].filter(f=>fs.existsSync(path.join(root,f))).map(file=>{const s=fs.readFileSync(path.join(root,file),'utf8');return {file,imports:[...s.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(m=>m[1]),serverSignals:/server-only|next\/headers|@\/lib\/db|node:|\bBuffer\b/.test(s),browserSignals:/\b(window|document|localStorage|HTMLVideoElement)\b/.test(s),note:'Static candidate only; transitive dependencies and device behavior require review'};});
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'routes.json'),JSON.stringify({scope:'Static inventory; presence is not evidence of functionality. Auth signals are not security verdicts.',apiRouteCount:apis.length,pageCount:pages.length,apis,pages,reuseCandidates:portable},null,2)+'\n');
const lines=['# Inventar inițial Swypik pentru mobil','',`Scanare: ${pages.length} pagini Next.js, ${apis.length} fișiere API, ${Object.keys(groups).length} familii API.`,'','Inventar static reproductibil, nu certificare de funcționalitate. Rutele pot delega autorizarea și metodele prin importuri; listele goale cer verificare manuală. Nu sunt scanate secretele .env.','','| Familie API | Rute | Semnale de dependență Next headers/navigation |','|---|---:|---:|',...Object.entries(groups).sort().map(([k,v])=>`| ${k} | ${v.length} | ${v.filter(x=>x.nextCoupled).length} |`),'','## Cod de evaluat pentru reutilizare','','| Fișier | Semnale server | Semnale browser |','|---|---|---|',...portable.map(x=>`| ${x.file} | ${x.serverSignals?'da':'nu detectate'} | ${x.browserSignals?'da':'nu detectate'} |`),'','Detaliile pe fiecare rută și importurile candidaților sunt în routes.json.',''];
fs.writeFileSync(path.join(output,'README.md'),lines.join('\n'));
console.log(JSON.stringify({pages:pages.length,apiRoutes:apis.length,apiFamilies:Object.keys(groups).length,output}));
