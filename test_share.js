'use strict';
// v5.56 : test du partage de partie (invitation, acceptation, signalisation). Lancer : node test_share.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gshare-')), PORT = 3917;
const srv = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, ADMIN_KEY: 'x'.repeat(20) }), stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
const call = async (m, p, body, tk) => { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}), body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'KO  ') + m); if (!c) bad++; };
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(B + '/v1/me'); break; } catch (e) { await new Promise(r => setTimeout(r, 150)); } }
  const reg = n => call('POST', '/v1/register', { username: n, password: 'secret12', question: 'Quel animal prefere ?', answer: 'chat noir' });
  const ra = await reg('Alice'); if (!ra.j.token) console.log('register:', ra.s, JSON.stringify(ra.j)); const a = ra.j.token, b = (await reg('Bobby')).j.token, c = (await reg('Carol')).j.token;
  let r = await call('POST', '/v1/share/invite', { to: 'Bobby', game: 'Fortnite' }, a); ok(r.s === 403, 'invitation refusee si pas amis');
  await call('POST', '/v1/friends/request', { name: 'Bobby' }, a); await call('POST', '/v1/friends/accept', { name: 'Alice' }, b);
  r = await call('POST', '/v1/share/invite', { to: 'Bobby', game: 'Fortnite' }, a);
  if (r.s !== 201) { console.log('amis non crees, reponse', r.s, JSON.stringify(r.j)); }
  ok(r.s === 201 && r.j.room, 'invitation creee'); const room = r.j.room;
  r = await call('GET', '/v1/share/poll', null, b); ok(r.j.invites && r.j.invites.length === 1 && r.j.invites[0].host === 'Alice', 'Bobby voit l\'invitation');
  r = await call('GET', '/v1/share/room?id=' + room, null, c); ok(r.s === 404, 'un tiers ne voit pas la partie');
  r = await call('POST', '/v1/share/accept', { room }, a); ok(r.s === 409, 'l\'hote ne peut pas accepter');
  r = await call('POST', '/v1/share/accept', { room }, b); ok(r.s === 200 && r.j.state === 'live', 'acceptation');
  r = await call('POST', '/v1/share/signal', { room, kind: 'offer', data: '{"sdp":1}' }, a); ok(r.s === 201, 'offre envoyee');
  r = await call('GET', '/v1/share/signal?room=' + room + '&after=0', null, b); ok(r.j.msgs.length === 1 && r.j.msgs[0].kind === 'offer', 'l\'invite recoit l\'offre');
  r = await call('GET', '/v1/share/signal?room=' + room + '&after=0', null, a); ok(r.j.msgs.length === 0, 'l\'hote ne recoit pas son propre signal');
  r = await call('POST', '/v1/share/end', { room }, b); ok(r.j.state === 'ended', 'fin de partie');
  r = await call('GET', '/v1/share/room?id=' + room, null, a); ok(r.j.state === 'ended', 'l\'hote voit la fin');
  srv.kill(); console.log(bad ? 'ECHEC' : 'TOUT PASSE'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
