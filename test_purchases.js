// v5.35 : achats (PIN / theme) -> page admin -> Accepter -> notification / theme debloque
const B = process.env.BASE || 'http://localhost:3998';
async function j(m, p, b, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }); let x = {}; try { x = await r.json() } catch (e) { } return [r.status, x] }
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d))); if (!c) process.exitCode = 1; };
(async () => {
  const AD = { 'x-admin-key': 'secret123' };
  let [s, r] = await j('POST', '/v1/register', { username: 'Momo', password: 'motdepasse', question: 'Quel jeu ?', answer: 'Elden' });
  const TA = { Authorization: 'Bearer ' + r.token };
  [s, r] = await j('POST', '/v1/register', { username: 'Autre', password: 'motdepasse', question: 'Quel jeu ?', answer: 'Elden' });
  const TO = { Authorization: 'Bearer ' + r.token };

  [s, r] = await j('POST', '/v1/purchases', { kind: 'pin', item: 'Elden Ring', tx: 'MP123456' });
  ok('achat sans connexion refuse', s === 401, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'pin', item: 'Elden Ring', tx: 'MP123456' }, TA);
  ok('achat PIN enregistre', s === 201 && r.status === 'pending', r); const pinId = r.id;
  [s, r] = await j('POST', '/v1/purchases', { kind: 'pin', item: 'Elden Ring', tx: 'mp123456' }, TA);
  ok('doublon en attente = meme achat', s === 200 && r.id === pinId, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'theme', item: 'Xbox', tx: 'MP777777' }, TA);
  ok('achat theme par nom', s === 201, r); const thId = r.id;
  [s, r] = await j('POST', '/v1/purchases', { kind: 'theme', item: 'NVIDIA', tx: 'MP888888' }, TA);
  ok('theme gratuit refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'pin', item: 'Jeu', tx: 'ab' }, TA);
  ok('transaction trop courte refusee', s === 400, r);

  [s, r] = await j('GET', '/v1/admin/overview', null, { 'x-admin-key': 'faux' });
  ok('overview sans bonne cle refuse', s === 403, r);
  [s, r] = await j('GET', '/v1/admin/overview', null, AD);
  const pend = (r.purchases || []).filter(p => p.status === 'pending');
  ok('admin voit les achats avec pseudo + article', s === 200 && pend.length === 2 && pend.some(p => p.user === 'Momo' && p.item === 'Elden Ring' && p.kind === 'pin'), r.purchases);
  for (let i = 0; i < 30; i++) await j('GET', '/v1/admin/overview', null, AD);   // beaucoup d'appels corrects (rafraichissement auto) : jamais bloque
  [s, r] = await j('GET', '/v1/admin/overview', null, AD);
  ok('rafraichissements repetes jamais bloques', s === 200, r);

  [s, r] = await j('POST', '/v1/admin/purchase', { id: pinId, action: 'accept' }, AD);
  ok('PIN sans code refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/purchase', { id: pinId, action: 'accept', pin: '4821' }, AD);
  ok('PIN accepte', s === 200 && r.status === 'accepted', r);
  [s, r] = await j('POST', '/v1/admin/purchase', { id: pinId, action: 'accept', pin: '4821' }, AD);
  ok('double acceptation refusee', s === 409, r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TA);
  const code = (r.notifications || []).find(n => n.kind === 'code');
  ok('client recoit le PIN en notification', code && code.code === '4821' && code.to === 'Momo' && /Elden Ring/.test(code.title), r);
  [s, r] = await j('GET', '/v1/notifications?theme=3', null, TA);
  ok('PIN visible quel que soit le theme', (r.notifications || []).some(n => n.kind === 'code'), r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TO);
  ok('un autre client ne voit PAS le PIN', !(r.notifications || []).some(n => n.kind === 'code'), r);

  [s, r] = await j('POST', '/v1/admin/purchase', { id: thId, action: 'accept' }, AD);
  ok('theme accepte', s === 200, r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TA);
  const un = (r.notifications || []).find(n => n.kind === 'unlock');
  ok('notification de deblocage (theme 2 = Xbox)', un && un.unlockTheme === 2, r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TA);
  ok('theme debloque restaure par /purchases/mine', r.themes && r.themes.includes(2) && r.purchases.length === 2, r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TO);
  ok('autre client : aucun theme', r.themes.length === 0 && r.purchases.length === 0, r);

  // v5.36 : bouton « Obtenir » (jeu, sans PIN) -> Accepter -> jeu debloque pour CE client seulement
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Fallout 4', tx: 'MPGAME01' }, TA);
  ok('achat jeu enregistre', s === 201 && r.status === 'pending', r); const gId = r.id;
  [s, r] = await j('POST', '/v1/admin/purchase', { id: gId, action: 'accept' }, AD);
  ok('jeu accepte SANS PIN', s === 200 && r.status === 'accepted', r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TA);
  const gu = (r.notifications || []).find(n => n.kind === 'unlock' && n.unlockGame);
  ok('notification de deblocage du jeu', gu && gu.unlockGame === 'Fallout 4' && gu.to === 'Momo', r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TO);
  ok('un autre client ne voit pas le deblocage', !(r.notifications || []).some(n => n.unlockGame), r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TA);
  ok('jeu restaure par /purchases/mine', Array.isArray(r.games) && r.games.includes('Fallout 4'), r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TO);
  ok('autre client : aucun jeu', Array.isArray(r.games) && r.games.length === 0, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'fallout 4', tx: 'MPGAME02' }, TA);
  ok('jeu deja debloque : pas de nouvelle demande', s === 200 && r.already === true, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Frostpunk', tx: 'MPGAME03' }, TA);
  const gRef = r.id;
  [s, r] = await j('POST', '/v1/admin/purchase', { id: gRef, action: 'refuse' }, AD);
  ok('jeu refuse', s === 200 && r.status === 'refused', r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TA);
  ok('jeu refuse reste verrouille', !r.games.includes('Frostpunk'), r);

  // v5.37 : plusieurs comptes pour un meme jeu (Compte 1 / Compte 2) : se debloquent separement
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Kenshi', acc: 2, tx: 'MPACC002' }, TA);
  ok('achat Kenshi compte 2', s === 201, r); const k2 = r.id;
  [s, r] = await j('POST', '/v1/admin/purchase', { id: k2, action: 'accept' }, AD);
  ok('compte 2 accepte', s === 200, r);
  [s, r] = await j('GET', '/v1/notifications?theme=0', null, TA);
  const ku = (r.notifications || []).find(n => n.unlockGame === 'Kenshi');
  ok('notification : jeu + numero de compte', ku && ku.unlockAcc === 2 && /Compte 2/.test(ku.title), r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TA);
  ok('mine : Kenshi#2 seulement', r.games.includes('Kenshi#2') && !r.games.includes('Kenshi#1') && !r.games.includes('Kenshi'), r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Kenshi', acc: 2, tx: 'MPACC003' }, TA);
  ok('compte 2 deja debloque', s === 200 && r.already === true, r);
  [s, r] = await j('POST', '/v1/purchases', { kind: 'game', item: 'Kenshi', acc: 1, tx: 'MPACC001' }, TA);
  ok('compte 1 reste achetable', s === 201, r);

  [s, r] = await j('POST', '/v1/purchases', { kind: 'theme', item: 'Steam', tx: 'MP999999', theme: 3 }, TA);
  const refId = r.id;
  [s, r] = await j('POST', '/v1/admin/purchase', { id: refId, action: 'refuse' }, AD);
  ok('achat refuse', s === 200 && r.status === 'refused', r);
  [s, r] = await j('GET', '/v1/purchases/mine', null, TA);
  ok('theme refuse non debloque', !r.themes.includes(3), r);
  [s, r] = await j('GET', '/v1/notifications?theme=0&after=0', null, TA);
  ok('client prevenu du refus', (r.notifications || []).some(n => /non validé/.test(n.title)), r);

  // message vise sur UN theme : l'appli appelle /v1/notifications sans ?theme= et filtre elle-meme -> il doit etre renvoye
  [s, r] = await j('POST', '/v1/admin/notify', { kind: 'promo', title: 'Promo Xbox', theme: 2 }, AD);
  [s, r] = await j('GET', '/v1/notifications?after=0', null, TA);
  ok('sans ?theme= : les messages vises sur un theme sont renvoyes (filtre cote appli)', (r.notifications || []).some(n => n.title === 'Promo Xbox' && n.theme === 2), r);
  [s, r] = await j('GET', '/v1/notifications?theme=3', null, TA);
  ok('avec ?theme=3 : le message Xbox reste filtre', !(r.notifications || []).some(n => n.title === 'Promo Xbox'), r);
})();
