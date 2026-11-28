'use strict';
/**
 * G-Ondzet : serveur des comptes, du chat (texte + images) et des notifications (promos / codes de jeux).
 * Aucune dépendance : Node 18+ suffit.   Lancer :  ADMIN_KEY="ton-secret-long" node server.js
 * Variables : PORT (3000), DATA_DIR (./data), ADMIN_KEY (obligatoire pour la page /admin), TRUST_PROXY=1 derrière un proxy HTTPS.
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });

// ---------------------------------------------------------------- stockage (fichiers JSON, écriture atomique)
function load(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (e) { return def; } }
const db = {};   // v5.24 : rempli par initDb() apres la restauration de la sauvegarde durable (voir plus bas)
function initDb() {
  Object.assign(db, {
  users: load('users.json', {}),          // clé = pseudo en minuscules
  sessions: load('sessions.json', {}),    // clé = sha256(token)
  messages: load('messages.json', []),
  notifs: load('notifs.json', []),
  friends: load('friends.json', {}),      // v5.23 : clé = pseudo en minuscules -> { f: [amis], in: [demandes reçues], out: [demandes envoyées] } (pseudos en minuscules)
  dms: load('dms.json', []),              // v5.23 : messages privés { id, from, to, text, image, ts } (pseudos en minuscules)
  groups: load('groups.json', {}),        // v5.23 : groupes { id, name, owner, members: [pseudos en minuscules], created }
  gmsgs: load('gmsgs.json', []),
  steam: load('steam.json', {}),          // v5.25 : pseudo -> [{ id, label, steamId, shared }]
  vaults: load('vaults.json', {}),        // v5.25 : pseudo -> { blob (chiffré par l'appli, illisible ici), ts }          // v5.23 : messages de groupe { id, g, user, text, image, ts }
  trials: load('trials.json', {}),        // v5.31 : essais de thèmes -> empreinte appareil -> { thème: début (ms serveur) }
  purchases: load('purchases.json', []),  // v5.35 : achats (PIN / thème) { id, user, kind, item, theme, tx, status, ts, done } ; status = pending | accepted | refused
  unlocks: load('unlocks.json', {}),      // v5.35 : pseudo en minuscules -> [indices des thèmes débloqués]
  ugames: load('ugames.json', {}),        // v5.79 : pseudo en minuscules -> [noms des jeux que le joueur possede] (envoyes par l'appli ; affiches sur son profil, aux amis)
  gunlocks: load('gunlocks.json', {}),    // v5.36 : pseudo en minuscules -> [noms des jeux débloqués (Compte Jeux)]
  coffre: load('coffre.json', null),      // v5.47 : coffre Steam CHIFFRE (la phrase secrète ne quitte jamais le navigateur de l'administrateur) { vault: {v,s,i,c}, ts, src, prev }
  catalog: load('catalog.json', { games: [], ts: 0 }),
  downloads: load('downloads.json', null),   // v5.62 : liens de telechargement par plateforme (source de verite = ce serveur) { data: {schema, apps:[...]}, ts, src }
  coffrepub: load('coffrepub.json', { on: false, auto: false, vault: null, ts: 0 }),   // v5.62 : copie CHIFFREE du coffre publiee sur /public/coffre.json (pour le site)   // v5.47 : liste des jeux (noms seulement) pour « envoyer un jeu » depuis /admin
  seq: Object.assign({ msg: 0, notif: 0, dm: 0, grp: 0, gmsg: 0, purchase: 0 }, load('seq.json', {}))
});
}
// v5.45 : une erreur imprévue (promesse rejetée, disque, réseau) est journalisée mais ne tue plus le serveur : sur Render, un processus arrêté = erreur 502 pour tous
process.on('uncaughtException', e => console.error('Erreur non interceptée :', e && e.stack || e));
process.on('unhandledRejection', e => console.error('Promesse rejetée non interceptée :', e && e.stack || e));
const dirty = new Set(); let timer = null;
function save(...names) {
  names.forEach(n => dirty.add(n));
  if (timer) return;
  timer = setTimeout(flush, 300);
}
function flush() {
  timer = null;
  for (const n of Array.from(dirty)) {
    try {
      const f = path.join(DATA, n + '.json'), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db[n])); fs.renameSync(tmp, f);
      ghQueue.add(n + '.json'); rQueue.add(n + '.json');
      dirty.delete(n);
    } catch (e) { console.error('écriture ' + n + '.json impossible :', e.message); timer = timer || setTimeout(flush, 5000); }   // on réessaie dans 5 s, rien n'est perdu
  }
}
process.on('SIGINT', () => { flush(); Promise.all([ghFinal(), rFinal()]).then(() => process.exit(0)); });
process.on('SIGTERM', () => { flush(); Promise.all([ghFinal(), rFinal()]).then(() => process.exit(0)); });


// ---------------------------------------------------------------- v5.24 : sauvegarde durable (GitHub)
// Sur l'offre gratuite de Render le disque est EFFACE a chaque redemarrage (le service s'endort apres 15 min) :
// comptes, sessions, amis, messages, images et vocaux disparaissaient -> les comptes « se deconnectaient tout seuls ».
// Avec GH_TOKEN + GH_REPO (depot PRIVE), chaque fichier de DATA_DIR est copie sur GitHub et restaure au demarrage.
const GH = {
  token: process.env.GH_TOKEN || '', repo: process.env.GH_REPO || '', branch: process.env.GH_BRANCH || 'main',
  dir: (process.env.GH_DIR || 'gondzet-data').replace(/^\/+|\/+$/g, ''), api: (process.env.GH_API || 'https://api.github.com').replace(/\/$/, '')
};
const GH_ON = !!(GH.token && GH.repo);
const ghQueue = new Set(), ghSha = {};   // fichiers a envoyer / sha connu sur GitHub
async function ghFetch(method, url, body, raw) {
  const r = await fetch(GH.api + url, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({ Authorization: 'Bearer ' + GH.token, 'User-Agent': 'g-ondzet-server', 'X-GitHub-Api-Version': '2022-11-28',
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' }, body ? { 'Content-Type': 'application/json' } : {})
  });
  return r;
}
const ghPath = rel => '/repos/' + GH.repo + '/contents/' + GH.dir + '/' + rel.split('/').map(encodeURIComponent).join('/');
async function ghRestore() {
  if (!GH_ON) { console.log('Sauvegarde durable : DESACTIVEE (GH_TOKEN / GH_REPO absents) - sur Render gratuit les donnees sont perdues au redemarrage'); return; }
  try {
    const t = await ghFetch('GET', '/repos/' + GH.repo + '/git/trees/' + encodeURIComponent(GH.branch) + '?recursive=1');
    if (t.status === 404 || t.status === 409) { console.log('Sauvegarde GitHub : depot vide, on demarre a neuf'); return; }
    if (!t.ok) throw new Error('arbre GitHub ' + t.status);
    const tree = (await t.json()).tree || [], pre = GH.dir + '/';
    const files = tree.filter(x => x.type === 'blob' && x.path.startsWith(pre)).map(x => ({ rel: x.path.slice(pre.length), sha: x.sha }))
      .filter(x => /^(?:[a-z_]+\.json|uploads\/[0-9a-f]{32}\.(?:png|jpg|gif|webp|m4a|webm|ogg))$/.test(x.rel));
    let n = 0, i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < files.length) {
        const f = files[i++], dst = path.join(DATA, f.rel);
        if (f.rel.startsWith('uploads/') && fs.existsSync(dst)) { ghSha[f.rel] = f.sha; continue; }
        const r = await ghFetch('GET', ghPath(f.rel) + '?ref=' + encodeURIComponent(GH.branch), null, true);
        if (!r.ok) { console.error('restauration ' + f.rel + ' : ' + r.status); continue; }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer())); ghSha[f.rel] = f.sha; n++;
      }
    }));
    console.log('Sauvegarde GitHub : ' + n + ' fichier(s) restaure(s)');
  } catch (e) { console.error('Restauration GitHub impossible :', e.message); }
}
let ghBusy = false;
async function ghPush() {
  if (!GH_ON || ghBusy || !ghQueue.size) return;
  ghBusy = true;
  const list = Array.from(ghQueue); list.forEach(x => ghQueue.delete(x));
  for (const rel of list) {
    try {
      const f = path.join(DATA, rel); if (!fs.existsSync(f)) continue;
      const content = fs.readFileSync(f).toString('base64');
      for (let k = 0; k < 3; k++) {
        const r = await ghFetch('PUT', ghPath(rel), { message: 'sauvegarde ' + rel, content, branch: GH.branch, sha: ghSha[rel] });
        if (r.ok) { const j = await r.json(); ghSha[rel] = j.content && j.content.sha; break; }
        if (r.status === 409 || r.status === 422) {   // sha perime ou fichier deja la : on relit son sha
          const g = await ghFetch('GET', ghPath(rel) + '?ref=' + encodeURIComponent(GH.branch));
          if (g.ok) { ghSha[rel] = (await g.json()).sha; continue; }
          delete ghSha[rel]; continue;
        }
        throw new Error('PUT ' + rel + ' : ' + r.status);
      }
    } catch (e) { console.error('sauvegarde ' + rel + ' :', e.message); ghQueue.add(rel); }
  }
  ghBusy = false;
}
setInterval(() => { flush(); ghPush().catch(() => { ghBusy = false; }); }, +process.env.GH_EVERY_MS || 20e3).unref();
async function ghFinal() { try { flush(); ghBusy = false; await ghPush(); } catch (e) { } }

// ---------------------------------------------------------------- v5.25 : sauvegarde durable GRATUITE alternative (Upstash Redis, API REST)
// Variables : UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (inutile si la sauvegarde GitHub ci-dessus est active : une seule à la fois).
// Chaque fichier (JSON, images, vocaux) est coupé en morceaux < 1 Mo (limite de l'offre gratuite) sous une clé versionnée ;
// un pointeur est changé en dernier, donc une coupure en plein envoi ne corrompt jamais la version précédente.
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !GH_ON && /^(https:\/\/|http:\/\/localhost[:/])/.test(R_URL + '/') && !!R_TOKEN;
const RK = 'gondzet:f:', RCHUNK = 700000, rQueue = new Set();
const JSON_NAMES = ['users', 'sessions', 'messages', 'notifs', 'friends', 'dms', 'groups', 'gmsgs', 'steam', 'vaults', 'trials', 'purchases', 'unlocks', 'gunlocks', 'ugames', 'coffre', 'catalog', 'downloads', 'coffrepub', 'seq'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rcmd(args) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(20000) });
  let j = {}; try { j = await r.json(); } catch (e) { }
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
async function rPut(rel, buf) {
  const b64 = buf.toString('base64'), n = Math.max(1, Math.ceil(b64.length / RCHUNK)), ver = Date.now().toString(36);
  for (let i = 0; i < n; i++) await rcmd(['SET', RK + rel + ':' + ver + ':' + i, b64.slice(i * RCHUNK, (i + 1) * RCHUNK)]);
  const old = await rcmd(['GET', RK + rel]);
  await rcmd(['SET', RK + rel, JSON.stringify({ ver, n })]);
  if (old) { try { const o = JSON.parse(old); for (let i = 0; i < o.n; i++) rcmd(['DEL', RK + rel + ':' + o.ver + ':' + i]).catch(() => { }); } catch (e) { } }
}
async function rGet(rel) {
  const ptr = await rcmd(['GET', RK + rel]);
  if (!ptr) return null;
  const { ver, n } = JSON.parse(ptr), parts = [];
  for (let i = 0; i < n; i++) { const c = await rcmd(['GET', RK + rel + ':' + ver + ':' + i]); if (c == null) throw new Error('morceau manquant : ' + rel); parts.push(c); }
  return Buffer.from(parts.join(''), 'base64');
}
let rReady = false, rRetry = null, rChain = Promise.resolve();
async function rLoop() {
  while (rQueue.size) {
    const rel = rQueue.values().next().value; rQueue.delete(rel);
    try { const f = path.join(DATA, rel); if (fs.existsSync(f)) await rPut(rel, fs.readFileSync(f)); }
    catch (e) {
      rQueue.add(rel); console.error('Sauvegarde Upstash impossible (' + rel + ') : ' + e.message);
      if (!rRetry) rRetry = setTimeout(() => { rRetry = null; rPush(); }, 10000);
      return;
    }
  }
}
function rPush() { if (REMOTE && rReady) rChain = rChain.then(rLoop).catch(e => console.error('Sauvegarde Upstash :', e && e.message)); return rChain; }
async function rFinal() { if (!REMOTE || !rReady) return; try { flush(); await Promise.race([rPush(), sleep(8000)]); } catch (e) { } }
async function rRestore() {
  if (!REMOTE) { if (!GH_ON) console.log('Sauvegarde Upstash : désactivée (variables absentes)'); return; }
  for (let attempt = 1; ; attempt++) {
    try {
      let n = 0;
      for (const name of JSON_NAMES) {
        const buf = await rGet(name + '.json');
        if (buf) { fs.writeFileSync(path.join(DATA, name + '.json'), buf); n++; }
        else if (fs.existsSync(path.join(DATA, name + '.json'))) rQueue.add(name + '.json');   // rien en ligne : on envoie ce qu'on a
      }
      rReady = true; rPush();
      console.log('Sauvegarde Upstash active : ' + n + ' fichier(s) restauré(s)');
      return;
    } catch (e) {
      console.error('Sauvegarde Upstash : restauration impossible (essai ' + attempt + ') : ' + e.message);
      if (attempt >= 5) { console.error('Arrêt pour ne pas écraser les données en ligne.'); process.exit(1); }
      await sleep(3000 * attempt);
    }
  }
}
setInterval(() => { if (rQueue.size) { flush(); rPush(); } }, 3000).unref();

// ---------------------------------------------------------------- outils
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashSecret(secret, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const h = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: h.toString('hex') };
}
function checkSecret(secret, rec) {
  const h = Buffer.from(hashSecret(secret, rec.salt).hash, 'hex'), x = Buffer.from(rec.hash, 'hex');
  return h.length === x.length && crypto.timingSafeEqual(h, x);
}
const normAnswer = a => String(a).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const FAKE_Q = ['Quel est le nom de votre premier animal ?', 'Quel est votre jeu préféré ?', 'Dans quelle ville êtes-vous né(e) ?'];
function fakeQuestion(u) { return FAKE_Q[parseInt(sha('q|' + u).slice(0, 4), 16) % FAKE_Q.length]; }
function safeEq(a, b) { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); }

const hits = new Map();   // limiteur : clé -> [horodatages]
function limited(key, max, windowMs) {
  const now = Date.now(), l = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (l.length >= max) { hits.set(key, l); return true; }
  l.push(now); hits.set(key, l); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function ipOf(req) { return (TRUST_PROXY && req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(body);
}
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpErr(413, 'Trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new HttpErr(400, 'JSON invalide')); } });
    req.on('error', reject);
  });
}
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null;

function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { user: username, ts: Date.now() };
  save('sessions'); return token;
}
function auth(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  const s = m && db.sessions[sha(m[1])];
  if (!s) throw new HttpErr(401, 'Connexion requise');
  const u = db.users[s.user.toLowerCase()];
  if (!u) throw new HttpErr(401, 'Connexion requise');
  if (u.banned) throw new HttpErr(403, 'Compte suspendu');
  return u;
}
function admin(req) {
  if (!ADMIN_KEY) throw new HttpErr(503, 'ADMIN_KEY non définie sur le serveur');
  // v5.35 : seuls les ECHECS comptent (la page /admin se rafraichit toute seule toutes les 8 s) ; 20 echecs en 10 min = blocage, meme avec la bonne cle
  const k = 'adm|' + ipOf(req), now = Date.now();
  if ((hits.get(k) || []).filter(t => now - t < 600e3).length >= 20) throw new HttpErr(429, 'Trop d\'essais');
  if (!safeEq(String(req.headers['x-admin-key'] || ''), ADMIN_KEY)) { limited(k, 20, 600e3); throw new HttpErr(403, 'Clé administrateur incorrecte'); }
}
// v5.46 : evenements pour l'appli G-Ondzet Admin (achats, nouveaux comptes, messages du chat)
function adminEvents(after, now) {
  const ev = [];
  for (let i = db.purchases.length - 1; i >= 0 && db.purchases[i].ts > after; i--) {
    const p = db.purchases[i]; if (p.ts > now) continue;
    const what = p.kind === 'theme' ? 'le thème « ' + p.item + ' »' : p.kind === 'pin' ? 'le code PIN de « ' + p.item + ' »' : 'le jeu « ' + p.item + ' »' + (p.acc ? ' — Compte ' + p.acc : '');
    ev.push({ id: 'p' + p.id, type: 'purchase', ts: p.ts, title: '🛒 Nouvel achat · ' + p.user, text: p.user + ' veut ' + what + (p.tx ? ' · ID ' + p.tx : p.image ? ' · photo de la transaction jointe' : '') });
  }
  for (let i = db.messages.length - 1; i >= 0 && db.messages[i].ts > after; i--) {
    const m = db.messages[i]; if (m.ts > now) continue;
    ev.push({ id: 'm' + m.id, type: 'message', ts: m.ts, title: '💬 Chat · ' + m.user, text: m.text || (m.audio ? '(message vocal)' : '(image)') });
  }
  for (const u of Object.values(db.users)) if (u.created > after && u.created <= now) ev.push({ id: 'u' + u.name, type: 'user', ts: u.created, title: '👤 Nouveau compte', text: u.name });
  return ev.sort((a, b) => a.ts - b.ts).slice(-30);
}
// v5.47 : site vitrine (versions.json = infos de telechargement, comptes.html = coffre Steam chiffre)
const SITE_URL = (process.env.SITE_URL || 'https://headless-txoacprvfyt-tedondzet-1409.wix-site-host.com').replace(/\/+$/, '');
async function siteGet(p) {
  let r;
  try { r = await fetch(SITE_URL + p, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(12000) }); }
  catch (e) { throw new HttpErr(502, 'Site injoignable : ' + SITE_URL); }
  if (!r.ok) throw new HttpErr(502, 'Le site a répondu ' + r.status + ' pour ' + p);
  return r.text();
}
const vaultOk = v => !!v && typeof v === 'object' && typeof v.s === 'string' && typeof v.i === 'string' && typeof v.c === 'string' && v.c.length > 20 && v.c.length < 900000 && v.s.length < 100 && v.i.length < 100;
const vaultClean = v => ({ v: 1, s: v.s, i: v.i, c: v.c });
async function vaultFromSite() {
  const html = await siteGet('/comptes.html');
  const m = /var\s+VAULT\s*=\s*(\{[^;]*?\})\s*;/.exec(html);
  if (!m) throw new HttpErr(502, 'Coffre introuvable dans comptes.html (variable VAULT)');
  let v; try { v = JSON.parse(m[1]); } catch (e) { throw new HttpErr(502, 'Coffre illisible dans comptes.html'); }
  if (!vaultOk(v)) throw new HttpErr(502, 'Coffre invalide dans comptes.html');
  return vaultClean(v);
}
function setCoffre(vault, src) {   // garde UNE version precedente (bouton « Annuler la derniere sauvegarde »)
  db.coffre = { vault, ts: Date.now(), src, prev: db.coffre && db.coffre.vault ? { vault: db.coffre.vault, ts: db.coffre.ts } : null };
  save('coffre');
  if (db.coffrepub.on && db.coffrepub.auto) publishCoffre();
}
// v5.62 : publication du coffre CHIFFRE sur /public/coffre.json (le site l'affiche ; sans la phrase secrete il reste illisible)
function publishCoffre() { db.coffrepub = { on: true, auto: !!db.coffrepub.auto, vault: db.coffre.vault, ts: Date.now() }; save('coffrepub'); }
const pubOut = () => ({ on: !!db.coffrepub.on, auto: !!db.coffrepub.auto, ts: db.coffrepub.ts || 0, same: !!(db.coffrepub.on && db.coffre && db.coffre.vault && db.coffrepub.vault && db.coffrepub.vault.c === db.coffre.vault.c) });
const coffreOut = () => Object.assign(db.coffre && db.coffre.vault ? { vault: db.coffre.vault, ts: db.coffre.ts, src: db.coffre.src || '', hasPrev: !!db.coffre.prev } : { vault: null, ts: 0, src: '', hasPrev: false }, { pub: pubOut() });
// v5.62 : liens de telechargement (par application et par plateforme) geres ici, publies sur /public/versions.json (meme format que versions.json du site)
const PF_RE = /^[a-z0-9_-]{2,20}$/;
const clip = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '';
const httpsUrl = v => { if (typeof v !== 'string' || v.length > 2000) return null; try { return new URL(v.trim()).protocol === 'https:' ? v.trim() : null; } catch (e) { return null; } };
function dlSanitize(j) {   // garde les champs inconnus du site, nettoie les champs connus
  const apps = (Array.isArray(j && j.apps) ? j.apps : []).slice(0, 20).map(a => {
    a = a && typeof a === 'object' ? a : {};
    const platforms = {};
    for (const k of Object.keys(a.platforms || {}).slice(0, 20)) {
      if (!PF_RE.test(k)) continue;
      const p = a.platforms[k] || {};
      const versions = (Array.isArray(p.versions) ? p.versions : []).slice(0, 200).map(v => { v = v && typeof v === 'object' ? v : {}; return Object.assign({}, v, { version: clip(String(v.version == null ? '' : v.version), 30), date: clip(v.date, 30), notes: clip(v.notes, 300), url: httpsUrl(v.url), sha256: /^[0-9a-f]{64}$/i.test(v.sha256 || '') ? v.sha256.toLowerCase() : '' }); }).filter(v => v.version);
      platforms[k] = Object.assign({}, p, { latest: clip(String(p.latest == null ? '' : p.latest), 30) || null, versions });
    }
    return Object.assign({}, a, { id: clip(a.id, 40) || 'app', name: clip(a.name, 80) || 'Application', platforms });
  });
  return Object.assign({}, j && typeof j === 'object' ? j : {}, { schema: 1, apps });
}
const dlEmpty = () => ({ schema: 1, apps: [{ id: 'g-ondzet-now', name: 'G-Ondzet Now', platforms: { android: { latest: null, versions: [] }, ios: { latest: null, versions: [] }, windows: { latest: null, versions: [] } } }] });
async function dlFromSite() { return dlSanitize(JSON.parse(await siteGet('/versions.json?t=' + Date.now()))); }
async function dlData() {   // au premier acces : reprend versions.json du site (comme le coffre), sinon une liste vide
  if (!db.downloads || !db.downloads.data) {
    let data = null, src = 'site';
    try { data = await dlFromSite(); } catch (e) { /* site injoignable ou sans versions.json */ }
    if (!data || !data.apps.length) { data = dlEmpty(); src = 'vide'; }
    db.downloads = { data, ts: Date.now(), src }; save('downloads');
  }
  return db.downloads;
}
const dlTouch = (d, src) => { d.ts = Date.now(); d.src = src || 'admin'; save('downloads'); };
function dlApp(data, id) {
  if (!data.apps.length) data.apps.push(dlEmpty().apps[0]);
  const a = id ? data.apps.find(x => x.id === id) : data.apps[0];
  if (!a) throw new HttpErr(404, 'Application introuvable');
  return a;
}
const dlOut = d => ({ ts: d.ts, src: d.src || '', apps: d.data.apps });
const pub = u => ({ username: u.name, avatar: avatarUrl(u) });
// v5.23 : amis / groupes
const dn = k => (db.users[k] ? db.users[k].name : k);                                   // pseudo affiché
const frk = k => db.friends[k] || (db.friends[k] = { f: [], in: [], out: [] });          // fiche d'amis d'un pseudo (minuscules)
const fr = u => frk(u.name.toLowerCase());
function becomeFriends(a, b) {
  const x = frk(a), y = frk(b), del = (l, v) => { const i = l.indexOf(v); if (i >= 0) l.splice(i, 1) };
  [[x, b], [y, a]].forEach(([r, v]) => { del(r.in, v); del(r.out, v); if (!r.f.includes(v)) r.f.push(v) });
}
const gpub = g => ({ id: g.id, name: g.name, owner: dn(g.owner), members: g.members.map(dn) });

// ---------------------------------------------------------------- images
const MAGIC = [
  ['png', b => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', b => b.length > 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString('latin1'))],
  ['webp', b => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP']
];
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
function saveImage(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpErr(400, 'Image invalide');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new HttpErr(413, 'Image trop lourde (3 Mo max)');
  const t = MAGIC.find(x => x[1](buf));
  if (!t) throw new HttpErr(400, 'Format accepté : PNG, JPEG, GIF, WebP');
  const name = crypto.randomBytes(16).toString('hex') + '.' + t[0];
  fs.writeFileSync(path.join(UP, name), buf); ghQueue.add('uploads/' + name); rQueue.add('uploads/' + name);
  return name;
}
// v5.24 : messages vocaux (m4a / webm / ogg, 1,5 Mo max, 60 s max)
const AMAGIC = [
  ['m4a', b => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp'],
  ['webm', b => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
  ['ogg', b => b.length > 4 && b.slice(0, 4).toString('latin1') === 'OggS']
];
function saveAudio(dataUrl) {
  const m = /^data:audio\/[a-z0-9+.-]+(?:;codecs=[a-z0-9.,]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || '');
  if (!m) throw new HttpErr(400, 'Message vocal invalide');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 1.5 * 1024 * 1024) throw new HttpErr(413, 'Message vocal trop long (60 s max)');
  const t = AMAGIC.find(x => x[1](buf));
  if (!t) throw new HttpErr(400, 'Format vocal non reconnu');
  const name = crypto.randomBytes(16).toString('hex') + '.' + t[0];
  fs.writeFileSync(path.join(UP, name), buf); ghQueue.add('uploads/' + name); rQueue.add('uploads/' + name);
  return name;
}
// v5.44 : photo de profil du compte, en forme REDUITE (bulle ronde, ~128 px, quelques Ko), gardee sur le serveur et renvoyee a chaque connexion
const AVATAR_MAX = 150 * 1024;   // taille maximale du data URL recu (l'appli envoie ~5-10 Ko)
function setAvatar(u, dataUrl) {
  const old = u.avatar || '';
  if (!dataUrl) u.avatar = '';
  else {
    if (typeof dataUrl !== 'string' || dataUrl.length > AVATAR_MAX) throw new HttpErr(413, 'Photo de profil trop lourde');
    u.avatar = saveImage(dataUrl);
  }
  if (old && old !== u.avatar) fs.unlink(path.join(UP, old), () => {});
  save('users');
}
const avatarUrl = u => u.avatar ? '/uploads/' + u.avatar : '';
const durOf = v => Math.max(0, Math.min(60000, Math.round(+v || 0)));

// ---------------------------------------------------------------- routes API
const USER_RE = /^[A-Za-z0-9_.-]{3,20}$/;
// v5.37 : clé de déblocage d'un jeu : « Nom#2 » (compte 2 de ce jeu) ou « Nom » seul (ancien format = tous les comptes du jeu)
const gameKey = (name, acc) => acc ? name + '#' + acc : name;
const THEME_NAMES = ['NVIDIA', 'PlayStation 5', 'Xbox', 'Steam', 'PlayStation 4', 'Switch 2'];
// ---------------------------------------------------------------- v5.25 : mes comptes Steam (liste lisible) + coffre chiffré (illisible par le serveur)
function steamIdOf(v) {
  v = String(v || '').trim();
  const m = /^https?:\/\/steamcommunity\.com\/(?:id|profiles)\/([A-Za-z0-9_-]{2,32}|\d{17})\/?$/i.exec(v);
  if (m) v = m[1];
  return /^\d{17}$/.test(v) || /^[A-Za-z0-9_-]{2,32}$/.test(v) ? v : null;
}
const cleanLabel = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : '';

// ---------------------------------------------------------------- v5.56 : partage de partie GeForce NOW (signalisation WebRTC hote <-> ami)
// Salles gardees EN MEMOIRE seulement (jamais ecrites sur disque) : { id, host, guest, game, state, t, seq, msgs }.
// state : invited -> live -> ended | declined. Le flux video et la manette passent directement entre les deux telephones (WebRTC), pas par ce serveur.
const rooms = new Map();
const lc = s => String(s || '').toLowerCase();
function roomFor(u, id) {
  const r = rooms.get(String(id || ''));
  if (!r || (lc(r.host) !== lc(u.name) && lc(r.guest) !== lc(u.name))) throw new HttpErr(404, 'Partie introuvable');
  return r;
}
setInterval(() => {
  const n = Date.now();
  for (const [k, r] of rooms) {
    const old = r.state === 'ended' || r.state === 'declined' ? n - r.t > 120e3 : r.state === 'invited' ? n - r.t > 10 * 60e3 : n - r.t > 8 * 3600e3;
    if (old) rooms.delete(k);
  }
}, 60e3).unref();

// ---------------------------------------------------------------- v5.61 : appels vocaux entre amis (signalisation WebRTC)
// En memoire seulement. state : ringing -> live -> ended | declined. Le son passe directement entre les deux telephones.
const calls = new Map();
const callOver = c => c.state === 'ended' || c.state === 'declined';
function callEnd(c, state) { c.state = state || 'ended'; c.t = Date.now(); }
function callSweep() {
  const n = Date.now();
  for (const [k, c] of calls) {
    if (callOver(c)) { if (n - c.t > 60e3) calls.delete(k); }
    else if (c.state === 'ringing' ? n - c.t > 45e3 : n - Math.min(c.seen.a, c.seen.b) > 45e3) callEnd(c);   // sans reponse, ou un des deux a disparu
  }
}
setInterval(callSweep, 5e3).unref();
function callFor(u, id) {
  callSweep();
  const c = calls.get(String(id || ''));
  if (!c || (lc(c.from) !== lc(u.name) && lc(c.to) !== lc(u.name))) throw new HttpErr(404, 'Appel introuvable');
  c.seen[lc(c.from) === lc(u.name) ? 'a' : 'b'] = Date.now();
  return c;
}

const routes = {
  // v5.61 : photos de profil d'autres joueurs (amis, messages, groupes, recherche) : { avatars: { pseudo_minuscule: '/uploads/…' ou '' } }
  'GET /v1/avatars': async (req, res, url) => {
    const u = auth(req);
    if (limited('avs|' + u.name, 120, 60e3)) throw new HttpErr(429, 'Doucement');
    const out = {};
    String(url.searchParams.get('names') || '').split(',').slice(0, 100).forEach(n => {
      const k = lc(n.trim());
      if (k && Object.prototype.hasOwnProperty.call(db.users, k)) out[k] = db.users[k].banned ? '' : avatarUrl(db.users[k]);
    });
    send(res, 200, { avatars: out });
  },
  'POST /v1/call/invite': async (req, res) => {
    const u = auth(req), mk = lc(u.name);
    if (limited('call|' + mk, 10, 60e3)) throw new HttpErr(429, 'Doucement : trop d\'appels');
    const b = await readJson(req, 2e3), k = lc(String(b.to || '').trim());
    if (!fr(u).f.includes(k)) throw new HttpErr(403, 'Ce joueur n\'est pas dans tes amis');
    callSweep();
    for (const c of calls.values()) {
      if (callOver(c)) continue;
      const who = [lc(c.from), lc(c.to)];
      if (who.includes(mk)) throw new HttpErr(409, 'Tu as déjà un appel en cours');
      if (who.includes(k)) throw new HttpErr(409, dn(k) + ' est déjà en appel');
    }
    const id = crypto.randomBytes(12).toString('hex'), n = Date.now();
    calls.set(id, { id, from: u.name, to: dn(k), state: 'ringing', t: n, seen: { a: n, b: n }, seq: 0, msgs: [] });
    send(res, 201, { call: id, to: dn(k) });
  },
  'GET /v1/call/poll': async (req, res) => {
    const mk = lc(auth(req).name);
    callSweep();
    const c = [...calls.values()].find(x => x.state === 'ringing' && lc(x.to) === mk);
    send(res, 200, { incoming: c ? { call: c.id, from: c.from } : null });
  },
  'POST /v1/call/accept': async (req, res) => {
    const u = auth(req), c = callFor(u, (await readJson(req, 2e3)).call);
    if (lc(c.to) !== lc(u.name) || c.state !== 'ringing') throw new HttpErr(409, 'Appel terminé');
    c.state = 'live'; c.t = Date.now(); c.seen = { a: c.t, b: c.t };
    send(res, 200, { state: c.state });
  },
  'POST /v1/call/end': async (req, res) => {
    const u = auth(req), c = callFor(u, (await readJson(req, 2e3)).call);
    if (!callOver(c)) callEnd(c, c.state === 'ringing' && lc(c.to) === lc(u.name) ? 'declined' : 'ended');
    send(res, 200, { state: c.state });
  },
  'POST /v1/call/signal': async (req, res) => {
    const u = auth(req), b = await readJson(req, 60e3), c = callFor(u, b.call);
    if (c.state !== 'live') throw new HttpErr(409, 'Appel terminé');
    if (!['offer', 'answer', 'ice'].includes(b.kind) || typeof b.data !== 'string' || b.data.length > 40000) throw new HttpErr(400, 'Signal invalide');
    if (c.msgs.length >= 200) throw new HttpErr(429, 'Trop de signaux');
    c.msgs.push({ id: ++c.seq, from: lc(u.name), kind: b.kind, data: b.data });
    send(res, 201, { id: c.seq });
  },
  'GET /v1/call/signal': async (req, res, url) => {
    const u = auth(req), c = callFor(u, url.searchParams.get('call')), after = +url.searchParams.get('after') || 0;
    send(res, 200, { state: c.state, msgs: c.msgs.filter(m => m.id > after && m.from !== lc(u.name)).map(m => ({ id: m.id, kind: m.kind, data: m.data })) });
  },
  // v5.31 : essai gratuit de 7 jours des thèmes payants, lié à l'APPAREIL (survit à l'effacement des données de l'appli)
  'POST /v1/trials/sync': async (req, res) => {
    if (limited('trial|' + ipOf(req), 60, 600e3)) throw new HttpErr(429, 'Trop d\'essais');
    const b = await readJson(req, 2e3), dev = String(b.device || '');
    if (!/^[0-9a-f]{64}$/.test(dev)) throw new HttpErr(400, 'Appareil invalide');
    const rec = db.trials[dev] || (db.trials[dev] = {}), now = Date.now();
    const th = Number.isInteger(b.start) ? b.start : -1;
    if (th >= 1 && th <= 5 && !rec[th]) { rec[th] = now; save('trials'); }   // le serveur fixe la date : l'horloge du téléphone n'est pas crue
    send(res, 200, { now, trials: rec });
  },
  'POST /v1/register': async (req, res) => {
    if (limited('reg|' + ipOf(req), 10, 3600e3)) throw new HttpErr(429, 'Trop de créations de compte, réessaie plus tard');
    const b = await readJson(req, 200e3);   // v5.44 : la demande peut contenir la photo de profil réduite
    const name = str(b.username, 3, 20), pass = typeof b.password === 'string' ? b.password : '';
    const q = str(b.question, 3, 120), a = str(b.answer, 2, 120);
    if (!name || !USER_RE.test(name)) throw new HttpErr(400, 'Nom d\'utilisateur : 3 à 20 caractères (lettres, chiffres, _ . -)');
    if (pass.length < 6 || pass.length > 200) throw new HttpErr(400, 'Mot de passe : 6 caractères minimum');
    if (!q || !a) throw new HttpErr(400, 'Question et réponse secrètes obligatoires');
    if (db.users[name.toLowerCase()]) throw new HttpErr(409, 'Ce nom d\'utilisateur est déjà pris');
    const rec = db.users[name.toLowerCase()] = { name, pw: hashSecret(pass), question: q, ans: hashSecret(normAnswer(a)), created: Date.now(), banned: false };
    if (b.avatar) { try { setAvatar(rec, b.avatar); } catch (e) { rec.avatar = ''; } }   // une photo invalide ne bloque pas la création du compte
    save('users');
    send(res, 201, { token: newSession(name), username: name, avatar: avatarUrl(rec) });
  },
  'POST /v1/login': async (req, res) => {
    const b = await readJson(req, 20e3), key = String(b.username || '').toLowerCase();
    if (limited('log|' + ipOf(req), 30, 600e3) || limited('logu|' + key, 10, 600e3)) throw new HttpErr(429, 'Trop d\'essais, réessaie dans quelques minutes');
    const u = db.users[key];
    const ok = u && typeof b.password === 'string' && checkSecret(b.password, u.pw);
    if (!ok) throw new HttpErr(401, 'Nom d\'utilisateur ou mot de passe incorrect');
    if (u.banned) throw new HttpErr(403, 'Compte suspendu');
    send(res, 200, { token: newSession(u.name), username: u.name, avatar: avatarUrl(u) });
  },
  'POST /v1/logout': async (req, res) => {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (m) { delete db.sessions[sha(m[1])]; save('sessions'); }
    send(res, 200, { ok: true });
  },
  'GET /v1/me': async (req, res) => send(res, 200, pub(auth(req))),
  // v5.44 : changer / retirer la photo de profil (image = data URL JPEG/PNG réduit ; image absente ou vide = retirer)
  'POST /v1/me/avatar': async (req, res) => {
    const u = auth(req);
    if (limited('av|' + u.name.toLowerCase(), 30, 3600e3)) throw new HttpErr(429, 'Trop de changements de photo, réessaie plus tard');
    const b = await readJson(req, 200e3);
    setAvatar(u, b.image || '');
    send(res, 200, { avatar: avatarUrl(u) });
  },
  // mot de passe oublié : 1) la question  2) la réponse + nouveau mot de passe
  'POST /v1/recover/question': async (req, res) => {
    if (limited('rq|' + ipOf(req), 20, 3600e3)) throw new HttpErr(429, 'Trop d\'essais');
    const b = await readJson(req, 5e3), key = String(b.username || '').toLowerCase(), u = db.users[key];
    send(res, 200, { question: u && !u.banned ? u.question : fakeQuestion(key) });   // même forme de réponse si le compte n'existe pas
  },
  'POST /v1/recover/reset': async (req, res) => {
    const b = await readJson(req, 10e3), key = String(b.username || '').toLowerCase();
    if (limited('rr|' + ipOf(req), 10, 3600e3) || limited('rru|' + key, 5, 3600e3)) throw new HttpErr(429, 'Trop d\'essais, réessaie dans une heure');
    const u = db.users[key], np = typeof b.newPassword === 'string' ? b.newPassword : '';
    if (np.length < 6 || np.length > 200) throw new HttpErr(400, 'Nouveau mot de passe : 6 caractères minimum');
    if (!u || u.banned || typeof b.answer !== 'string' || !checkSecret(normAnswer(b.answer), u.ans)) throw new HttpErr(401, 'Réponse incorrecte');
    u.pw = hashSecret(np);
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].user.toLowerCase() === key) delete db.sessions[k];
    save('users', 'sessions');
    send(res, 200, { token: newSession(u.name), username: u.name, avatar: avatarUrl(u) });
  },

  // chat
  'GET /v1/chat': async (req, res, url) => {
    auth(req);
    const after = +url.searchParams.get('after') || 0;
    let l = db.messages.filter(m => m.id > after);
    if (!after) l = l.slice(-100);
    send(res, 200, { messages: l.slice(0, 200) });
  },
  'POST /v1/chat': async (req, res) => {
    const u = auth(req);
    if (limited('chat|' + u.name, 20, 60e3)) throw new HttpErr(429, 'Doucement : trop de messages');
    const b = await readJson(req, 5 * 1024 * 1024);
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : '';
    const image = b.image ? saveImage(b.image) : null, audio = b.audio ? saveAudio(b.audio) : null;
    if (!text && !image && !audio) throw new HttpErr(400, 'Message vide');
    const m = { id: ++db.seq.msg, user: u.name, text, image, ts: Date.now() };
    if (audio) { m.audio = audio; m.dur = durOf(b.dur); }
    db.messages.push(m);
    if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
    save('messages', 'seq');
    send(res, 201, m);
  },

  // ---- v5.23 : amis, messages privés, groupes ----
  'GET /v1/friends': async (req, res) => {
    const u = auth(req), me = fr(u);
    send(res, 200, { friends: me.f.map(dn), incoming: me.in.map(dn), outgoing: me.out.map(dn) });
  },
  // v5.78 : boite de reception legere pour les bannieres de l'appli : nouveaux messages prives / de groupe + demandes d'amis recues.
  // dm / gm = dernier id deja vu par l'appli ; absent ou negatif = premiere fois : on ne renvoie que les derniers id (aucun ancien message).
  'GET /v1/inbox': async (req, res, url) => {
    const u = auth(req), mk = lc(u.name), me = fr(u);
    const last = n => { const v = url.searchParams.get(n); return v !== null && v !== '' && +v >= 0 ? +v : -1 };
    const adm = last('dm'), agm = last('gm');
    const brief = m => ({ text: String(m.text || '').slice(0, 120), image: !!m.image, audio: !!m.audio });
    const dm = adm < 0 ? [] : db.dms.filter(m => m.id > adm && m.to === mk && m.from !== mk).slice(0, 20)
      .map(m => Object.assign({ id: m.id, user: dn(m.from) }, brief(m)));
    const gm = agm < 0 ? [] : db.gmsgs.filter(m => m.id > agm && lc(m.user) !== mk && db.groups[m.g] && db.groups[m.g].members.includes(mk)).slice(0, 20)
      .map(m => Object.assign({ id: m.id, user: m.user, group: db.groups[m.g].name }, brief(m)));
    send(res, 200, { dm, gm, dmMax: db.seq.dm || 0, gmMax: db.seq.gmsg || 0, incoming: me.in.map(dn) });
  },
  // v5.79 : profil d'un joueur. Toi et tes amis : infos completes (prenom, nom, anciennete, nombre d'amis, jeux possedes) ; les autres : pseudo, photo, anciennete seulement.
  'GET /v1/profile': async (req, res, url) => {
    const u = auth(req), mk = lc(u.name), k = lc(url.searchParams.get('name'));
    if (limited('prf|' + mk, 120, 60e3)) throw new HttpErr(429, 'Doucement');
    const t = Object.prototype.hasOwnProperty.call(db.users, k) ? db.users[k] : null;
    if (!t || (t.banned && k !== mk)) throw new HttpErr(404, 'Joueur introuvable');
    const me = fr(u), rel = k === mk ? 'me' : me.f.includes(k) ? 'friend' : me.in.includes(k) ? 'incoming' : me.out.includes(k) ? 'outgoing' : 'none';
    const out = { name: t.name, avatar: avatarUrl(t), created: t.created || 0, rel };
    if (rel === 'me' || rel === 'friend') {
      const seen = new Set(), games = [];
      for (const g of [].concat(db.ugames[k] || [], db.gunlocks[k] || [])) {
        const n = String(g || '').replace(/#\d+$/, '').trim(), key = n.toLowerCase();
        if (n && !seen.has(key)) { seen.add(key); games.push(n); }
      }
      games.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
      Object.assign(out, { first: t.first || '', last: t.last || '', friends: frk(k).f.length, games });
    }
    send(res, 200, out);
  },
  // v5.79 : prenom / nom affiches sur le profil (modifiables dans Mon compte)
  'POST /v1/me/profile': async (req, res) => {
    const u = auth(req);
    if (limited('mp|' + lc(u.name), 30, 3600e3)) throw new HttpErr(429, 'Trop de changements, reessaie plus tard');
    const b = await readJson(req, 2e3), clean = v => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
    u.first = clean(b.first); u.last = clean(b.last);
    save('users');
    send(res, 200, { first: u.first, last: u.last });
  },
  // v5.79 : l'appli envoie la liste (noms) des jeux que le joueur possede (jeux obtenus + Mes comptes) ; ses amis la voient sur son profil
  'POST /v1/me/games': async (req, res) => {
    const u = auth(req), k = lc(u.name);
    if (limited('mg|' + k, 60, 3600e3)) throw new HttpErr(429, 'Trop de mises a jour, reessaie plus tard');
    const b = await readJson(req, 60e3);
    if (!Array.isArray(b.games)) throw new HttpErr(400, 'Liste de jeux invalide');
    const seen = new Set(), out = [];
    for (const g of b.games.slice(0, 400)) {
      const n = String(g || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80), key = n.toLowerCase();
      if (n && !seen.has(key)) { seen.add(key); out.push(n); }
    }
    db.ugames[k] = out; save('ugames');
    send(res, 200, { count: out.length });
  },
  // demande d'ami (si l'autre t'avait déjà demandé : vous devenez amis directement)
  'POST /v1/friends/request': async (req, res) => {
    const u = auth(req);
    if (limited('frq|' + u.name, 20, 60e3)) throw new HttpErr(429, 'Doucement : trop de demandes');
    const b = await readJson(req, 2e3), k = String(b.name || '').trim().toLowerCase(), t = db.users[k];
    if (!t) throw new HttpErr(404, 'Aucun joueur de ce nom');
    const mk = u.name.toLowerCase();
    if (k === mk) throw new HttpErr(400, 'Tu ne peux pas t\'ajouter toi-même');
    const me = fr(u), ot = fr(t);
    if (me.f.includes(k)) return send(res, 200, { status: 'friends', name: t.name });
    if (me.in.includes(k)) { becomeFriends(mk, k); save('friends'); return send(res, 200, { status: 'friends', name: t.name }); }
    if (!me.out.includes(k)) { me.out.push(k); ot.in.push(mk); save('friends'); }
    send(res, 200, { status: 'pending', name: t.name });
  },
  'POST /v1/friends/accept': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), k = String(b.name || '').trim().toLowerCase(), mk = u.name.toLowerCase();
    if (!fr(u).in.includes(k)) throw new HttpErr(404, 'Aucune demande de ce joueur');
    becomeFriends(mk, k); save('friends');
    send(res, 200, { status: 'friends', name: dn(k) });
  },
  // refuse une demande, annule la tienne ou retire un ami
  'POST /v1/friends/remove': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), k = String(b.name || '').trim().toLowerCase(), mk = u.name.toLowerCase();
    const me = fr(u), ot = frk(k), del = (l, x) => { const i = l.indexOf(x); if (i >= 0) l.splice(i, 1) };
    del(me.f, k); del(me.in, k); del(me.out, k); del(ot.f, mk); del(ot.in, mk); del(ot.out, mk);
    save('friends'); send(res, 200, { ok: true });
  },
  // v5.24 : recherche de joueurs par morceau de pseudo (2 lettres min.) + lien avec toi : friend / incoming / outgoing / none
  'GET /v1/users': async (req, res, url) => {
    const u = auth(req), q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 20), mk = u.name.toLowerCase();
    if (q.length < 2) throw new HttpErr(400, 'Écris au moins 2 lettres');
    if (limited('usr|' + u.name, 40, 60e3)) throw new HttpErr(429, 'Doucement : trop de recherches');
    const me = fr(u), out = [];
    for (const k of Object.keys(db.users)) {
      if (k === mk || db.users[k].banned || !k.includes(q)) continue;
      out.push({ name: db.users[k].name, rel: me.f.includes(k) ? 'friend' : me.in.includes(k) ? 'incoming' : me.out.includes(k) ? 'outgoing' : 'none', s: k.startsWith(q) ? 0 : 1 });
    }
    out.sort((a, b) => a.s - b.s || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    send(res, 200, { users: out.slice(0, 20).map(x => ({ name: x.name, rel: x.rel })) });
  },
  'GET /v1/dm': async (req, res, url) => {
    const u = auth(req), mk = u.name.toLowerCase(), k = String(url.searchParams.get('with') || '').toLowerCase(), after = +url.searchParams.get('after') || 0;
    if (!fr(u).f.includes(k)) throw new HttpErr(403, 'Ce joueur n\'est pas dans tes amis');
    let l = db.dms.filter(m => m.id > after && ((m.from === mk && m.to === k) || (m.from === k && m.to === mk)));
    if (!after) l = l.slice(-100);
    send(res, 200, { messages: l.slice(0, 200).map(m => ({ id: m.id, user: dn(m.from), text: m.text, image: m.image, audio: m.audio, dur: m.dur, ts: m.ts })) });
  },
  'POST /v1/dm': async (req, res) => {
    const u = auth(req), mk = u.name.toLowerCase();
    if (limited('dm|' + u.name, 30, 60e3)) throw new HttpErr(429, 'Doucement : trop de messages');
    const b = await readJson(req, 5 * 1024 * 1024), k = String(b.to || '').toLowerCase();
    if (!fr(u).f.includes(k)) throw new HttpErr(403, 'Ce joueur n\'est pas dans tes amis');
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : '', image = b.image ? saveImage(b.image) : null, audio = b.audio ? saveAudio(b.audio) : null;
    if (!text && !image && !audio) throw new HttpErr(400, 'Message vide');
    const m = { id: ++db.seq.dm, from: mk, to: k, text, image, ts: Date.now() };
    if (audio) { m.audio = audio; m.dur = durOf(b.dur); }
    db.dms.push(m);
    if (db.dms.length > 5000) db.dms.splice(0, db.dms.length - 5000);
    save('dms', 'seq');
    send(res, 201, { id: m.id, user: u.name, text, image, audio: m.audio, dur: m.dur, ts: m.ts });
  },
  'GET /v1/groups': async (req, res) => {
    const u = auth(req), mk = u.name.toLowerCase();
    send(res, 200, { groups: Object.values(db.groups).filter(g => g.members.includes(mk)).map(gpub) });
  },
  // crée un groupe : { name, members: [amis] }
  'POST /v1/groups': async (req, res) => {
    const u = auth(req), mk = u.name.toLowerCase(), me = fr(u);
    if (limited('grp|' + u.name, 10, 600e3)) throw new HttpErr(429, 'Trop de groupes créés');
    const b = await readJson(req, 5e3), name = String(b.name || '').trim().slice(0, 30);
    if (name.length < 2) throw new HttpErr(400, 'Donne un nom au groupe (2 caractères min.)');
    const list = Array.isArray(b.members) ? b.members.map(x => String(x).toLowerCase()) : [];
    const mem = [mk];
    list.forEach(k => { if (!mem.includes(k)) { if (!me.f.includes(k)) throw new HttpErr(403, (dn(k) || k) + ' n\'est pas dans tes amis'); mem.push(k) } });
    if (mem.length > 20) throw new HttpErr(400, '20 membres maximum');
    const g = { id: ++db.seq.grp, name, owner: mk, members: mem, created: Date.now() };
    db.groups[g.id] = g; save('groups', 'seq');
    send(res, 201, gpub(g));
  },
  'POST /v1/groups/add': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), g = db.groups[+b.id], k = String(b.name || '').toLowerCase();
    if (!g || !g.members.includes(u.name.toLowerCase())) throw new HttpErr(404, 'Groupe introuvable');
    if (!fr(u).f.includes(k)) throw new HttpErr(403, 'Ce joueur n\'est pas dans tes amis');
    if (!g.members.includes(k)) { if (g.members.length >= 20) throw new HttpErr(400, '20 membres maximum'); g.members.push(k); save('groups') }
    send(res, 200, gpub(g));
  },
  'POST /v1/groups/leave': async (req, res) => {
    const u = auth(req), mk = u.name.toLowerCase(), b = await readJson(req, 2e3), g = db.groups[+b.id];
    if (!g || !g.members.includes(mk)) throw new HttpErr(404, 'Groupe introuvable');
    g.members = g.members.filter(x => x !== mk);
    if (!g.members.length) { delete db.groups[g.id]; db.gmsgs = db.gmsgs.filter(m => m.g !== g.id); save('groups', 'gmsgs'); }
    else { if (g.owner === mk) g.owner = g.members[0]; save('groups'); }
    send(res, 200, { ok: true });
  },
  'GET /v1/group': async (req, res, url) => {
    const u = auth(req), g = db.groups[+url.searchParams.get('id')], after = +url.searchParams.get('after') || 0;
    if (!g || !g.members.includes(u.name.toLowerCase())) throw new HttpErr(404, 'Groupe introuvable');
    let l = db.gmsgs.filter(m => m.g === g.id && m.id > after);
    if (!after) l = l.slice(-100);
    send(res, 200, { group: gpub(g), messages: l.slice(0, 200).map(m => ({ id: m.id, user: m.user, text: m.text, image: m.image, audio: m.audio, dur: m.dur, ts: m.ts })) });
  },
  'POST /v1/group': async (req, res) => {
    const u = auth(req);
    if (limited('gm|' + u.name, 30, 60e3)) throw new HttpErr(429, 'Doucement : trop de messages');
    const b = await readJson(req, 5 * 1024 * 1024), g = db.groups[+b.id];
    if (!g || !g.members.includes(u.name.toLowerCase())) throw new HttpErr(404, 'Groupe introuvable');
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : '', image = b.image ? saveImage(b.image) : null, audio = b.audio ? saveAudio(b.audio) : null;
    if (!text && !image && !audio) throw new HttpErr(400, 'Message vide');
    const m = { id: ++db.seq.gmsg, g: g.id, user: u.name, text, image, ts: Date.now() };
    if (audio) { m.audio = audio; m.dur = durOf(b.dur); }
    db.gmsgs.push(m);
    if (db.gmsgs.length > 5000) db.gmsgs.splice(0, db.gmsgs.length - 5000);
    save('gmsgs', 'seq');
    send(res, 201, { id: m.id, user: u.name, text, image, audio: m.audio, dur: m.dur, ts: m.ts });
  },

  // notifications (promos, codes) : visibles par tous, par un pseudo précis, ou par un thème précis

  // ---- v5.25 : comptes Steam et coffre
  'GET /v1/steam': async (req, res) => {
    const me = auth(req).name.toLowerCase();
    send(res, 200, { accounts: db.steam[me] || [], vault: db.vaults[me] ? { has: true, ts: db.vaults[me].ts } : { has: false } });
  },
  'POST /v1/steam': async (req, res) => {
    const me = auth(req).name.toLowerCase(), b = await readJson(req, 20e3);
    if (!Array.isArray(b.accounts) || b.accounts.length > 5) throw new HttpErr(400, '5 comptes Steam maximum');
    const out = b.accounts.map(a => {
      const label = cleanLabel(a && a.label), sid = steamIdOf(a && a.steamId);
      if (!label) throw new HttpErr(400, 'Donne un nom à chaque compte');
      if (!sid) throw new HttpErr(400, 'Identifiant Steam invalide (SteamID64, nom de profil ou lien steamcommunity.com)');
      return { id: /^[0-9a-f]{8}$/.test(String(a.id)) ? a.id : crypto.randomBytes(4).toString('hex'), label, steamId: sid, shared: a.shared === true };
    });
    db.steam[me] = out; save('steam');
    send(res, 200, { accounts: out });
  },
  'GET /v1/steam/friend': async (req, res, url) => {   // comptes que l'ami a choisi de partager
    const u = auth(req), o = String(url.searchParams.get('username') || '').trim().toLowerCase();
    if (!db.users[o]) throw new HttpErr(404, 'Utilisateur introuvable');
    if (!fr(u).f.includes(o)) throw new HttpErr(403, 'Réservé à tes amis');
    send(res, 200, { username: db.users[o].name, accounts: (db.steam[o] || []).filter(a => a.shared).map(a => ({ label: a.label, steamId: a.steamId })) });
  },
  'GET /v1/vault': async (req, res) => {
    const v = db.vaults[auth(req).name.toLowerCase()];
    if (!v) throw new HttpErr(404, 'Aucun coffre');
    send(res, 200, v);
  },
  'POST /v1/vault': async (req, res) => {   // l'appli envoie le coffre DÉJÀ chiffré ; le serveur ne le déchiffre jamais
    const me = auth(req).name.toLowerCase();
    if (limited('vault|' + me, 30, 3600e3)) throw new HttpErr(429, 'Trop de sauvegardes, réessaie plus tard');
    const b = await readJson(req, 200e3);
    if (typeof b.blob !== 'string' || !b.blob.length || b.blob.length > 131072) throw new HttpErr(400, 'Coffre invalide (128 Ko max)');
    db.vaults[me] = { blob: b.blob, ts: Date.now() }; save('vaults');
    send(res, 200, { ts: db.vaults[me].ts });
  },
  'POST /v1/vault/delete': async (req, res) => {
    const me = auth(req).name.toLowerCase();
    delete db.vaults[me]; save('vaults');
    send(res, 200, { ok: true });
  },

  // ---- v5.35 : achats (code PIN / thème). Le client envoie sa preuve MoMo ; l'administrateur l'accepte depuis /admin.
  'POST /v1/purchases': async (req, res) => {
    const u = auth(req);
    if (limited('buy|' + u.name.toLowerCase(), 12, 3600e3)) throw new HttpErr(429, 'Trop de demandes, réessaie plus tard');
    const b = await readJson(req, 5 * 1024 * 1024);   // v5.39 : la demande peut contenir la photo de la transaction (data URL JPEG/PNG, 3 Mo max une fois décodée)
    const kind = b.kind === 'game' ? 'game' : b.kind === 'pin' ? 'pin' : b.kind === 'theme' ? 'theme' : null;   // v5.36 : « game » = bouton Obtenir (plus de PIN) ; « pin » gardé seulement pour les anciennes versions de l'appli
    const item = str(b.item, 1, 120), txIn = str(b.tx, 4, 60);
    if (!kind) throw new HttpErr(400, 'Type d\'achat invalide');
    if (!item) throw new HttpErr(400, 'Article manquant');
    // v5.39 : preuve = photo de la transaction (prise ou importée). L'identifiant écrit reste accepté pour les anciennes versions de l'appli.
    if (!b.image && !txIn) throw new HttpErr(400, 'Photo de la transaction manquante');
    let theme = null;
    if (kind === 'theme') {
      theme = Number.isInteger(b.theme) ? b.theme : THEME_NAMES.findIndex(n => n.toLowerCase() === item.toLowerCase());
      if (!(theme >= 1 && theme <= 5)) throw new HttpErr(400, 'Thème invalide');
    }
    const clean = x => x.replace(/[\u0000-\u001f<>]/g, '');
    // v5.37 : un jeu peut avoir plusieurs comptes dans le coffre (« Compte 1 », « Compte 2 »...) : acc = numéro du compte (1-99), comme sur le site Coffre Steam
    const acc = kind === 'game' && Number.isInteger(b.acc) && b.acc >= 1 && b.acc <= 99 ? b.acc : null;
    if (kind === 'game') {   // jeu (ou compte du jeu) déjà débloqué : rien à faire
      const have = db.gunlocks[u.name.toLowerCase()] || [], key = gameKey(clean(item), acc).toLowerCase();
      if (have.some(g => g.toLowerCase() === key || g.toLowerCase() === clean(item).toLowerCase())) return send(res, 200, { status: 'accepted', already: true });
    }
    const tx = txIn ? clean(txIn) : '';
    const dup = !b.image && db.purchases.find(p => p.user.toLowerCase() === u.name.toLowerCase() && p.kind === kind && p.item === clean(item) && (p.acc || null) === acc && (p.tx || '').toLowerCase() === tx.toLowerCase() && p.status === 'pending');
    if (dup) return send(res, 200, { id: dup.id, status: dup.status });
    const image = b.image ? saveImage(b.image) : null;   // v5.39 : photo enregistrée comme les images du chat (/uploads/...), affichée dans /admin
    const note = typeof b.note === 'string' ? clean(b.note).slice(0, 200) : '';
    const p = { id: ++db.seq.purchase, user: u.name, kind, item: clean(item), acc, theme, tx, image, note, status: 'pending', ts: Date.now() };
    db.purchases.push(p);
    if (db.purchases.length > 2000) db.purchases.splice(0, db.purchases.length - 2000);
    save('purchases', 'seq');
    send(res, 201, { id: p.id, status: p.status });
  },
  'GET /v1/purchases/mine': async (req, res) => {   // mes achats + thèmes débloqués (l'appli s'en sert pour restaurer les thèmes après une réinstallation)
    const u = auth(req), k = u.name.toLowerCase();
    send(res, 200, {
      themes: db.unlocks[k] || [],
      games: db.gunlocks[k] || [],   // v5.36 : jeux débloqués (l'appli les restaure après réinstallation)
      purchases: db.purchases.filter(p => p.user.toLowerCase() === k).slice(-30).map(p => ({ id: p.id, kind: p.kind, item: p.item, acc: p.acc || null, status: p.status, ts: p.ts }))
    });
  },

  // ---- v5.56 : partage de partie (l'hote invite un ami ; l'ami voit la partie et joue avec sa manette / ses touches)
  'POST /v1/share/invite': async (req, res) => {
    const u = auth(req);
    if (limited('shi|' + lc(u.name), 20, 600e3)) throw new HttpErr(429, 'Trop d\'invitations, réessaie dans quelques minutes');
    const b = await readJson(req, 4e3), k = lc(b.to), t = db.users[k];
    if (!t || t.banned) throw new HttpErr(404, 'Ami introuvable');
    if (!frk(lc(u.name)).f.includes(k)) throw new HttpErr(403, 'Tu ne peux inviter que tes amis');
    for (const [id, r] of rooms) if (lc(r.host) === lc(u.name) && r.state !== 'ended' && r.state !== 'declined') { r.state = 'ended'; r.t = Date.now(); }   // une seule partie partagee a la fois
    const game = typeof b.game === 'string' ? b.game.replace(/[\u0000-\u001f<>]/g, '').slice(0, 80) : '';
    const r = { id: crypto.randomBytes(8).toString('hex'), host: u.name, guest: t.name, game, state: 'invited', t: Date.now(), seq: 0, msgs: [] };
    rooms.set(r.id, r);
    db.notifs.push({ id: ++db.seq.notif, kind: 'share', title: '🎮 ' + u.name + ' t\'invite à jouer', body: 'Ouvre G-Ondzet Now pour voir sa partie GeForce NOW' + (game ? ' (' + game + ')' : '') + ' et jouer avec lui.', code: '', to: t.name, theme: '', ts: Date.now() });
    if (db.notifs.length > 3000) db.notifs.splice(0, db.notifs.length - 3000);
    save('notifs', 'seq');
    send(res, 201, { room: r.id, state: r.state, guest: t.name });
  },
  'GET /v1/share/poll': async (req, res) => {
    const u = auth(req), me = lc(u.name), invites = [], mine = [];
    for (const r of rooms.values()) {
      if (r.state === 'invited' && lc(r.guest) === me) invites.push({ room: r.id, host: r.host, game: r.game, ts: r.t });
      if (lc(r.host) === me || lc(r.guest) === me) mine.push({ room: r.id, role: lc(r.host) === me ? 'host' : 'guest', host: r.host, guest: r.guest, state: r.state });
    }
    send(res, 200, { invites, rooms: mine });
  },
  'GET /v1/share/room': async (req, res, url) => {
    const r = roomFor(auth(req), url.searchParams.get('id'));
    send(res, 200, { room: r.id, host: r.host, guest: r.guest, game: r.game, state: r.state });
  },
  'POST /v1/share/accept': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), r = roomFor(u, b.room);
    if (lc(r.guest) !== lc(u.name) || r.state !== 'invited') throw new HttpErr(409, 'Invitation expirée');
    r.state = 'live'; r.t = Date.now();
    send(res, 200, { room: r.id, host: r.host, game: r.game, state: r.state });
  },
  'POST /v1/share/decline': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), r = roomFor(u, b.room);
    if (lc(r.guest) === lc(u.name) && r.state === 'invited') { r.state = 'declined'; r.t = Date.now(); }
    send(res, 200, { state: r.state });
  },
  'POST /v1/share/end': async (req, res) => {
    const u = auth(req), b = await readJson(req, 2e3), r = roomFor(u, b.room);
    if (r.state !== 'ended' && r.state !== 'declined') { r.state = 'ended'; r.t = Date.now(); }
    send(res, 200, { state: r.state });
  },
  // signalisation WebRTC : offre / reponse / candidats ICE, dans les deux sens
  'POST /v1/share/signal': async (req, res) => {
    const u = auth(req), b = await readJson(req, 40e3), r = roomFor(u, b.room);
    if (r.state !== 'live' && r.state !== 'invited') throw new HttpErr(409, 'Partie terminée');
    const kind = ['offer', 'answer', 'ice', 'bye'].includes(b.kind) ? b.kind : null;
    if (!kind || typeof b.data !== 'string' || b.data.length > 30000) throw new HttpErr(400, 'Signal invalide');
    if (r.msgs.length > 400) r.msgs.splice(0, r.msgs.length - 400);
    r.msgs.push({ id: ++r.seq, to: lc(r.host) === lc(u.name) ? lc(r.guest) : lc(r.host), kind, data: b.data });
    send(res, 201, { id: r.seq });
  },
  'GET /v1/share/signal': async (req, res, url) => {
    const u = auth(req), r = roomFor(u, url.searchParams.get('room')), after = +url.searchParams.get('after') || 0;
    send(res, 200, { state: r.state, msgs: r.msgs.filter(m => m.id > after && m.to === lc(u.name)).map(m => ({ id: m.id, kind: m.kind, data: m.data })) });
  },

  'GET /v1/notifications': async (req, res, url) => {
    const u = auth(req), after = +url.searchParams.get('after') || 0, th = url.searchParams.get('theme');
    const l = db.notifs.filter(n => n.id > after && (!n.to || n.to.toLowerCase() === u.name.toLowerCase())
      && (n.theme == null || th == null || String(n.theme) === th)).slice(-50);   // v5.35 : sans ?theme= on renvoie tout (l'appli filtre) ; avant, un message vise sur un theme n'arrivait jamais
    send(res, 200, { notifications: l });
  },

  // administrateur
  'POST /v1/admin/notify': async (req, res) => {
    admin(req);
    const b = await readJson(req, 20e3);
    if (b.kind === 'game') {   // v5.47 : « Code de jeu » = le client OBTIENT le jeu tout de suite (meme mecanisme qu'un achat accepte : notification « unlock » appliquee par l'appli)
      const game = str(b.game, 1, 120), toName = String(b.to || '').trim();
      if (!game) throw new HttpErr(400, 'Choisis un jeu dans la liste');
      if (!toName) throw new HttpErr(400, 'Indique le pseudo du client qui reçoit le jeu');
      const user = db.users[toName.toLowerCase()];
      if (!user) throw new HttpErr(404, 'Utilisateur introuvable : ' + toName);
      const accN = +b.acc, acc = Number.isInteger(accN) && accN >= 1 && accN <= 99 ? accN : null;
      const name = game.replace(/[\u0000-\u001f<>]/g, ''), k = user.name.toLowerCase(), l = db.gunlocks[k] || (db.gunlocks[k] = []), gk = gameKey(name, acc);
      if (!l.some(g => g.toLowerCase() === gk.toLowerCase())) l.push(gk);
      const note = typeof b.body === 'string' ? b.body.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300) : '';
      const n = { id: ++db.seq.notif, kind: 'unlock', title: 'Jeu offert : ' + name + (acc ? ' — Compte ' + acc : ''), body: note || 'Ton jeu est débloqué : va dans Compte Jeux et touche « Ajouter ».', code: null, to: user.name, theme: null, ts: Date.now(), unlockGame: name, unlockAcc: acc };
      db.notifs.push(n); save('notifs', 'gunlocks', 'seq');
      return send(res, 201, n);
    }
    const kind = b.kind === 'code' ? 'code' : 'promo', title = str(b.title, 1, 80), body = typeof b.body === 'string' ? b.body.trim().slice(0, 600) : '';
    const code = kind === 'code' ? str(b.code, 1, 200) : null;
    if (!title) throw new HttpErr(400, 'Titre obligatoire');
    if (kind === 'code' && !code) throw new HttpErr(400, 'Le code est obligatoire');
    let to = null;
    if (b.to && String(b.to).trim()) { to = String(b.to).trim(); if (!db.users[to.toLowerCase()]) throw new HttpErr(404, 'Utilisateur introuvable : ' + to); to = db.users[to.toLowerCase()].name; }
    const theme = b.theme === '' || b.theme == null ? null : +b.theme;
    if (theme != null && !(theme >= 0 && theme <= 5)) throw new HttpErr(400, 'Thème invalide');
    const n = { id: ++db.seq.notif, kind, title, body, code, to, theme, ts: Date.now() };
    db.notifs.push(n); save('notifs', 'seq');
    send(res, 201, n);
  },
  // v5.46 : appli G-Ondzet Admin. Requete « longue » : le serveur la garde ouverte (25 s max) et repond des qu'un evenement arrive.
  // after=0 (ou absent) : ne renvoie que le curseur « now » (l'appli ne rejoue pas l'ancien historique).
  'GET /v1/admin/events': async (req, res, url) => {
    admin(req);
    const pending = () => db.purchases.filter(p => p.status === 'pending').length;
    const after = +url.searchParams.get('after') || 0, wait = Math.min(25, Math.max(0, +url.searchParams.get('wait') || 0)), t0 = Date.now();
    if (after <= 0) return send(res, 200, { events: [], now: Date.now(), pending: pending() });
    let ev, now;
    for (;;) {
      now = Date.now(); ev = adminEvents(after, now);
      if (ev.length || now - t0 >= wait * 1000 || req.destroyed) break;
      await sleep(1000);
    }
    send(res, 200, { events: ev, now, pending: pending() });
  },
  // v5.47 / v5.62 : liens de telechargement de l'application. Source de verite = ce serveur (publie sur /public/versions.json) ; au premier acces ils sont repris de versions.json du site.
  'GET /v1/admin/downloads': async (req, res) => {
    admin(req);
    send(res, 200, Object.assign({ site: SITE_URL }, dlOut(await dlData())));
  },
  // ajoute une version OU remplace le lien d'une version existante, pour une plateforme (android, ios, windows, macos, linux...)
  'POST /v1/admin/downloads/link': async (req, res) => {
    admin(req);
    const b = await readJson(req, 20e3), d = await dlData();
    const pf = String(b.platform || '').toLowerCase().trim();
    if (!PF_RE.test(pf)) throw new HttpErr(400, 'Plateforme invalide (2 à 20 lettres minuscules, chiffres, - ou _)');
    const url = httpsUrl(b.url);
    if (!url) throw new HttpErr(400, 'Lien invalide : une adresse https://… est obligatoire');
    let sha = null;
    if (b.sha256 !== undefined) { sha = String(b.sha256 || '').trim().toLowerCase(); if (sha && !/^[0-9a-f]{64}$/.test(sha)) throw new HttpErr(400, 'SHA-256 invalide (64 caractères hexadécimaux)'); }
    const app = dlApp(d.data, b.app ? String(b.app) : '');
    const p = app.platforms[pf] || (app.platforms[pf] = { latest: null, versions: [] });
    const version = clip(String(b.version == null ? '' : b.version), 30) || p.latest;
    if (!version) throw new HttpErr(400, 'Indique le numéro de version');
    let v = p.versions.find(x => x.version === version);
    const replaced = !!v;
    if (!v) { v = { version, date: new Date().toISOString().slice(0, 10), notes: '', url: null, sha256: '' }; p.versions.push(v); }
    v.url = url;
    if (b.date !== undefined) v.date = clip(String(b.date || ''), 30);
    if (b.notes !== undefined) v.notes = clip(String(b.notes || ''), 300);
    if (sha !== null) v.sha256 = sha;
    if (b.latest === true || (b.latest !== false && (!replaced || !p.latest))) p.latest = version;
    dlTouch(d);
    send(res, 200, Object.assign({ ok: true, replaced, platform: pf, version, latest: p.latest }, dlOut(d)));
  },
  // retire une version d'une plateforme (sans « version » : retire toute la plateforme)
  'POST /v1/admin/downloads/delete': async (req, res) => {
    admin(req);
    const b = await readJson(req, 5e3), d = await dlData();
    const pf = String(b.platform || '').toLowerCase().trim(), app = dlApp(d.data, b.app ? String(b.app) : ''), p = app.platforms[pf];
    if (!p) throw new HttpErr(404, 'Plateforme introuvable');
    if (b.version === undefined || b.version === null || b.version === '') delete app.platforms[pf];
    else {
      const i = p.versions.findIndex(x => x.version === String(b.version));
      if (i < 0) throw new HttpErr(404, 'Version introuvable');
      p.versions.splice(i, 1);
      if (p.latest === String(b.version)) p.latest = p.versions.length ? p.versions[p.versions.length - 1].version : null;
    }
    dlTouch(d);
    send(res, 200, Object.assign({ ok: true }, dlOut(d)));
  },
  // remplace toute la liste du serveur par celle de versions.json du site
  'POST /v1/admin/downloads/import': async (req, res) => {
    admin(req);
    const data = await dlFromSite();
    db.downloads = { data, ts: Date.now(), src: 'site' }; save('downloads');
    send(res, 200, Object.assign({ site: SITE_URL }, dlOut(db.downloads)));
  },
  // v5.62 : donnees publiques lues par le site (CORS ouvert, aucune information privee)
  'GET /public/versions.json': async (req, res) => { send(res, 200, (await dlData()).data, PUB_HEADERS); },
  'GET /public/coffre.json': async (req, res) => {
    if (!db.coffrepub.on || !vaultOk(db.coffrepub.vault)) throw new HttpErr(404, 'Aucun coffre publié');
    send(res, 200, vaultClean(db.coffrepub.vault), PUB_HEADERS);
  },
  // v5.47 : coffre Steam chiffre. Le serveur ne voit jamais la phrase secrete : le navigateur dechiffre / rechiffre.
  'GET /v1/admin/coffre': async (req, res) => {
    admin(req);
    if (!db.coffre || !db.coffre.vault) { try { setCoffre(await vaultFromSite(), 'site'); } catch (e) { /* pas de coffre sur le site : l'admin pourra l'importer a la main */ } }
    send(res, 200, coffreOut());
  },
  'POST /v1/admin/coffre': async (req, res) => {
    admin(req);
    const b = await readJson(req, 1.2e6);
    if (!vaultOk(b.vault)) throw new HttpErr(400, 'Coffre invalide');
    setCoffre(vaultClean(b.vault), 'admin');
    send(res, 200, coffreOut());
  },
  'POST /v1/admin/coffre/import': async (req, res) => {   // remplace le coffre du serveur par celui de la page comptes.html du site
    admin(req);
    setCoffre(await vaultFromSite(), 'site');
    send(res, 200, coffreOut());
  },
  'POST /v1/admin/coffre/undo': async (req, res) => {
    admin(req);
    if (!db.coffre || !db.coffre.prev) throw new HttpErr(404, 'Aucune version précédente');
    const cur = { vault: db.coffre.vault, ts: db.coffre.ts };
    db.coffre = { vault: db.coffre.prev.vault, ts: Date.now(), src: 'undo', prev: cur }; save('coffre');
    if (db.coffrepub.on && db.coffrepub.auto) publishCoffre();
    send(res, 200, coffreOut());
  },
  // v5.62 : publier (ou retirer) la copie chiffree du coffre sur /public/coffre.json ; auto = republier a chaque modification
  'POST /v1/admin/coffre/publish': async (req, res) => {
    admin(req);
    const b = await readJson(req, 2e3);
    if (b.auto !== undefined) db.coffrepub.auto = b.auto === true;
    if (b.on === false) db.coffrepub = { on: false, auto: db.coffrepub.auto, vault: null, ts: 0 };
    else if (b.on === true || b.auto === true) {
      if (!db.coffre || !db.coffre.vault) throw new HttpErr(404, 'Aucun coffre à publier');
      publishCoffre();
    }
    save('coffrepub');
    send(res, 200, coffreOut());
  },
  'GET /v1/admin/catalog': async (req, res) => { admin(req); send(res, 200, db.catalog); },
  'POST /v1/admin/catalog': async (req, res) => {
    admin(req);
    const b = await readJson(req, 600e3);
    if (!Array.isArray(b.games) || b.games.length > 5000) throw new HttpErr(400, 'Liste invalide (5000 jeux max)');
    const seen = new Set(), games = [];
    for (const x of b.games) {
      const g = x && typeof x.g === 'string' ? x.g.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120) : '';
      if (!g || seen.has(g.toLowerCase())) continue;
      seen.add(g.toLowerCase());
      games.push({ g, n: Number.isInteger(x.n) && x.n >= 1 && x.n <= 99 ? x.n : 1, f: x.f === 'yes' || x.f === 'no' ? x.f : '' });
    }
    games.sort((a, c) => a.g.localeCompare(c.g, 'fr', { sensitivity: 'base' }));
    db.catalog = { games, ts: Date.now() }; save('catalog');
    send(res, 200, { count: games.length, ts: db.catalog.ts });
  },
  'GET /v1/admin/overview': async (req, res) => {
    admin(req);
    send(res, 200, {
      users: Object.values(db.users).map(u => ({ username: u.name, created: u.created, banned: !!u.banned })).sort((a, b) => b.created - a.created),
      notifications: db.notifs.slice(-100).reverse(), messages: db.messages.slice(-100).reverse(),
      purchases: db.purchases.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.ts - a.ts).slice(0, 100)
    });
  },
  // v5.35 : accepter / refuser un achat. PIN accepté = le code part dans une notification (kind « code ») à ce client seulement ;
  // thème accepté = thème débloqué sur le compte + notification « unlock » que l'appli applique toute seule.
  'POST /v1/admin/purchase': async (req, res) => {
    admin(req);
    const b = await readJson(req, 5e3), p = db.purchases.find(x => x.id === +b.id);
    if (!p) throw new HttpErr(404, 'Achat introuvable');
    if (p.status !== 'pending') throw new HttpErr(409, 'Achat déjà traité');
    const user = db.users[p.user.toLowerCase()];
    if (!user) throw new HttpErr(404, 'Compte du client introuvable');
    const push = n => { db.notifs.push(Object.assign({ id: ++db.seq.notif, body: '', code: null, to: user.name, theme: null, ts: Date.now() }, n)); };
    if (b.action === 'refuse') {
      p.status = 'refused'; p.done = Date.now();
      push({ kind: 'promo', title: 'Achat non validé : ' + p.item + (p.acc ? ' — Compte ' + p.acc : ''), body: 'Ton paiement n\'a pas pu être vérifié. Contacte le vendeur avec la preuve de ta transaction' + (p.tx ? ' (identifiant : ' + p.tx + ')' : '') + '.' });
    } else if (b.action === 'accept') {
      if (p.kind === 'game') {   // v5.36 : jeu accepté = débloqué sur le compte + notification « unlock » que l'appli applique toute seule (aucun PIN)
        const k = user.name.toLowerCase(), l = db.gunlocks[k] || (db.gunlocks[k] = []), key = gameKey(p.item, p.acc);
        if (!l.some(g => g.toLowerCase() === key.toLowerCase())) l.push(key);
        p.status = 'accepted'; p.done = Date.now();
        const lab = p.item + (p.acc ? ' — Compte ' + p.acc : '');
        push({ kind: 'unlock', title: 'Jeu débloqué : ' + lab, body: 'Ton achat est confirmé. Le jeu est maintenant débloqué : va dans Compte Jeux et touche « Ajouter ».', unlockGame: p.item, unlockAcc: p.acc || null });
        save('gunlocks');
      } else if (p.kind === 'pin') {
        const pin = str(b.pin, 1, 200);
        if (!pin) throw new HttpErr(400, 'Saisis le code PIN à envoyer au client');
        p.status = 'accepted'; p.done = Date.now();
        push({ kind: 'code', title: 'Code PIN : ' + p.item, body: 'Ton achat est confirmé. Voici ton code PIN.', code: pin });
      } else {
        const k = user.name.toLowerCase(), l = db.unlocks[k] || (db.unlocks[k] = []);
        if (!l.includes(p.theme)) l.push(p.theme);
        p.status = 'accepted'; p.done = Date.now();
        push({ kind: 'unlock', title: 'Thème débloqué : ' + p.item, body: 'Ton achat est confirmé. Le thème est maintenant à toi.', unlockTheme: p.theme });
        save('unlocks');
      }
    } else throw new HttpErr(400, 'Action invalide');
    save('purchases', 'notifs', 'seq');
    send(res, 200, { ok: true, status: p.status });
  },
  'POST /v1/admin/ban': async (req, res) => {
    admin(req);
    const b = await readJson(req, 5e3), u = db.users[String(b.username || '').toLowerCase()];
    if (!u) throw new HttpErr(404, 'Utilisateur introuvable');
    u.banned = !!b.banned;
    if (u.banned) for (const k of Object.keys(db.sessions)) if (db.sessions[k].user.toLowerCase() === u.name.toLowerCase()) delete db.sessions[k];
    save('users', 'sessions'); send(res, 200, { ok: true });
  }
};
// DELETE /v1/admin/messages/:id  et  /v1/admin/notifications/:id
function adminDelete(req, res, p) {
  admin(req);
  const id = +p.split('/').pop();
  if (p.startsWith('/v1/admin/messages/')) {
    const i = db.messages.findIndex(m => m.id === id);
    if (i < 0) throw new HttpErr(404, 'Introuvable');
    const m = db.messages.splice(i, 1)[0];
    if (m.image) fs.unlink(path.join(UP, m.image), () => { });
    if (m.audio) fs.unlink(path.join(UP, m.audio), () => { });
    save('messages');
  } else {
    const i = db.notifs.findIndex(n => n.id === id);
    if (i < 0) throw new HttpErr(404, 'Introuvable');
    db.notifs.splice(i, 1); save('notifs');
  }
  send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- serveur HTTP
const PUB_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' };   // v5.62 : /public/* lisible depuis le site (aucune donnee privee)
const PAGES = { '/chat': 'chat.html', '/admin': 'admin.html' };
const FRAME_OK = (process.env.CHAT_FRAME_ANCESTORS || '').split(/[\s,]+/)
  .map(o => { const m = /^(https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?)(\/.*)?$/i.exec(o); return m ? m[1] : ''; }).filter(Boolean).join(' ');   // origines https seulement (un « / » final est toléré)
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const CSP_CHAT = CSP.replace("frame-ancestors 'none'", 'frame-ancestors ' + (FRAME_OK || "'none'"));   // /chat peut être intégré dans ton site ; /admin jamais
let isReady = false, ready = Promise.resolve();   // v5.45 : vrai quand la sauvegarde durable est restaurée et la base chargée
function startServer() {
const srv = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'OPTIONS' && p.startsWith('/public/')) { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }); return res.end(); }
    if (p === '/healthz') return send(res, 200, { ok: true, ready: isReady });   // v5.45 : pour la « Health Check Path » de Render et pour réveiller le service
    if (!isReady && !PAGES[p] && p !== '/') {
      // v5.45 : le serveur écoute dès le démarrage ; pendant la restauration (quelques dizaines de secondes sur Render gratuit) les demandes ATTENDENT au lieu de recevoir une erreur 502
      await Promise.race([ready, sleep(50000)]);
      if (!isReady) throw new HttpErr(503, 'Le serveur démarre, réessaie dans quelques secondes');
    }
    if (req.method === 'GET' && (p === '/' || PAGES[p])) {
      if (p === '/') { res.writeHead(302, { Location: '/chat' }); return res.end(); }
      const html = fs.readFileSync(path.join(__dirname, 'public', PAGES[p]));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': p === '/chat' ? CSP_CHAT : CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && /^\/uploads\/[0-9a-f]{32}\.(png|jpg|gif|webp|m4a|webm|ogg)$/.test(p)) {
      const f = path.join(UP, path.basename(p));
      if (!fs.existsSync(f)) {
        const b = REMOTE ? await rGet('uploads/' + path.basename(f)).catch(() => null) : null;
        if (!b) throw new HttpErr(404, 'Introuvable');
        fs.writeFileSync(f, b);
      }
      const size = fs.statSync(f).size, hd = { 'Content-Type': MIME[path.extname(f).slice(1)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'", 'Accept-Ranges': 'bytes' };
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (rg && (rg[1] || rg[2])) {
        const st = rg[1] ? +rg[1] : Math.max(0, size - +rg[2]), en = rg[1] && rg[2] ? Math.min(+rg[2], size - 1) : size - 1;
        if (st > en || st >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
        res.writeHead(206, Object.assign(hd, { 'Content-Range': 'bytes ' + st + '-' + en + '/' + size, 'Content-Length': en - st + 1 }));
        return fs.createReadStream(f, { start: st, end: en }).pipe(res);
      }
      res.writeHead(200, Object.assign(hd, { 'Content-Length': size }));
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'DELETE' && /^\/v1\/admin\/(messages|notifications)\/\d+$/.test(p)) return adminDelete(req, res, p);
    const h = routes[req.method + ' ' + p];
    if (!h) throw new HttpErr(404, 'Introuvable');
    await h(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    const cors = req.url.startsWith('/public/') ? { 'Access-Control-Allow-Origin': '*' } : undefined;
    if (e instanceof HttpErr) send(res, e.code, { error: e.message }, cors);
    else { console.error(e); send(res, 500, { error: 'Erreur serveur' }); }
  }
});
// v5.45 : le proxy de Render garde les connexions ouvertes plus longtemps que les 5 s par défaut de Node ; sans cela il réutilise une connexion déjà fermée -> erreur 502 au hasard
srv.keepAliveTimeout = 120e3; srv.headersTimeout = 125e3; srv.requestTimeout = 120e3;
srv.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (x) { } });
srv.listen(PORT, () => console.log('G-Ondzet serveur sur le port ' + PORT + (ADMIN_KEY ? '' : '  (ADMIN_KEY absente : /admin désactivée)')));
}
// restauration de la sauvegarde durable AVANT de lire les fichiers JSON, puis ecoute
startServer();   // v5.45 : écoute tout de suite (plus de 502 pendant la restauration)
ready = ghRestore().catch(e => console.error(e)).then(rRestore).catch(e => console.error(e)).then(() => { initDb(); isReady = true; }).catch(e => { console.error('Démarrage :', e); });
