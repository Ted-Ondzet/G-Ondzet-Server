// Test des amis, discussions privées et comptes Steam :  (serveur lancé avec ADMIN_KEY=secret123)  node test-social.js
const B = process.env.BASE || 'http://localhost:3999';
async function j(m, p, b, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }); let x = {}; try { x = await r.json(); } catch (e) { } return [r.status, x]; }
const ok = (n, c, d) => console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d)));
const reg = async n => { const [s, r] = await j('POST', '/v1/register', { username: n, password: 'motdepasse', question: 'Quel est ton jeu ?', answer: 'Zelda' }); return { Authorization: 'Bearer ' + r.token }; };
(async () => {
  const sfx = Math.random().toString(36).slice(2, 6);
  const [an, bn, cn] = ['Alice' + sfx, 'Bobby' + sfx, 'Carla' + sfx];
  const A = await reg(an), Bb = await reg(bn), C = await reg(cn);
  let [s, r] = await j('GET', '/v1/users/search?q=' + sfx, null, A);
  ok('recherche : trouve les autres, pas soi', s === 200 && r.users.length === 2 && !r.users.some(u => u.username === an), r);
  [s, r] = await j('GET', '/v1/users/search?q=a', null, A); ok('recherche trop courte refusée', s === 400, r);
  [s, r] = await j('GET', '/v1/users/search?q=' + sfx);  ok('recherche sans connexion refusée', s === 401, r);
  [s, r] = await j('POST', '/v1/friends/request', { username: an }, A); ok('demande à soi-même refusée', s === 400, r);
  [s, r] = await j('POST', '/v1/friends/request', { username: 'fantome' + sfx }, A); ok('demande à un inconnu : 404', s === 404, r);
  [s, r] = await j('POST', '/v1/dm/send', { to: bn, text: 'coucou' }, A); ok('message privé avant amitié refusé', s === 403, r);
  [s, r] = await j('POST', '/v1/friends/request', { username: bn }, A); ok('demande envoyée', s === 201 && r.status === 'pending', r);
  [s, r] = await j('POST', '/v1/friends/request', { username: bn.toUpperCase() }, A); ok('doublon refusé', s === 409, r);
  [s, r] = await j('GET', '/v1/friends', null, Bb); ok('Bobby voit la demande reçue', r.incoming.length === 1 && r.incoming[0].username === an, r);
  [s, r] = await j('GET', '/v1/users/search?q=' + an.toLowerCase(), null, Bb); ok('statut « incoming » dans la recherche', r.users[0].status === 'incoming', r);
  [s, r] = await j('POST', '/v1/friends/accept', { username: cn }, Bb); ok('accepter sans demande : 404', s === 404, r);
  [s, r] = await j('POST', '/v1/friends/accept', { username: an }, Bb); ok('demande acceptée', s === 200 && r.status === 'friends', r);
  [s, r] = await j('GET', '/v1/friends', null, A); ok('Alice voit Bobby en ligne', r.friends.length === 1 && r.friends[0].online === true && r.outgoing.length === 0, r);
  // croisement : Carla et Alice s'invitent mutuellement
  await j('POST', '/v1/friends/request', { username: an }, C);
  [s, r] = await j('POST', '/v1/friends/request', { username: cn }, A); ok('demandes croisées = amis direct', s === 200 && r.status === 'friends', r);
  // refus / annulation
  const D = await reg('Dylan' + sfx); await j('POST', '/v1/friends/request', { username: 'Dylan' + sfx }, A);
  [s, r] = await j('POST', '/v1/friends/decline', { username: an }, D); ok('refus', s === 200, r);
  [s, r] = await j('GET', '/v1/friends', null, A); ok('demande refusée disparue', r.outgoing.length === 0 && r.friends.length === 2, r);
  // discussions privées
  [s, r] = await j('POST', '/v1/dm/send', { to: bn, text: 'Salut <b>Bobby</b>' }, A); ok('DM envoyé', s === 201 && r.id > 0, r); const id1 = r.id;
  [s, r] = await j('GET', '/v1/dm', null, Bb); ok('Bobby : 1 non lu', r.unread === 1 && r.conversations[0].with === an, r);
  [s, r] = await j('GET', '/v1/dm/thread?with=' + an, null, Bb); ok('fil de discussion', r.messages.length === 1 && r.messages[0].text.startsWith('Salut'), r);
  [s, r] = await j('GET', '/v1/dm', null, Bb); ok('lu après ouverture', r.unread === 0, r);
  [s, r] = await j('GET', '/v1/dm/thread?with=' + an, null, C); ok('Carla ne voit pas la discussion A-B', r.messages.length === 0, r);
  [s, r] = await j('POST', '/v1/dm/send', { to: an, text: 'Salut Alice' }, Bb); ok('réponse', s === 201, r);
  [s, r] = await j('GET', '/v1/dm/thread?with=' + bn + '&after=' + id1, null, A); ok('après id', r.messages.length === 1 && r.messages[0].from === bn, r);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  [s, r] = await j('POST', '/v1/dm/send', { to: bn, image: png }, A); ok('DM avec image', s === 201 && /^[0-9a-f]{32}\.png$/.test(r.image), r); const idImg = r.id;
  [s, r] = await j('POST', '/v1/dm/delete', { id: idImg }, Bb); ok('on ne supprime pas le message d\'un autre', s === 404, r);
  [s, r] = await j('POST', '/v1/dm/delete', { id: idImg }, A); ok('suppression de son message', s === 200, r);
  [s, r] = await j('POST', '/v1/friends/remove', { username: bn }, A);
  [s, r] = await j('POST', '/v1/dm/send', { to: bn, text: 'encore ?' }, A); ok('plus amis : écriture refusée', s === 403, r);
  // Steam
  [s, r] = await j('POST', '/v1/steam', { accounts: [{ label: 'Principal', steamId: 'https://steamcommunity.com/profiles/76561198000000000/', shared: true }, { label: 'Secondaire', steamId: 'ted_ondzet' }] }, A);
  ok('comptes Steam enregistrés (lien normalisé)', s === 200 && r.accounts[0].steamId === '76561198000000000' && r.accounts[1].shared === false, r);
  [s, r] = await j('POST', '/v1/steam', { accounts: [{ label: 'x', steamId: 'pas valide!' }] }, A); ok('identifiant Steam invalide refusé', s === 400, r);
  [s, r] = await j('POST', '/v1/steam', { accounts: new Array(6).fill({ label: 'x', steamId: 'abcd' }) }, A); ok('6 comptes refusés', s === 400, r);
  [s, r] = await j('GET', '/v1/steam', null, A); ok('lecture de mes comptes', r.accounts.length === 2 && r.vault.has === false, r);
  [s, r] = await j('GET', '/v1/steam/friend?username=' + cn, null, A); ok('Carla (amie) : rien de partagé', s === 200 && r.accounts.length === 0, r);
  [s, r] = await j('GET', '/v1/steam/friend?username=' + an, null, C); ok('Carla voit uniquement le compte partagé d\'Alice', s === 200 && r.accounts.length === 1 && r.accounts[0].label === 'Principal', r);
  [s, r] = await j('GET', '/v1/steam/friend?username=' + an, null, Bb); ok('non-ami : refusé', s === 403, r);
  // coffre chiffré
  [s, r] = await j('GET', '/v1/vault', null, A); ok('pas de coffre au début', s === 404, r);
  const blob = JSON.stringify({ v: 1, s: 'x', i: 'y', c: 'A'.repeat(5000) });
  [s, r] = await j('POST', '/v1/vault', { blob }, A); ok('coffre enregistré', s === 200 && r.ts, r);
  [s, r] = await j('GET', '/v1/vault', null, A); ok('coffre relu identique', s === 200 && r.blob === blob, r.blob && r.blob.length);
  [s, r] = await j('GET', '/v1/vault', null, C); ok('le coffre d\'Alice n\'est pas celui de Carla', s === 404, r);
  [s, r] = await j('POST', '/v1/vault', { blob: 'x'.repeat(140000) }, A); ok('coffre trop gros refusé', s === 400 || s === 413, r);
  [s, r] = await j('POST', '/v1/vault/delete', {}, A); ok('coffre supprimé', s === 200, r);
  [s, r] = await j('GET', '/v1/steam', null, A); ok('plus de coffre', r.vault.has === false, r);
})();
