// v5.24 : la sauvegarde durable (GitHub) restaure comptes, amis, vocaux apres un redemarrage a disque vide.
// Test local avec un FAUX GitHub (GH_API). Lancer : node test_durable.js
const http = require('http'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ok = (n, c, d) => console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d)));
const store = new Map();   // chemin -> { buf, sha }
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), chunks = [];
  req.on('data', c => chunks.push(c)).on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{}'); }
    const m = /^\/repos\/o\/r\/(git\/trees\/main|contents\/(.+))$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end('{}'); }
    if (m[1].startsWith('git/trees')) {
      if (!store.size) { res.writeHead(409); return res.end('{}'); }
      res.writeHead(200); return res.end(JSON.stringify({ tree: [...store].map(([p, v]) => ({ path: p, type: 'blob', sha: v.sha })) }));
    }
    const p = decodeURIComponent(m[2]);
    if (req.method === 'GET') {
      const v = store.get(p); if (!v) { res.writeHead(404); return res.end('{}'); }
      if (/raw/.test(req.headers.accept || '')) { res.writeHead(200); return res.end(v.buf); }
      res.writeHead(200); return res.end(JSON.stringify({ sha: v.sha }));
    }
    if (req.method === 'PUT') {
      const b = JSON.parse(body), v = store.get(p);
      if (v && b.sha !== v.sha) { res.writeHead(422); return res.end('{}'); }
      const buf = Buffer.from(b.content, 'base64'), sha = crypto.createHash('sha1').update(buf).digest('hex');
      store.set(p, { buf, sha }); res.writeHead(201); return res.end(JSON.stringify({ content: { sha } }));
    }
    res.writeHead(405); res.end();
  });
});
function start(port, dir) {
  const c = cp.spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, ADMIN_KEY: 'x', GH_TOKEN: 'tok', GH_REPO: 'o/r', GH_API: 'http://127.0.0.1:3996', GH_EVERY_MS: '400' }), stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = ''; c.stdout.on('data', d => c.out += d); c.stderr.on('data', d => c.out += d); return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function j(base, m, p, b, t) { const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined }); let o = {}; try { o = await r.json() } catch (e) { } return [r.status, o] }
const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(40, 9)]);
(async () => {
  await new Promise(r => mock.listen(3996, '127.0.0.1', r));
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dA')), dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dB'));
  let A = start(3995, dirA); await wait(1200);
  const base = 'http://127.0.0.1:3995', reg = async n => (await j(base, 'POST', '/v1/register', { username: n, password: 'motdepasse', question: 'Q ?', answer: 'rep' }))[1].token;
  const t1 = await reg('Nina'), t2 = await reg('Omar');
  await j(base, 'POST', '/v1/friends/request', { name: 'omar' }, t1); await j(base, 'POST', '/v1/friends/accept', { name: 'nina' }, t2);
  const [s, r] = await j(base, 'POST', '/v1/dm', { to: 'omar', audio: 'data:audio/mp4;base64,' + m4a.toString('base64'), dur: 2000 }, t1);
  ok('vocal envoye', s === 201, r);
  await wait(1800);   // laisse partir la sauvegarde
  ok('GitHub (faux) a recu users.json + friends.json + le vocal', store.has('gondzet-data/users.json') && store.has('gondzet-data/friends.json') && [...store.keys()].some(k => k.endsWith('.m4a')), [...store.keys()]);
  A.kill('SIGTERM'); await wait(600);
  // « Render redemarre » : disque VIDE (dossier neuf), memes variables
  let Bc = start(3994, dirB); await wait(1800);
  ok('restauration annoncee', /fichier\(s\) restaure/.test(Bc.out), Bc.out);
  const b2 = 'http://127.0.0.1:3994';
  const [s2, l] = await j(b2, 'POST', '/v1/login', { username: 'nina', password: 'motdepasse' });
  ok('le compte existe toujours apres redemarrage', s2 === 200 && l.token, l);
  const [s3, fl] = await j(b2, 'GET', '/v1/friends', null, l.token);
  ok('la liste d\'amis est conservee', s3 === 200 && fl.friends[0] === 'Omar', fl);
  const [s4, dm] = await j(b2, 'GET', '/v1/dm?with=omar', null, l.token);
  ok('le message vocal est conserve', dm.messages && dm.messages[0] && dm.messages[0].audio, dm);
  const f = await fetch(b2 + '/uploads/' + dm.messages[0].audio);
  ok('le fichier vocal est restaure', f.status === 200 && Buffer.from(await f.arrayBuffer()).equals(m4a), f.status);
  const [s5] = await j(b2, 'GET', '/v1/me', null, t1);
  ok('l\'ancienne session reste valide (pas de deconnexion)', s5 === 200, s5);
  Bc.kill('SIGTERM'); mock.close(); process.exit(0);
})();
