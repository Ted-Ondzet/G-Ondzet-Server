// v5.46 : flux d'evenements pour l'appli G-Ondzet Admin
const B = process.env.BASE || 'http://localhost:3998';
async function j(m, p, b, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }); let x = {}; try { x = await r.json() } catch (e) { } return [r.status, x] }
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d))); if (!c) process.exitCode = 1; };
(async () => {
  const AD = { 'x-admin-key': 'secret123' };
  let [s, r] = await j('GET', '/v1/admin/events?after=1', null, { 'x-admin-key': 'faux' });
  ok('sans bonne cle refuse', s === 403, r);
  [s, r] = await j('GET', '/v1/admin/events', null, AD);
  ok('after absent : curseur seulement', s === 200 && r.events.length === 0 && r.now > 0, r);
  const cur = r.now;
  [s, r] = await j('POST', '/v1/register', { username: 'EvtCli', password: 'motdepasse', question: 'Quel jeu ?', answer: 'Elden' });
  const T = { Authorization: 'Bearer ' + r.token };
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Elden Ring', acc: 2, tx: 'MP424242' }, T);
  ok('achat de jeu cree', s === 201, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'theme', item: 'Xbox', tx: 'MP515151' }, T);
  ok('achat de theme cree', s === 201, r);
  let t0 = Date.now();
  [s, r] = await j('GET', '/v1/admin/events?after=' + cur + '&wait=5', null, AD);
  const p = (r.events || []).filter(e => e.type === 'purchase');
  ok('evenements : 2 achats + 1 compte, reponse immediate', s === 200 && p.length === 2 && r.events.some(e => e.type === 'user') && Date.now() - t0 < 2500 && r.pending >= 2, r);
  ok('texte du jeu avec numero de compte', p.some(e => /EvtCli veut le jeu « Elden Ring » — Compte 2/.test(e.text) && /MP424242/.test(e.text)), p);
  ok('texte du theme', p.some(e => /veut le thème « Xbox »/.test(e.text)), p);
  const c2 = r.now;
  t0 = Date.now();
  [s, r] = await j('GET', '/v1/admin/events?after=' + c2 + '&wait=2', null, AD);
  ok('attente puis reponse vide', s === 200 && r.events.length === 0 && Date.now() - t0 >= 1900, r);
  const pend = j('GET', '/v1/admin/events?after=' + r.now + '&wait=10', null, AD);
  setTimeout(() => j('POST', '/v1/chat', { text: 'Bonjour admin' }, T), 1200);
  [s, r] = await pend;
  ok('requete longue reveillee par un message', r.events.length === 1 && r.events[0].type === 'message' && r.events[0].text === 'Bonjour admin', r);
  for (let i = 0; i < 30; i++) await j('GET', '/v1/admin/events', null, AD);
  [s, r] = await j('GET', '/v1/admin/events', null, AD);
  ok('appels corrects repetes : jamais bloque', s === 200, r);
})();
