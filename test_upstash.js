// v5.25 : sauvegarde durable Upstash (faux Upstash local) + comptes Steam + coffre.  Lancer : node test_upstash.js
const http = require('http'), { spawn } = require('child_process'), fs = require('fs');
const store = new Map(), cmds = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (b.length > 1000000) { res.writeHead(413); return res.end('{"error":"too large"}'); }   // limite de l'offre gratuite
    const [cmd, k, v] = JSON.parse(b); let result = null; cmds.push(cmd);
    if (cmd === 'SET') { store.set(k, v); result = 'OK'; } else if (cmd === 'GET') result = store.has(k) ? store.get(k) : null; else if (cmd === 'DEL') result = store.delete(k) ? 1 : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
  });
}).listen(4100);
const ok = (n, c, d) => console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d)));
function start(port, dir, extra) {
  fs.rmSync(dir, { recursive: true, force: true });
  const p = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, ADMIN_KEY: 'k', UPSTASH_REDIS_REST_URL: 'http://localhost:4100', UPSTASH_REDIS_REST_TOKEN: 'tok' }, extra || {}) });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  return new Promise(r => { const t = setInterval(() => { if (log.includes('serveur sur le port')) { clearInterval(t); r({ p, log: () => log }); } }, 100); });
}
const call = async (port, m, path, body, tok, h) => { const r = await fetch('http://localhost:' + port + path, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}, h || {}), body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch (e) { } return [r.status, j, r]; };
(async () => {
  const A = await start(4101, '/tmp/pa');
  ok('A : sauvegarde Upstash active', A.log().includes('Sauvegarde Upstash active'), A.log());
  const reg = async n => (await call(4101, 'POST', '/v1/register', { username: n, password: 'motdepasse', question: 'Quel est ton jeu ?', answer: 'Zelda' }))[1].token;
  const t1 = await reg('GameOndzet'), t2 = await reg('Ami');
  let [s, r] = await call(4101, 'POST', '/v1/chat', { text: 'Salut' }, t1); ok('A : message global', s === 201, r);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  [s, r] = await call(4101, 'POST', '/v1/chat', { image: png }, t1); ok('A : image', s === 201, r); const img = r.image;
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(900000, 7)]);   // vocal volumineux : doit être coupé en morceaux
  await call(4101, 'POST', '/v1/friends/request', { name: 'Ami' }, t1); [s, r] = await call(4101, 'POST', '/v1/friends/accept', { name: 'GameOndzet' }, t2); ok('A : amis', s === 200, r);
  [s, r] = await call(4101, 'POST', '/v1/dm', { to: 'Ami', audio: 'data:audio/mp4;base64,' + m4a.toString('base64'), dur: 5000 }, t1); ok('A : vocal privé volumineux', s === 201 && r.audio, r); const audio = r.audio;
  [s, r] = await call(4101, 'POST', '/v1/steam', { accounts: [{ label: 'Principal', steamId: 'https://steamcommunity.com/profiles/76561198000000000/', shared: true }, { label: 'Second', steamId: 'ted_ondzet' }] }, t1);
  ok('A : comptes Steam (lien normalisé)', s === 200 && r.accounts[0].steamId === '76561198000000000' && r.accounts[1].shared === false, r);
  [s, r] = await call(4101, 'POST', '/v1/steam', { accounts: [{ label: 'x', steamId: 'pas valide!' }] }, t1); ok('A : Steam invalide refusé', s === 400, r);
  [s, r] = await call(4101, 'GET', '/v1/steam/friend?username=GameOndzet', null, t2); ok('A : l\'ami voit seulement le compte partagé', s === 200 && r.accounts.length === 1, r);
  const t3 = await reg('Inconnu'); [s, r] = await call(4101, 'GET', '/v1/steam/friend?username=GameOndzet', null, t3); ok('A : non-ami refusé', s === 403, r);
  const blob = JSON.stringify({ v: 1, s: 'x', i: 'y', c: 'A'.repeat(60000) });
  [s, r] = await call(4101, 'POST', '/v1/vault', { blob }, t1); ok('A : coffre 60 Ko', s === 200, r);
  [s, r] = await call(4101, 'POST', '/v1/vault', { blob: 'x'.repeat(140000) }, t1); ok('A : coffre trop gros refusé', s === 400 || s === 413, r);
  await call(4101, 'POST', '/v1/admin/notify', { kind: 'promo', title: 'Bienvenue' }, null, { 'x-admin-key': 'k' });
  A.p.kill('SIGTERM'); await new Promise(res => A.p.on('exit', res));          // arrêt immédiat : doit tout envoyer avant de quitter
  ok('en ligne : fichiers JSON + image + vocal', ['users', 'friends', 'dms', 'steam', 'vaults'].every(n => store.has('gondzet:f:' + n + '.json')) && store.has('gondzet:f:uploads/' + img) && store.has('gondzet:f:uploads/' + audio), [...store.keys()].filter(k => !/:[a-z0-9]+:\d+$/.test(k)));
  const B = await start(4102, '/tmp/pb');                                      // nouveau serveur, disque vide = redémarrage Render gratuit
  ok('B : restauration', /Sauvegarde Upstash active : \d+ fichier/.test(B.log()), B.log());
  [s, r] = await call(4102, 'GET', '/v1/me', null, t1); ok('B : ancienne session valide (plus de « Connexion requise »)', s === 200 && r.username === 'GameOndzet', r);
  [s, r] = await call(4102, 'POST', '/v1/login', { username: 'gameondzet', password: 'motdepasse' }); ok('B : connexion', s === 200, r);
  [s, r] = await call(4102, 'GET', '/v1/friends', null, t1); ok('B : amis conservés', r.friends && r.friends[0] === 'Ami', r);
  [s, r] = await call(4102, 'GET', '/v1/dm?with=ami', null, t1); ok('B : message privé conservé', r.messages && r.messages.length === 1 && r.messages[0].audio === audio, r);
  const ir = await fetch('http://localhost:4102/uploads/' + img); ok('B : image restaurée', ir.status === 200 && ir.headers.get('content-type') === 'image/png', ir.status);
  const ar = await fetch('http://localhost:4102/uploads/' + audio); const ab = Buffer.from(await ar.arrayBuffer()); ok('B : vocal volumineux restauré à l\'identique', ar.status === 200 && ab.equals(m4a), ar.status);
  [s, r] = await call(4102, 'GET', '/v1/steam', null, t1); ok('B : comptes Steam + coffre conservés', r.accounts && r.accounts.length === 2 && r.vault.has === true, r);
  [s, r] = await call(4102, 'GET', '/v1/vault', null, t1); ok('B : coffre restauré tel quel', s === 200 && r.blob === blob, r.blob && r.blob.length);
  [s, r] = await call(4102, 'GET', '/v1/notifications?theme=0', null, t1); ok('B : notifications conservées', r.notifications && r.notifications.length === 1, r);
  B.p.kill('SIGTERM'); await new Promise(res => B.p.on('exit', res));
  // iframe Wix : /chat seulement
  const C = await start(4103, '/tmp/pc', { CHAT_FRAME_ANCESTORS: 'https://headless-x.wix-site-host.com/ http://evil.com', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
  const hc = (await call(4103, 'GET', '/chat', null, null))[2].headers.get('content-security-policy'), ha = (await call(4103, 'GET', '/admin', null, null))[2].headers.get('content-security-policy');
  ok('Wix : /chat intégrable (« / » final toléré, http refusé)', /frame-ancestors https:\/\/headless-x\.wix-site-host\.com;/.test(hc), hc);
  ok('Wix : /admin jamais intégrable', /frame-ancestors 'none'/.test(ha), ha);
  C.p.kill('SIGTERM'); await new Promise(res => C.p.on('exit', res)); fake.close(); process.exit(0);
})();
