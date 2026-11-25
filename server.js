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
  gunlocks: load('gunlocks.json', {}),    // v5.36 : pseudo en minuscules -> [noms des jeux débloqués (Compte Jeux)]
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
const JSON_NAMES = ['users', 'sessions', 'messages', 'notifs', 'friends', 'dms', 'groups', 'gmsgs', 'steam', 'vaults', 'trials', 'purchases', 'unlocks', 'gunlocks', 'seq'];
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

const routes = {
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
    if (e instanceof HttpErr) send(res, e.code, { error: e.message });
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
