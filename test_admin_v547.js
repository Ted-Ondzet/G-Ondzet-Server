// v5.47 : jeu offert, telechargements (versions.json), coffre chiffre, catalogue. Lance le serveur avec SITE_URL=http://localhost:3997
const http = require('http');
const B = process.env.BASE || 'http://localhost:3998';
const VAULT = { v: 1, s: 'c2VsLXNlbC1zZWw=', i: 'aXYtaXYtaXY=', c: 'Y2lwaGVydGV4dC1jaXBoZXJ0ZXh0LWNpcGhlcnRleHQ=' };
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/versions.json')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ schema: 1, apps: [{ id: 'g-ondzet-now', name: 'G-Ondzet Now', platforms: { android: { latest: '5.19.0', versions: [{ version: '5.19.0', date: '2026-11-20', notes: '', url: null }] }, windows: { latest: '6.5', versions: [] }, ios: { latest: null, versions: [] } } }] })); }
  if (req.url.startsWith('/comptes.html')) { res.setHeader('Content-Type', 'text/html'); return res.end('<html><script>\n(function(){\nvar VAULT=' + JSON.stringify(VAULT) + ';\nvar LS="x";})();</script></html>'); }
  res.statusCode = 404; res.end('no');
}).listen(3997);
async function j(m, p, b, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }); let x = {}; try { x = await r.json() } catch (e) { } return [r.status, x] }
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d))); if (!c) process.exitCode = 1; };
(async () => {
  const AD = { 'x-admin-key': 'secret123' };
  let [s, r] = await j('GET', '/v1/admin/downloads');
  ok('downloads sans cle refuse', s === 403, r);
  [s, r] = await j('GET', '/v1/admin/downloads', null, AD);
  ok('downloads : lit versions.json du site', s === 200 && r.apps.length === 1 && r.apps[0].platforms.android.latest === '5.19.0' && /3997/.test(r.site), r);
  [s, r] = await j('GET', '/v1/admin/coffre', null, AD);
  ok('coffre : importe automatiquement depuis comptes.html', s === 200 && r.vault && r.vault.c === VAULT.c && r.src === 'site' && !r.hasPrev, r);
  const v2 = Object.assign({}, VAULT, { c: 'bm91dmVsLWNvZmZyZS1ub3V2ZWwtY29mZnJlLW5vdXZlbA==' });
  [s, r] = await j('POST', '/v1/admin/coffre', { vault: v2 }, AD);
  ok('coffre : enregistrement + version precedente', s === 200 && r.vault.c === v2.c && r.hasPrev === true && r.src === 'admin', r);
  [s, r] = await j('POST', '/v1/admin/coffre', { vault: { s: 'a', i: 'b', c: 'x' } }, AD);
  ok('coffre invalide refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/coffre', { vault: v2 });
  ok('coffre sans cle refuse', s === 403, r);
  [s, r] = await j('POST', '/v1/admin/coffre/undo', null, AD);
  ok('annuler la derniere sauvegarde', s === 200 && r.vault.c === VAULT.c && r.hasPrev === true, r);
  [s, r] = await j('POST', '/v1/admin/coffre/import', null, AD);
  ok('recharger depuis le site', s === 200 && r.vault.c === VAULT.c && r.src === 'site', r);
  [s, r] = await j('POST', '/v1/admin/catalog', { games: [{ g: 'Resident Evil 4', n: 2, f: 'yes' }, { g: 'Elden Ring', n: 1, f: '' }, { g: 'elden ring', n: 3 }, { g: '<b>X</b>', n: 1, f: 'no' }, { g: '', n: 1 }] }, AD);
  ok('catalogue enregistre (doublons et vides ignores)', s === 200 && r.count === 3, r);
  [s, r] = await j('GET', '/v1/admin/catalog', null, AD);
  ok('catalogue trie et nettoye (chevrons retires)', r.games.map(x => x.g).join('|') === 'bX/b|Elden Ring|Resident Evil 4', r);
  [s, r] = await j('POST', '/v1/register', { username: 'Gift', password: 'motdepasse', question: 'Quel jeu ?', answer: 'Elden' });
  const T = { Authorization: 'Bearer ' + r.token };
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'game', game: 'Elden Ring', to: '' }, AD);
  ok('jeu sans client refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'game', game: 'Elden Ring', to: 'Inconnu' }, AD);
  ok('client inconnu refuse', s === 404, r);
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'game', to: 'Gift' }, AD);
  ok('jeu manquant refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'game', game: 'Resident Evil 4', acc: 2, to: 'gift', body: 'Merci !' }, AD);
  ok('jeu offert (compte 2)', s === 201 && r.kind === 'unlock' && r.unlockGame === 'Resident Evil 4' && r.unlockAcc === 2 && r.to === 'Gift', r);
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'game', game: 'Elden Ring', to: 'Gift' }, AD);
  ok('jeu offert (tous les comptes)', s === 201 && r.unlockAcc === null, r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, T);
  const un = (r.notifications || []).filter(n => n.kind === 'unlock');
  ok('le client recoit 2 notifications de deblocage', un.length === 2 && un.some(n => n.unlockGame === 'Elden Ring') && un.some(n => n.body === 'Merci !'), r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, T);
  ok('le client a les jeux debloques immediatement', Array.isArray(r.games) && r.games.includes('Resident Evil 4#2') && r.games.includes('Elden Ring'), r);
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'promo', title: 'Salut', body: 'Hello', to: 'Gift' }, AD);
  ok('message promo toujours possible', s === 201 && r.kind === 'promo', r);
  fake.close();
})();
