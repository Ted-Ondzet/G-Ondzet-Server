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
const db = {
  users: load('users.json', {}),          // clé = pseudo en minuscules
  sessions: load('sessions.json', {}),    // clé = sha256(token)
  messages: load('messages.json', []),
  notifs: load('notifs.json', []),
  seq: load('seq.json', { msg: 0, notif: 0, dm: 0 }),
  friends: load('friends.json', {}),      // clé = pseudo minuscule -> { f: amis, in: demandes reçues, out: demandes envoyées }
  dms: load('dms.json', []),              // discussions privées
  dmreads: load('dmreads.json', {}),      // clé = pseudo -> { autre pseudo: dernier id lu }
  steam: load('steam.json', {}),          // clé = pseudo -> [{ id, label, steamId, shared }]
  vaults: load('vaults.json', {})         // clé = pseudo -> { blob (chiffré par l'appli, illisible ici), ts }  -> sauvegarde distante champ par champ
};
const dirty = new Set(); let timer = null;
function save(...names) {
  names.forEach(n => dirty.add(n));
  if (timer) return;
  timer = setTimeout(flush, 300);
}
function flush() {
  timer = null;
  for (const n of dirty) {
    const f = path.join(DATA, n + '.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db[n])); fs.renameSync(tmp, f);
    if (REMOTE && remoteReady && n !== 'vaults') rdirty.add(n);
  }
  dirty.clear();
  if (REMOTE && remoteReady && rdirty.size && !rtimer) rtimer = setTimeout(() => { rtimer = null; rpush(); }, 1000);
}

// ---------------------------------------------------------------- sauvegarde distante GRATUITE (Upstash Redis, API REST)
// Sur un hébergeur gratuit sans disque, les fichiers sont effacés à chaque redémarrage. Si UPSTASH_REDIS_REST_URL et
// UPSTASH_REDIS_REST_TOKEN sont définies, comptes, messages, notifications et images sont aussi enregistrés chez Upstash
// et restaurés au démarrage. Sans ces variables, rien ne change (stockage local seulement).
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = /^(https:\/\/|http:\/\/localhost[:/])/.test(R_URL + '/') && !!R_TOKEN;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let remoteReady = false, rtimer = null, rretry = null, rchain = Promise.resolve();
const rdirty = new Set(), rimg = new Set();
async function rcmd(args) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
  let j = {}; try { j = await r.json(); } catch (e) { }
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
function dropImage(name) {
  fs.unlink(path.join(UP, name), () => { });
  if (REMOTE) rcmd(['DEL', 'gondzet:img:' + name]).catch(() => { });
}
async function rpushLoop() {
  while (rdirty.size) {
    const n = rdirty.values().next().value;
    rdirty.delete(n);
    let body = JSON.stringify(db[n]);
    let trimmed = false;
    while (Array.isArray(db[n]) && body.length > 900000 && db[n].length > 100) {   // l'offre gratuite limite la taille d'une requête (~1 Mo)
      db[n].splice(0, 100).forEach(m => m.image && dropImage(m.image));
      body = JSON.stringify(db[n]); trimmed = true;
    }
    if (trimmed) save(n);
    try { await rcmd(['SET', 'gondzet:' + n, body]); }
    catch (e) {
      rdirty.add(n);
      console.error('Sauvegarde distante impossible (' + n + ') :', e.message);
      if (!rretry) rretry = setTimeout(() => { rretry = null; rpush(); }, 10000);
      return;
    }
  }
}
function rpush() { if (REMOTE && remoteReady) rchain = rchain.then(rpushLoop); return rchain; }
function rstoreImage(name, buf) {
  if (!REMOTE) return;
  const b64 = buf.toString('base64');
  const p = (async () => {
    for (let i = 0; i < 3; i++) { try { await rcmd(['SET', 'gondzet:img:' + name, b64]); return; } catch (e) { await sleep(2000 * (i + 1)); } }
    console.error('Image non sauvegardée en ligne : ' + name);
  })();
  rimg.add(p); p.finally(() => rimg.delete(p));
}
async function rfetchImage(name, f) {
  if (!REMOTE) return false;
  try { const v = await rcmd(['GET', 'gondzet:img:' + name]); if (!v) return false; fs.writeFileSync(f, Buffer.from(v, 'base64')); return true; }
  catch (e) { return false; }
}
function rbg(args) {   // commande distante en arrière-plan, avec 3 essais
  if (!REMOTE) return;
  const p = (async () => {
    for (let i = 0; i < 3; i++) { try { await rcmd(args); return; } catch (e) { await sleep(2000 * (i + 1)); } }
    console.error('Commande distante abandonnée : ' + args[0] + ' ' + args[1]);
  })();
  rimg.add(p); p.finally(() => rimg.delete(p));
}
async function restore() {
  if (!REMOTE) return;
  for (let attempt = 1; ; attempt++) {
    try {
      for (const n of Object.keys(db)) {
        if (n === 'vaults') continue;
        const v = await rcmd(['GET', 'gondzet:' + n]);
        if (v == null) { rdirty.add(n); continue; }   // rien en ligne pour l'instant : on enverra ce qu'on a
        const data = JSON.parse(v);
        if (Array.isArray(db[n])) { db[n].length = 0; for (const x of data) db[n].push(x); }
        else { for (const k of Object.keys(db[n])) delete db[n][k]; Object.assign(db[n], data); }
        fs.writeFileSync(path.join(DATA, n + '.json'), JSON.stringify(db[n]));
      }
      const h = await rcmd(['HGETALL', 'gondzet:vaults']), rv = {};
      if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) rv[h[i]] = h[i + 1];
      else if (h && typeof h === 'object') Object.assign(rv, h);
      if (Object.keys(rv).length) {
        for (const k of Object.keys(db.vaults)) delete db.vaults[k];
        for (const [k, v] of Object.entries(rv)) { try { db.vaults[k] = JSON.parse(v); } catch (e) { } }
        fs.writeFileSync(path.join(DATA, 'vaults.json'), JSON.stringify(db.vaults));
      } else for (const [k, v] of Object.entries(db.vaults)) rbg(['HSET', 'gondzet:vaults', k, JSON.stringify(v)]);
      remoteReady = true; rpush();
      console.log('Sauvegarde distante active : données restaurées');
      return;
    } catch (e) {
      console.error('Sauvegarde distante : restauration impossible (essai ' + attempt + ') :', e.message);
      if (attempt >= 5) { console.error('Arrêt pour ne pas écraser les données en ligne.'); process.exit(1); }
      await sleep(3000 * attempt);
    }
  }
}
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  try { flush(); await Promise.race([Promise.allSettled([...rimg]).then(() => rpush()), sleep(8000)]); } catch (e) { }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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

const seen = new Map();   // dernière activité (en mémoire) pour « en ligne »
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
  seen.set(u.name.toLowerCase(), Date.now());
  return u;
}
function admin(req) {
  if (!ADMIN_KEY) throw new HttpErr(503, 'ADMIN_KEY non définie sur le serveur');
  if (limited('adm|' + ipOf(req), 20, 600e3)) throw new HttpErr(429, 'Trop d\'essais');
  if (!safeEq(String(req.headers['x-admin-key'] || ''), ADMIN_KEY)) throw new HttpErr(403, 'Clé administrateur incorrecte');
}
const pub = u => ({ username: u.name });

// ---------------------------------------------------------------- images
const MAGIC = [
  ['png', b => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', b => b.length > 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString('latin1'))],
  ['webp', b => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP']
];
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function saveImage(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpErr(400, 'Image invalide');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new HttpErr(413, 'Image trop lourde (3 Mo max)');
  if (REMOTE && buf.length > 700 * 1024) throw new HttpErr(413, 'Image trop lourde (700 Ko max)');   // limite de l'offre gratuite de sauvegarde en ligne
  const t = MAGIC.find(x => x[1](buf));
  if (!t) throw new HttpErr(400, 'Format accepté : PNG, JPEG, GIF, WebP');
  const name = crypto.randomBytes(16).toString('hex') + '.' + t[0];
  fs.writeFileSync(path.join(UP, name), buf);
  rstoreImage(name, buf);
  return name;
}

// ---------------------------------------------------------------- routes API
const USER_RE = /^[A-Za-z0-9_.-]{3,20}$/;
// ---------------------------------------------------------------- amis, discussions privées, comptes Steam
const keyOf = n => String(n || '').trim().toLowerCase();
const online = k => Date.now() - (seen.get(k) || 0) < 120e3;
const rmFrom = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };
function rel(k) { return db.friends[k] || (db.friends[k] = { f: [], in: [], out: [] }); }
const areFriends = (a, b) => !!db.friends[a] && db.friends[a].f.includes(b);
function otherUser(b, meKey) {
  const k = keyOf(b && b.username), t = db.users[k];
  if (!t || t.banned) throw new HttpErr(404, 'Utilisateur introuvable');
  if (k === meKey) throw new HttpErr(400, 'Tu ne peux pas faire ça avec toi-même');
  return [k, t];
}
function makeFriends(a, b) {
  const ra = rel(a), rb2 = rel(b);
  [ra.in, ra.out].forEach(l => rmFrom(l, b)); [rb2.in, rb2.out].forEach(l => rmFrom(l, a));
  if (!ra.f.includes(b)) ra.f.push(b);
  if (!rb2.f.includes(a)) rb2.f.push(a);
}
function dropDmImage(m) { if (m.image) dropImage(m.image); }
function steamId(v) {
  v = String(v || '').trim();
  const m = /^https?:\/\/steamcommunity\.com\/(?:id|profiles)\/([A-Za-z0-9_-]{2,32}|\d{17})\/?$/i.exec(v);
  if (m) v = m[1];
  return /^\d{17}$/.test(v) || /^[A-Za-z0-9_-]{2,32}$/.test(v) ? v : null;
}
const cleanLabel = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : '';

const routes = {
  'POST /v1/register': async (req, res) => {
    if (limited('reg|' + ipOf(req), 10, 3600e3)) throw new HttpErr(429, 'Trop de créations de compte, réessaie plus tard');
    const b = await readJson(req, 20e3);
    const name = str(b.username, 3, 20), pass = typeof b.password === 'string' ? b.password : '';
    const q = str(b.question, 3, 120), a = str(b.answer, 2, 120);
    if (!name || !USER_RE.test(name)) throw new HttpErr(400, 'Nom d\'utilisateur : 3 à 20 caractères (lettres, chiffres, _ . -)');
    if (pass.length < 6 || pass.length > 200) throw new HttpErr(400, 'Mot de passe : 6 caractères minimum');
    if (!q || !a) throw new HttpErr(400, 'Question et réponse secrètes obligatoires');
    if (db.users[name.toLowerCase()]) throw new HttpErr(409, 'Ce nom d\'utilisateur est déjà pris');
    db.users[name.toLowerCase()] = { name, pw: hashSecret(pass), question: q, ans: hashSecret(normAnswer(a)), created: Date.now(), banned: false };
    save('users');
    send(res, 201, { token: newSession(name), username: name });
  },
  'POST /v1/login': async (req, res) => {
    const b = await readJson(req, 20e3), key = String(b.username || '').toLowerCase();
    if (limited('log|' + ipOf(req), 30, 600e3) || limited('logu|' + key, 10, 600e3)) throw new HttpErr(429, 'Trop d\'essais, réessaie dans quelques minutes');
    const u = db.users[key];
    const ok = u && typeof b.password === 'string' && checkSecret(b.password, u.pw);
    if (!ok) throw new HttpErr(401, 'Nom d\'utilisateur ou mot de passe incorrect');
    if (u.banned) throw new HttpErr(403, 'Compte suspendu');
    send(res, 200, { token: newSession(u.name), username: u.name });
  },
  'POST /v1/logout': async (req, res) => {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (m) { delete db.sessions[sha(m[1])]; save('sessions'); }
    send(res, 200, { ok: true });
  },
  'GET /v1/me': async (req, res) => send(res, 200, pub(auth(req))),
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
    send(res, 200, { token: newSession(u.name), username: u.name });
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
    const image = b.image ? saveImage(b.image) : null;
    if (!text && !image) throw new HttpErr(400, 'Message vide');
    const m = { id: ++db.seq.msg, user: u.name, text, image, ts: Date.now() };
    db.messages.push(m);
    if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
    save('messages', 'seq');
    send(res, 201, m);
  },

  // notifications (promos, codes) : visibles par tous, par un pseudo précis, ou par un thème précis
  'GET /v1/notifications': async (req, res, url) => {
    const u = auth(req), after = +url.searchParams.get('after') || 0, th = url.searchParams.get('theme');
    const l = db.notifs.filter(n => n.id > after && (!n.to || n.to.toLowerCase() === u.name.toLowerCase())
      && (n.theme == null || String(n.theme) === th)).slice(-50);
    send(res, 200, { notifications: l });
  },

  // ---- recherche et amis
  'GET /v1/users/search': async (req, res, url) => {
    const u = auth(req), me = u.name.toLowerCase();
    if (limited('srch|' + me, 30, 60e3)) throw new HttpErr(429, 'Doucement : trop de recherches');
    const q = keyOf(url.searchParams.get('q'));
    if (q.length < 2 || q.length > 20) throw new HttpErr(400, 'Écris 2 à 20 caractères');
    const r = rel(me);
    const list = Object.values(db.users).filter(x => !x.banned && x.name.toLowerCase() !== me && x.name.toLowerCase().includes(q))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 20)
      .map(x => { const k = x.name.toLowerCase(); return { username: x.name, status: r.f.includes(k) ? 'friend' : r.out.includes(k) ? 'outgoing' : r.in.includes(k) ? 'incoming' : 'none' }; });
    send(res, 200, { users: list });
  },
  'GET /v1/friends': async (req, res) => {
    const me = auth(req).name.toLowerCase(), r = rel(me);
    const nm = k => db.users[k] && !db.users[k].banned ? db.users[k].name : null;
    send(res, 200, {
      friends: r.f.map(k => nm(k) && { username: nm(k), online: online(k) }).filter(Boolean),
      incoming: r.in.map(k => nm(k) && { username: nm(k) }).filter(Boolean),
      outgoing: r.out.map(k => nm(k) && { username: nm(k) }).filter(Boolean)
    });
  },
  'POST /v1/friends/request': async (req, res) => {
    const u = auth(req), me = u.name.toLowerCase();
    if (limited('freq|' + me, 20, 3600e3)) throw new HttpErr(429, 'Trop de demandes, réessaie plus tard');
    const [k] = otherUser(await readJson(req, 2e3), me), mine = rel(me), theirs = rel(k);
    if (mine.f.includes(k)) throw new HttpErr(409, 'Vous êtes déjà amis');
    if (mine.in.includes(k)) { makeFriends(me, k); save('friends'); return send(res, 200, { status: 'friends' }); }   // il t'avait déjà invité
    if (mine.out.includes(k)) throw new HttpErr(409, 'Demande déjà envoyée');
    if (mine.f.length >= 100 || mine.out.length >= 50 || theirs.in.length >= 100) throw new HttpErr(409, 'Limite atteinte');
    mine.out.push(k); theirs.in.push(me); save('friends');
    send(res, 201, { status: 'pending' });
  },
  'POST /v1/friends/accept': async (req, res) => {
    const me = auth(req).name.toLowerCase(), [k] = otherUser(await readJson(req, 2e3), me);
    if (!rel(me).in.includes(k)) throw new HttpErr(404, 'Aucune demande de cette personne');
    makeFriends(me, k); save('friends');
    send(res, 200, { status: 'friends' });
  },
  'POST /v1/friends/decline': async (req, res) => {   // refuse une demande reçue ou annule une demande envoyée
    const me = auth(req).name.toLowerCase(), [k] = otherUser(await readJson(req, 2e3), me);
    const mine = rel(me), theirs = rel(k);
    rmFrom(mine.in, k); rmFrom(mine.out, k); rmFrom(theirs.in, me); rmFrom(theirs.out, me);
    save('friends');
    send(res, 200, { ok: true });
  },
  'POST /v1/friends/remove': async (req, res) => {
    const me = auth(req).name.toLowerCase(), [k] = otherUser(await readJson(req, 2e3), me);
    rmFrom(rel(me).f, k); rmFrom(rel(k).f, me); save('friends');
    send(res, 200, { ok: true });
  },

  // ---- discussions privées (entre amis uniquement pour écrire)
  'GET /v1/dm': async (req, res) => {
    const me = auth(req).name.toLowerCase(), reads = db.dmreads[me] || {}, conv = {};
    for (const m of db.dms) {
      const f = m.from.toLowerCase(), t = m.to.toLowerCase();
      if (f !== me && t !== me) continue;
      const o = f === me ? t : f, c = conv[o] || (conv[o] = { with: db.users[o] ? db.users[o].name : (f === me ? m.to : m.from), unread: 0, last: null });
      c.last = { id: m.id, from: m.from, text: m.text, image: !!m.image, ts: m.ts };
      if (f === o && m.id > (reads[o] || 0)) c.unread++;
    }
    const list = Object.values(conv).sort((a, b) => b.last.ts - a.last.ts);
    send(res, 200, { conversations: list, unread: list.reduce((n, c) => n + c.unread, 0) });
  },
  'GET /v1/dm/thread': async (req, res, url) => {
    const me = auth(req).name.toLowerCase(), o = keyOf(url.searchParams.get('with')), after = +url.searchParams.get('after') || 0;
    if (!db.users[o]) throw new HttpErr(404, 'Utilisateur introuvable');
    let l = db.dms.filter(m => m.id > after && ((m.from.toLowerCase() === me && m.to.toLowerCase() === o) || (m.from.toLowerCase() === o && m.to.toLowerCase() === me)));
    if (!after) l = l.slice(-100);
    l = l.slice(0, 200);
    const lastIn = l.filter(m => m.from.toLowerCase() === o).map(m => m.id).pop();
    if (lastIn) { const r = db.dmreads[me] || (db.dmreads[me] = {}); if (lastIn > (r[o] || 0)) { r[o] = lastIn; save('dmreads'); } }
    send(res, 200, { messages: l, friend: areFriends(me, o) });
  },
  'POST /v1/dm/send': async (req, res) => {
    const u = auth(req), me = u.name.toLowerCase();
    if (limited('dm|' + me, 30, 60e3)) throw new HttpErr(429, 'Doucement : trop de messages');
    const b = await readJson(req, 5 * 1024 * 1024), [o, t] = otherUser({ username: b.to }, me);
    if (!areFriends(me, o)) throw new HttpErr(403, 'Vous devez être amis pour discuter en privé');
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : '';
    const image = b.image ? saveImage(b.image) : null;
    if (!text && !image) throw new HttpErr(400, 'Message vide');
    db.seq.dm = (db.seq.dm || 0) + 1;
    const m = { id: db.seq.dm, from: u.name, to: t.name, text, image, ts: Date.now() };
    db.dms.push(m);
    const conv = db.dms.filter(x => (x.from === u.name && x.to === t.name) || (x.from === t.name && x.to === u.name));
    if (conv.length > 500) conv.slice(0, conv.length - 500).forEach(x => { db.dms.splice(db.dms.indexOf(x), 1); dropDmImage(x); });
    if (db.dms.length > 3000) db.dms.splice(0, db.dms.length - 3000).forEach(dropDmImage);
    const r = db.dmreads[me] || (db.dmreads[me] = {}); r[o] = m.id;   // ce que j'écris est « lu » pour moi
    save('dms', 'seq', 'dmreads');
    send(res, 201, m);
  },
  'POST /v1/dm/delete': async (req, res) => {   // supprime un de mes messages privés
    const u = auth(req), id = +(await readJson(req, 2e3)).id, i = db.dms.findIndex(m => m.id === id && m.from === u.name);
    if (i < 0) throw new HttpErr(404, 'Introuvable');
    dropDmImage(db.dms.splice(i, 1)[0]); save('dms');
    send(res, 200, { ok: true });
  },

  // ---- mes comptes Steam (liste lisible) et coffre chiffré (illisible par le serveur)
  'GET /v1/steam': async (req, res) => {
    const me = auth(req).name.toLowerCase();
    send(res, 200, { accounts: db.steam[me] || [], vault: db.vaults[me] ? { has: true, ts: db.vaults[me].ts } : { has: false } });
  },
  'POST /v1/steam': async (req, res) => {
    const me = auth(req).name.toLowerCase(), b = await readJson(req, 20e3);
    if (!Array.isArray(b.accounts) || b.accounts.length > 5) throw new HttpErr(400, '5 comptes Steam maximum');
    const out = b.accounts.map(a => {
      const label = cleanLabel(a && a.label), sid = steamId(a && a.steamId);
      if (!label) throw new HttpErr(400, 'Donne un nom à chaque compte');
      if (!sid) throw new HttpErr(400, 'Identifiant Steam invalide (SteamID64, nom de profil ou lien steamcommunity.com)');
      return { id: /^[0-9a-f]{8}$/.test(String(a.id)) ? a.id : crypto.randomBytes(4).toString('hex'), label, steamId: sid, shared: a.shared === true };
    });
    db.steam[me] = out; save('steam');
    send(res, 200, { accounts: out });
  },
  'GET /v1/steam/friend': async (req, res, url) => {   // comptes que l'ami a choisi de partager
    const me = auth(req).name.toLowerCase(), o = keyOf(url.searchParams.get('username'));
    if (!db.users[o]) throw new HttpErr(404, 'Utilisateur introuvable');
    if (!areFriends(me, o)) throw new HttpErr(403, 'Réservé à tes amis');
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
    const v = { blob: b.blob, ts: Date.now() };
    db.vaults[me] = v; save('vaults');
    rbg(['HSET', 'gondzet:vaults', me, JSON.stringify(v)]);
    send(res, 200, { ts: v.ts });
  },
  'POST /v1/vault/delete': async (req, res) => {
    const me = auth(req).name.toLowerCase();
    delete db.vaults[me]; save('vaults'); rbg(['HDEL', 'gondzet:vaults', me]);
    send(res, 200, { ok: true });
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
      notifications: db.notifs.slice(-100).reverse(), messages: db.messages.slice(-100).reverse()
    });
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
    if (m.image) dropImage(m.image);
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
// CHAT_FRAME_ANCESTORS : sites autorisés à intégrer /chat dans une iframe (ex. ton site Wix). /admin n'est jamais intégrable.
const FRAME_OK = (process.env.CHAT_FRAME_ANCESTORS || '').split(/[\s,]+/)
  .map(o => { const m = /^(https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?)(\/.*)?$/i.exec(o); return m ? m[1] : ''; })   // garde seulement l'origine (tolère un « / » final collé par erreur)
  .filter(Boolean).join(' ');
const cspFor = fa => "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors " + fa + "; base-uri 'none'";
const CSP = cspFor("'none'"), CSP_CHAT = cspFor(FRAME_OK || "'none'");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'GET' && (p === '/' || PAGES[p])) {
      if (p === '/') { res.writeHead(302, { Location: '/chat' }); return res.end(); }
      const html = fs.readFileSync(path.join(__dirname, 'public', PAGES[p]));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': p === '/chat' ? CSP_CHAT : CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && /^\/uploads\/[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(p)) {
      const f = path.join(UP, path.basename(p));
      if (!fs.existsSync(f) && !(await rfetchImage(path.basename(p), f))) throw new HttpErr(404, 'Introuvable');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).slice(1)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
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
restore().then(() => server.listen(PORT, () => console.log('G-Ondzet serveur sur le port ' + PORT + (ADMIN_KEY ? '' : '  (ADMIN_KEY absente : /admin désactivée)') + (REMOTE ? '  [sauvegarde distante]' : '  [stockage local seulement]'))));
