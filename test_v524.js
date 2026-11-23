// v5.24 : recherche de joueurs + messages vocaux.  Lancer : PORT=3998 DATA_DIR=/tmp/d node server.js ; BASE=http://localhost:3998 node test_v524.js
const B = process.env.BASE || 'http://localhost:3999';
async function j(m, p, b, t, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}, h || {}), body: b ? JSON.stringify(b) : undefined }); let o = {}; try { o = await r.json() } catch (e) { } return [r.status, o] }
const ok = (n, c, d) => console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d)));
// petit « fichier » m4a : 4 octets de taille + "ftyp" + marque + octets quelconques
const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(40, 7)]);
const data = 'data:audio/mp4;base64,' + m4a.toString('base64');
(async () => {
  const reg = async n => { const [s, r] = await j('POST', '/v1/register', { username: n, password: 'motdepasse', question: 'Question test ?', answer: 'reponse' }); return r.token };
  const A = await reg('Zed_Alpha'), Bo = await reg('Zed_Beta'), C = await reg('Quentin');
  let s, r;
  [s, r] = await j('GET', '/v1/users?q=z', null, A); ok('recherche : 2 lettres minimum', s === 400, r);
  [s, r] = await j('GET', '/v1/users?q=zed', null, A); ok('recherche par morceau de pseudo', s === 200 && r.users.length === 1 && r.users[0].name === 'Zed_Beta' && r.users[0].rel === 'none', r);
  [s, r] = await j('GET', '/v1/users?q=ZED', null, A); ok('recherche insensible a la casse, sans soi-meme', r.users.every(u => u.name !== 'Zed_Alpha'), r);
  [s, r] = await j('GET', '/v1/users?q=zed', null); ok('recherche : connexion requise', s === 401, r);
  await j('POST', '/v1/friends/request', { name: 'zed_beta' }, A);
  [s, r] = await j('GET', '/v1/users?q=beta', null, A); ok('lien : outgoing', r.users[0].rel === 'outgoing', r);
  [s, r] = await j('GET', '/v1/users?q=alpha', null, Bo); ok('lien : incoming', r.users[0].rel === 'incoming', r);
  await j('POST', '/v1/friends/accept', { name: 'zed_alpha' }, Bo);
  [s, r] = await j('GET', '/v1/users?q=beta', null, A); ok('lien : friend', r.users[0].rel === 'friend', r);
  // vocaux
  [s, r] = await j('POST', '/v1/dm', { to: 'zed_beta', audio: data, dur: 4321 }, A); ok('vocal prive envoye', s === 201 && /^[0-9a-f]{32}\.m4a$/.test(r.audio) && r.dur === 4321, r);
  const name = r.audio;
  [s, r] = await j('GET', '/v1/dm?with=zed_alpha', null, Bo); ok('ami recoit le vocal', r.messages.length === 1 && r.messages[0].audio === name && r.messages[0].dur === 4321, r);
  let f = await fetch(B + '/uploads/' + name); const buf = Buffer.from(await f.arrayBuffer());
  ok('fichier vocal servi (audio/mp4)', f.status === 200 && f.headers.get('content-type') === 'audio/mp4' && buf.equals(m4a), f.status);
  f = await fetch(B + '/uploads/' + name, { headers: { Range: 'bytes=4-11' } });
  ok('Range : 206 + 8 octets', f.status === 206 && (await f.arrayBuffer()).byteLength === 8 && f.headers.get('content-range') === 'bytes 4-11/' + m4a.length, f.status);
  [s, r] = await j('POST', '/v1/dm', { to: 'zed_beta', audio: 'data:audio/mp4;base64,' + Buffer.from('pas un vrai fichier audio').toString('base64') }, A); ok('faux vocal refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/dm', { to: 'zed_beta', audio: 'data:audio/mp4;base64,' + Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(1.6 * 1024 * 1024)]).toString('base64') }, A); ok('vocal trop lourd refuse', s === 413, r);
  [s, r] = await j('POST', '/v1/dm', { to: 'quentin', audio: data }, A); ok('vocal : seulement entre amis', s === 403, r);
  [s, r] = await j('POST', '/v1/chat', { audio: data, dur: 99999 }, C); ok('vocal global, duree plafonnee a 60 s', s === 201 && r.audio && r.dur === 60000, r);
  [s, r] = await j('GET', '/v1/chat', null, A); ok('vocal global lisible', r.messages.some(m => m.audio && m.dur === 60000), r);
  [s, r] = await j('POST', '/v1/groups', { name: 'Team', members: ['zed_beta'] }, A); const gid = r.id;
  [s, r] = await j('POST', '/v1/group', { id: gid, audio: data, dur: 1000 }, Bo); ok('vocal de groupe', s === 201 && r.audio, r);
  [s, r] = await j('GET', '/v1/group?id=' + gid, null, A); ok('groupe : vocal lu par Ana', r.messages[0].audio && r.messages[0].dur === 1000, r);
})();
