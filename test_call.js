'use strict';
// v5.61 : photos de profil des autres joueurs + appels vocaux. Lancer : node test_call.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcall-')), PORT = 3918, B = 'http://127.0.0.1:' + PORT;
const srv = spawn('node', ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT, DATA_DIR: dir }), stdio: 'ignore' });
const call = async (m, p, body, tk) => { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}), body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'KO  ') + m); if (!c) bad++; };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(B + '/healthz'); break; } catch (e) { await new Promise(r => setTimeout(r, 150)); } }
  const reg = async (n, avatar) => (await call('POST', '/v1/register', { username: n, password: 'secret12', question: 'Quel animal prefere ?', answer: 'chat noir', avatar })).j.token;
  const a = await reg('Alice', PNG), b = await reg('Bobby'), c = await reg('Carol');
  let r = await call('GET', '/v1/avatars?names=alice%2Cbobby%2Cnobody%2C__proto__', null, b);
  ok(/^\/uploads\/[0-9a-f]{32}\.png$/.test(r.j.avatars.alice) && r.j.avatars.bobby === '' && !('nobody' in r.j.avatars), 'photos des autres joueurs');
  ok((await call('GET', '/v1/avatars?names=alice')).s === 401, 'photos : connexion obligatoire');
  ok((await call('POST', '/v1/call/invite', { to: 'Bobby' }, a)).s === 403, 'appel refuse si pas amis');
  await call('POST', '/v1/friends/request', { name: 'Bobby' }, a); await call('POST', '/v1/friends/accept', { name: 'Alice' }, b);
  r = await call('POST', '/v1/call/invite', { to: 'Bobby' }, a); const id = r.j.call; ok(r.s === 201 && id, 'appel lance');
  ok((await call('GET', '/v1/call/poll', null, b)).j.incoming.from === 'Alice', 'Bobby voit l\'appel');
  ok((await call('POST', '/v1/call/invite', { to: 'Alice' }, b)).s === 409, 'pas deux appels a la fois');
  ok((await call('GET', '/v1/call/signal?call=' + id, null, c)).s === 404, 'un tiers n\'a pas acces');
  ok((await call('POST', '/v1/call/accept', { call: id }, a)).s === 409, 'l\'appelant ne peut pas accepter');
  ok((await call('POST', '/v1/call/accept', { call: id }, b)).j.state === 'live', 'acceptation');
  await call('POST', '/v1/call/signal', { call: id, kind: 'offer', data: '{}' }, a);
  ok((await call('GET', '/v1/call/signal?call=' + id + '&after=0', null, b)).j.msgs[0].kind === 'offer', 'signal recu');
  ok((await call('POST', '/v1/call/end', { call: id }, a)).j.state === 'ended', 'raccrocher');
  r = await call('POST', '/v1/call/invite', { to: 'Alice' }, b); ok(r.s === 201, 'rappel possible');
  ok((await call('POST', '/v1/call/end', { call: r.j.call }, a)).j.state === 'declined', 'refus');
  srv.kill(); console.log(bad ? 'ECHEC' : 'TOUT PASSE'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
