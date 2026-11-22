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
  seq: load('seq.json', { msg: 0, notif: 0 })
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
  }
  dirty.clear();
}
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

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
  const t = MAGIC.find(x => x[1](buf));
  if (!t) throw new HttpErr(400, 'Format accepté : PNG, JPEG, GIF, WebP');
  const name = crypto.randomBytes(16).toString('hex') + '.' + t[0];
  fs.writeFileSync(path.join(UP, name), buf);
  return name;
}

// ---------------------------------------------------------------- routes API
const USER_RE = /^[A-Za-z0-9_.-]{3,20}$/;
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
    if (m.image) fs.unlink(path.join(UP, m.image), () => { });
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
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'GET' && (p === '/' || PAGES[p])) {
      if (p === '/') { res.writeHead(302, { Location: '/chat' }); return res.end(); }
      const html = fs.readFileSync(path.join(__dirname, 'public', PAGES[p]));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && /^\/uploads\/[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(p)) {
      const f = path.join(UP, path.basename(p));
      if (!fs.existsSync(f)) throw new HttpErr(404, 'Introuvable');
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
}).listen(PORT, () => console.log('G-Ondzet serveur sur le port ' + PORT + (ADMIN_KEY ? '' : '  (ADMIN_KEY absente : /admin désactivée)')));
