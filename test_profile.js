// v5.78/79 : boite de reception (bannieres) + profil d'un joueur (infos completes pour les amis, limitees pour les autres) + jeux possedes
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3461, DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'OK   ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };
function req(method, p, body, tok) {
  return new Promise(r => {
    const d = body ? JSON.stringify(body) : null;
    const h = Object.assign(d ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {}, tok ? { Authorization: 'Bearer ' + tok } : {});
    const q = http.request({ port: PORT, path: p, method, headers: h }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {} r([res.statusCode, j]); });
    });
    if (d) q.write(d); q.end();
  });
}
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT, DATA_DIR: DIR, ADMIN_KEY: 'x' }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  try {
    const reg = async n => (await req('POST', '/v1/register', { username: n, password: 'motdepasse', question: 'Q ??', answer: 'rep', avatar: JPG }))[1].token;
    const A = await reg('Alice'), B = await reg('Bobby'), C = await reg('Carol');
    let [s, r] = await req('POST', '/v1/friends/request', { name: 'Bobby' }, A);
    // --- boite de reception : premiere lecture = seulement les derniers id
    [s, r] = await req('GET', '/v1/inbox', null, B);
    ok('inbox : demande d\'ami recue', s === 200 && r.incoming.length === 1 && r.incoming[0] === 'Alice' && r.dm.length === 0, r);
    await req('POST', '/v1/friends/accept', { name: 'Alice' }, B);
    const dm0 = (await req('GET', '/v1/inbox?dm=-1&gm=-1', null, B))[1].dmMax;
    await req('POST', '/v1/dm', { to: 'Bobby', text: 'Salut Bobby' }, A);
    [s, r] = await req('GET', '/v1/inbox?dm=' + dm0 + '&gm=0', null, B);
    ok('inbox : nouveau message prive', r.dm.length === 1 && r.dm[0].user === 'Alice' && r.dm[0].text === 'Salut Bobby' && r.incoming.length === 0, r);
    [s, r] = await req('GET', '/v1/inbox?dm=' + r.dmMax + '&gm=0', null, B);
    ok('inbox : plus rien de nouveau', r.dm.length === 0, r);
    [s, r] = await req('GET', '/v1/inbox?dm=0&gm=0', null, A);
    ok('inbox : mes propres messages ne comptent pas', r.dm.length === 0, r);
    // --- profil
    [s, r] = await req('POST', '/v1/me/profile', { first: 'Bob', last: 'Martin' }, B);
    ok('prenom / nom enregistres', s === 200 && r.first === 'Bob' && r.last === 'Martin', r);
    [s, r] = await req('POST', '/v1/me/games', { games: ['Resident Evil 4', 'resident evil 4', 'Sleeping Dogs', '  '] }, B);
    ok('jeux possedes enregistres (doublons retires)', s === 200 && r.count === 2, r);
    [s, r] = await req('POST', '/v1/me/games', { games: 'x' }, B);
    ok('liste de jeux invalide refusee', s === 400, r);
    [s, r] = await req('GET', '/v1/profile?name=bobby', null, A);
    ok('profil d\'un ami : infos completes', s === 200 && r.name === 'Bobby' && r.rel === 'friend' && r.first === 'Bob' && r.last === 'Martin' && r.friends === 1 && r.games.join('|') === 'Resident Evil 4|Sleeping Dogs' && /^\/uploads\/[0-9a-f]{32}\.jpg$/.test(r.avatar) && r.created > 0, r);
    [s, r] = await req('GET', '/v1/profile?name=Bobby', null, C);
    ok('profil d\'un inconnu : infos limitees (pas de jeux ni de nom)', s === 200 && r.rel === 'none' && r.games === undefined && r.first === undefined && !!r.avatar, r);
    [s, r] = await req('GET', '/v1/profile?name=Bobby', null, B);
    ok('mon propre profil : complet', s === 200 && r.rel === 'me' && r.games.length === 2, r);
    [s, r] = await req('GET', '/v1/profile?name=Fantome', null, A);
    ok('profil inexistant : 404', s === 404, r);
    [s, r] = await req('GET', '/v1/profile?name=Bobby');
    ok('profil sans connexion : 401', s === 401, r);
  } finally { srv.kill(); }
  console.log(fails ? fails + ' ÉCHEC(S)' : 'TOUT PASSE'); process.exit(fails ? 1 : 0);
})();
