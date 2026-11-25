// v5.44 : photo de profil enregistrée sur le serveur et renvoyée à la connexion
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3457, DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'OK   ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };
function req(method, p, body, headers) {
  return new Promise(r => {
    const d = body ? JSON.stringify(body) : null;
    const q = http.request({ port: PORT, path: p, method, headers: Object.assign(d ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {}, headers) }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) {} r([res.statusCode, j, b]); });
    });
    if (d) q.write(d); q.end();
  });
}
// petit JPEG valide (signature FF D8 FF suffit pour le serveur)
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT, DATA_DIR: DIR, ADMIN_KEY: 'x' }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  try {
    let [s, r] = await req('POST', '/v1/register', { username: 'Ava', password: 'motdepasse', question: 'Q ??', answer: 'rep', avatar: JPG });
    ok('création avec photo', s === 201 && /^\/uploads\/[0-9a-f]{32}\.jpg$/.test(r.avatar), r);
    const url = r.avatar;
    let [s2, , b] = await req('GET', url);
    ok('photo téléchargeable', s2 === 200 && b[0] === 0xff && b[1] === 0xd8, s2);
    [s, r] = await req('POST', '/v1/login', { username: 'ava', password: 'motdepasse' });
    ok('login renvoie la photo', s === 200 && r.avatar === url, r);
    const A = { Authorization: 'Bearer ' + r.token };
    [s, r] = await req('GET', '/v1/me', null, A);
    ok('/me renvoie la photo', s === 200 && r.avatar === url, r);
    [s, r] = await req('POST', '/v1/me/avatar', { image: JPG }, A);
    ok('changer la photo', s === 200 && r.avatar && r.avatar !== url, r);
    [s, r] = await req('POST', '/v1/me/avatar', { image: 'data:image/jpeg;base64,' + Buffer.alloc(115 * 1024, 1).toString('base64') }, A);
    ok('photo trop lourde refusée', s === 413, r);
    [s, r] = await req('POST', '/v1/me/avatar', {}, A);
    ok('retirer la photo', s === 200 && r.avatar === '', r);
    [s, r] = await req('POST', '/v1/register', { username: 'Sans', password: 'motdepasse', question: 'Q ??', answer: 'rep' });
    ok('création sans photo', s === 201 && r.avatar === '', r);
    [s, r] = await req('POST', '/v1/register', { username: 'Bad', password: 'motdepasse', question: 'Q ??', answer: 'rep', avatar: 'data:image/jpeg;base64,AAAA' });
    ok('photo invalide ne bloque pas la création', s === 201 && r.avatar === '', r);
  } finally { srv.kill(); }
  console.log(fails ? fails + ' ÉCHEC(S)' : 'TOUT PASSE'); process.exit(fails ? 1 : 0);
})();
