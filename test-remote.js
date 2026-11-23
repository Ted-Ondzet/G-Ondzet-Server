// Test de la sauvegarde distante avec un faux Upstash local :  node test-remote.js
const http = require('http'), { spawn } = require('child_process'), fs = require('fs');
const store = new Map(), hashes = new Map();
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    const [cmd, k, v, w] = JSON.parse(b); let result = null;
    if (cmd === 'HSET') { (hashes.get(k) || hashes.set(k, new Map()).get(k)).set(v, w); result = 1; }
    else if (cmd === 'HDEL') { result = hashes.has(k) && hashes.get(k).delete(v) ? 1 : 0; }
    else if (cmd === 'HGETALL') { result = hashes.has(k) ? [...hashes.get(k)].flat() : []; }
    else if (cmd === 'SET') { store.set(k, v); result = 'OK'; } else if (cmd === 'GET') result = store.has(k) ? store.get(k) : null; else if (cmd === 'DEL') result = store.delete(k) ? 1 : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
  });
}).listen(4100);
const ok = (n, c, d) => console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function start(port, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const p = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, ADMIN_KEY: 'k', UPSTASH_REDIS_REST_URL: 'http://localhost:4100', UPSTASH_REDIS_REST_TOKEN: 'tok' }) });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  return new Promise(r => { const t = setInterval(() => { if (log.includes('[sauvegarde distante]')) { clearInterval(t); r({ p, log: () => log }); } }, 100); });
}
const call = async (port, m, path, body, h) => { const r = await fetch('http://localhost:' + port + path, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch (e) { } return [r.status, j]; };
(async () => {
  const A = await start(4101, '/tmp/pa');
  let [s, r] = await call(4101, 'POST', '/v1/register', { username: 'GameOndzet', password: 'motdepasse', question: 'Quel est ton jeu préféré ?', answer: 'Zelda' });
  ok('A : inscription', s === 201 && r.token, r); const tok = r.token, H = { Authorization: 'Bearer ' + tok };
  [s, r] = await call(4101, 'POST', '/v1/chat', { text: 'Salut' }, H); ok('A : message', s === 201, r);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  [s, r] = await call(4101, 'POST', '/v1/chat', { image: png }, H); ok('A : image', s === 201, r); const img = r.image;
  await call(4101, 'POST', '/v1/register', { username: 'Ami', password: 'motdepasse', question: 'Quel est ton jeu ?', answer: 'Zelda' });
  [s, r] = await call(4101, 'POST', '/v1/login', { username: 'Ami', password: 'motdepasse' }); const H2 = { Authorization: 'Bearer ' + r.token };
  await call(4101, 'POST', '/v1/friends/request', { username: 'Ami' }, H); [s, r] = await call(4101, 'POST', '/v1/friends/accept', { username: 'GameOndzet' }, H2); ok('A : amis', s === 200, r);
  [s, r] = await call(4101, 'POST', '/v1/dm/send', { to: 'Ami', text: 'Hello privé' }, H); ok('A : message privé', s === 201, r);
  [s, r] = await call(4101, 'POST', '/v1/steam', { accounts: [{ label: 'Principal', steamId: '76561198000000000', shared: true }] }, H); ok('A : compte Steam', s === 200, r);
  [s, r] = await call(4101, 'POST', '/v1/vault', { blob: '{"v":1,"c":"chiffré"}' }, H); ok('A : coffre', s === 200, r);
  [s, r] = await call(4101, 'POST', '/v1/admin/notify', { kind: 'promo', title: 'Bienvenue' }, { 'x-admin-key': 'k' }); ok('A : notification', s === 201, r);
  A.p.kill('SIGTERM'); await new Promise(res => A.p.on('exit', res));        // arrêt immédiat : doit tout envoyer avant de quitter
  ok('en ligne : collections + image + coffre', store.has('gondzet:friends') && store.has('gondzet:dms') && store.has('gondzet:steam') && [...store.keys()].some(k => k.startsWith('gondzet:img:')) && hashes.get('gondzet:vaults') && hashes.get('gondzet:vaults').size === 1, [...store.keys()]);
  const B = await start(4102, '/tmp/pb');                                      // nouveau serveur, disque vide = redémarrage Render gratuit
  ok('B : message de restauration', B.log().includes('données restaurées'), B.log());
  [s, r] = await call(4102, 'GET', '/v1/me', null, H); ok('B : ancienne session toujours valide', s === 200 && r.username === 'GameOndzet', r);
  [s, r] = await call(4102, 'POST', '/v1/login', { username: 'gameondzet', password: 'motdepasse' }); ok('B : connexion', s === 200, r);
  [s, r] = await call(4102, 'GET', '/v1/chat', null, H); ok('B : messages conservés', s === 200 && r.messages.length === 2, r);
  const ir = await fetch('http://localhost:4102/uploads/' + img); ok('B : image restaurée', ir.status === 200 && ir.headers.get('content-type') === 'image/png', ir.status);
  [s, r] = await call(4102, 'GET', '/v1/friends', null, H); ok('B : amis conservés', r.friends && r.friends.length === 1 && r.friends[0].username === 'Ami', r);
  [s, r] = await call(4102, 'GET', '/v1/dm/thread?with=Ami', null, H); ok('B : message privé conservé', r.messages && r.messages.length === 1, r);
  [s, r] = await call(4102, 'GET', '/v1/steam', null, H); ok('B : compte Steam conservé', r.accounts && r.accounts.length === 1 && r.vault.has === true, r);
  [s, r] = await call(4102, 'GET', '/v1/vault', null, H); ok('B : coffre restauré tel quel', s === 200 && r.blob === '{"v":1,"c":"chiffré"}', r);
  [s, r] = await call(4102, 'GET', '/v1/notifications?theme=0', null, H); ok('B : notifications conservées', s === 200 && r.notifications.length === 1, r);
  B.p.kill('SIGTERM'); await new Promise(res => B.p.on('exit', res)); fake.close(); process.exit(0);
})();
