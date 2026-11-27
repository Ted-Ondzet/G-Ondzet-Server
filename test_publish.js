// v5.62 : liens de telechargement par plateforme (ajout / remplacement) + publication du coffre chiffre. Lancer : node test_publish.js (lance son propre serveur et un faux site)
const http = require('http'), { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3921, SITEP = 3922, B = 'http://localhost:' + PORT, AD = { 'x-admin-key': 'secret123' };
const VAULT = { v: 1, s: 'c2VsLXNlbC1zZWw=', i: 'aXYtaXYtaXY=', c: 'Y2lwaGVydGV4dC1jaXBoZXJ0ZXh0LWNpcGhlcnRleHQ=' };
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/versions.json')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ schema: 1, apps: [{ id: 'g-ondzet-now', name: 'G-Ondzet Now', platforms: { android: { latest: '5.19.0', versions: [{ version: '5.19.0', date: '2026-11-20', notes: '', url: 'https://exemple.fr/a519.apk', taille: '42 Mo' }] }, windows: { latest: '6.5', versions: [] }, ios: { latest: null, versions: [] } } }] })); }
  if (req.url.startsWith('/comptes.html')) { res.setHeader('Content-Type', 'text/html'); return res.end('<script>\nvar VAULT=' + JSON.stringify(VAULT) + ';\n</script>'); }
  res.statusCode = 404; res.end('no');
}).listen(SITEP);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
const srv = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, ADMIN_KEY: 'secret123', SITE_URL: 'http://localhost:' + SITEP }), stdio: 'ignore' });
let bad = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(d))); if (!c) bad = 1; };
async function j(m, p, b, h) { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }); let x = {}; try { x = await r.json() } catch (e) { } return [r.status, x, r.headers]; }
(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/healthz'); if ((await r.json()).ready) break; } catch (e) { } await new Promise(r => setTimeout(r, 250)); }
  let [s, r, h] = await j('GET', '/public/versions.json');
  ok('public : versions.json repris du site, sans cle, CORS ouvert', s === 200 && r.apps[0].platforms.android.latest === '5.19.0' && h.get('access-control-allow-origin') === '*', r);
  ok('champs inconnus du site conserves', r.apps[0].platforms.android.versions[0].taille === '42 Mo', r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', version: '5.61', url: 'https://exemple.fr/a561.apk' });
  ok('lien sans cle admin refuse', s === 403, r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', version: '5.61', url: 'http://exemple.fr/a561.apk' }, AD);
  ok('lien http refuse (https obligatoire)', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'Android Phone', version: '1', url: 'https://x.fr/a' }, AD);
  ok('plateforme invalide refusee', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', version: '5.61', url: 'https://exemple.fr/a561.apk', notes: 'Appels vocaux', sha256: 'zz' }, AD);
  ok('sha256 invalide refuse', s === 400, r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', version: '5.61', url: 'https://exemple.fr/a561.apk', notes: 'Appels vocaux' }, AD);
  const an = r.apps && r.apps[0].platforms.android;
  ok('ajout d\'une version Android : devient la derniere', s === 200 && r.replaced === false && an.latest === '5.61' && an.versions.length === 2, r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', version: '5.19.0', url: 'https://exemple.fr/nouveau519.apk' }, AD);
  ok('remplacement du lien d\'une ancienne version (la derniere ne change pas)', s === 200 && r.replaced === true && r.apps[0].platforms.android.latest === '5.61' && r.apps[0].platforms.android.versions.find(v => v.version === '5.19.0').url === 'https://exemple.fr/nouveau519.apk', r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'android', url: 'https://exemple.fr/a561-v2.apk' }, AD);
  ok('sans version : remplace le lien de la derniere version', s === 200 && r.replaced === true && r.version === '5.61' && r.apps[0].platforms.android.versions.find(v => v.version === '5.61').url === 'https://exemple.fr/a561-v2.apk', r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'windows', version: '6.5', url: 'https://exemple.fr/win65.exe', sha256: 'A'.repeat(64) }, AD);
  ok('Windows : lien ajoute + SHA-256', s === 200 && r.apps[0].platforms.windows.latest === '6.5' && r.apps[0].platforms.windows.versions[0].sha256 === 'a'.repeat(64), r);
  [s, r] = await j('POST', '/v1/admin/downloads/link', { platform: 'macos', version: '1.0', url: 'https://exemple.fr/mac.dmg' }, AD);
  ok('nouvelle plateforme (macos) creee', s === 200 && r.apps[0].platforms.macos.latest === '1.0', r);
  [s, r] = await j('GET', '/public/versions.json');
  ok('public : reflete aussitot les changements', s === 200 && r.apps[0].platforms.android.versions.find(v => v.version === '5.61').url === 'https://exemple.fr/a561-v2.apk' && r.apps[0].platforms.macos, r);
  [s, r] = await j('POST', '/v1/admin/downloads/delete', { platform: 'android', version: '5.61' }, AD);
  ok('suppression de la derniere : la precedente redevient « latest »', s === 200 && r.apps[0].platforms.android.latest === '5.19.0', r);
  [s, r] = await j('POST', '/v1/admin/downloads/delete', { platform: 'macos' }, AD);
  ok('suppression d\'une plateforme entiere', s === 200 && !r.apps[0].platforms.macos, r);
  [s, r] = await j('GET', '/v1/admin/downloads', null, AD);
  ok('admin : liste du serveur', s === 200 && r.src && r.apps[0].platforms.windows.latest === '6.5', r);
  // ---- coffre
  [s, r, h] = await j('GET', '/public/coffre.json');
  ok('coffre non publie : 404 (avec CORS)', s === 404 && h.get('access-control-allow-origin') === '*', r);
  [s, r] = await j('GET', '/v1/admin/coffre', null, AD);
  ok('coffre importe du site, pas publie', s === 200 && r.vault.c === VAULT.c && r.pub.on === false, r);
  [s, r] = await j('POST', '/v1/admin/coffre/publish', { on: true });
  ok('publier sans cle admin refuse', s === 403, r);
  [s, r] = await j('POST', '/v1/admin/coffre/publish', { on: true }, AD);
  ok('publication du coffre', s === 200 && r.pub.on === true && r.pub.same === true, r);
  [s, r, h] = await j('GET', '/public/coffre.json');
  ok('public : coffre chiffre lisible sans cle (CORS)', s === 200 && r.c === VAULT.c && r.s === VAULT.s && h.get('access-control-allow-origin') === '*' && Object.keys(r).sort().join() === 'c,i,s,v', r);
  const v2 = Object.assign({}, VAULT, { c: 'bm91dmVsLWNvZmZyZS1ub3V2ZWwtY29mZnJlLW5vdXZlbA==' });
  [s, r] = await j('POST', '/v1/admin/coffre', { vault: v2 }, AD);
  ok('modification sans auto : la copie publiee reste l\'ancienne', s === 200 && r.pub.on === true && r.pub.same === false, r);
  [s, r] = await j('GET', '/public/coffre.json');
  ok('public : toujours l\'ancienne version', r.c === VAULT.c, r);
  [s, r] = await j('POST', '/v1/admin/coffre/publish', { auto: true }, AD);
  ok('publication automatique activee (republie tout de suite)', s === 200 && r.pub.auto === true && r.pub.same === true, r);
  const v3 = Object.assign({}, VAULT, { c: 'dHJvaXNpZW1lLXZlcnNpb24tZHUtY29mZnJlLWNoaWZmcmU=' });
  [s, r] = await j('POST', '/v1/admin/coffre', { vault: v3 }, AD);
  [s, r] = await j('GET', '/public/coffre.json');
  ok('auto : la nouvelle version est publiee toute seule', r.c === v3.c, r);
  [s, r] = await j('POST', '/v1/admin/coffre/undo', null, AD);
  [s, r] = await j('GET', '/public/coffre.json');
  ok('auto : annuler republie aussi', r.c === v2.c, r);
  [s, r] = await j('POST', '/v1/admin/coffre/publish', { on: false }, AD);
  ok('retrait de la publication', s === 200 && r.pub.on === false, r);
  [s, r] = await j('GET', '/public/coffre.json');
  ok('apres retrait : 404', s === 404, r);
  const pre = await fetch(B + '/public/versions.json', { method: 'OPTIONS' });
  ok('preflight CORS', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', pre.status);
  srv.kill(); fake.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? 'ECHEC' : 'TOUT PASSE'); process.exit(bad);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
