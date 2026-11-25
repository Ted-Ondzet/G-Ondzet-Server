# Serveur G-Ondzet (comptes · chat · notifications)

Aucune dépendance : Node 18+ suffit.

```bash
ADMIN_KEY="une-longue-phrase-secrete" node server.js      # http://localhost:3000
```

| Variable      | Rôle                                                                 |
|---------------|----------------------------------------------------------------------|
| `ADMIN_KEY`   | **Obligatoire** pour `/admin` (sans elle, l'administration est coupée) |
| `PORT`        | 3000 par défaut                                                      |
| `DATA_DIR`    | dossier des données (`./data`) : **à sauvegarder / garder sur disque persistant** |
| `TRUST_PROXY` | `1` derrière un proxy HTTPS (Render, Railway, nginx…) pour lire la vraie IP |

## Pages
- `/chat` : discussion du site (inscription, connexion, mot de passe oublié, messages, images)
- `/admin` : envoi de promos / codes, comptes (suspendre), modération du chat

## Brancher l'appli
Dans `app/src/main/java/com/ondzet/game/Net.java`, mets l'adresse **https** du serveur :
`static final String API = "https://gondzet.ton-domaine.fr";`

## Test automatique
```bash
DATA_DIR=/tmp/t ADMIN_KEY=secret123 PORT=3999 node server.js &   # puis :
node test.js
```

## Sécurité (déjà en place)
Mots de passe et réponses secrètes hachés (scrypt) · limitation des essais de connexion / récupération ·
images vérifiées (PNG/JPEG/GIF/WebP, 3 Mo max, pas de SVG) · pages protégées par une CSP · clé admin comparée en temps constant.

## Mise en ligne (obligatoire : l'appli exige https)
1. Héberge le dossier `server/` sur un service Node (Render, Railway, Fly.io, VPS…) : commande de démarrage `npm start`.
2. Variables : `ADMIN_KEY` (longue phrase secrète), `TRUST_PROXY=1`, et `DATA_DIR` pointant vers un **disque persistant** (sinon comptes et messages sont perdus à chaque redéploiement).
3. Ouvre `https://ton-adresse/chat` pour vérifier, puis `https://ton-adresse/admin` (clé admin) pour envoyer une promo.
4. Mets l'adresse dans `Net.API` (`app/src/main/java/com/ondzet/game/Net.java`), sans « / » final, puis recompile l'appli.

## Données durables (indispensable sur Render gratuit)
Sur l'offre gratuite de Render le disque est **effacé à chaque redémarrage** : comptes, amis, messages, images et vocaux disparaissent. Deux solutions :
1. **Disque persistant** Render (offre payante) : `DATA_DIR` = chemin du disque.
2. **Sauvegarde GitHub gratuite (intégrée)** :
   - crée un dépôt **privé** (ex. `gondzet-data`) avec au moins un fichier (README) ;
   - crée un jeton *fine-grained* limité à ce dépôt : **Contents → Read and write** ;
   - sur Render → *Environment* : `GH_TOKEN` = le jeton, `GH_REPO` = `ton-pseudo/gondzet-data` (option : `GH_BRANCH`, `GH_DIR`) ;
   - redéploie : les logs affichent « Sauvegarde GitHub : N fichier(s) restauré(s) ». Les fichiers sont copiés toutes les 20 s et restaurés au démarrage.

## Nouveautés v5.24
`GET /v1/users?q=` (recherche de joueurs, 2 lettres min.) · messages vocaux (`audio` data-URL m4a/webm/ogg, `dur` en ms, 1,5 Mo / 60 s max) dans `/v1/chat`, `/v1/dm`, `/v1/group` · fichiers servis avec `Range`.
Tests : `node test_v524.js`, `node test_durable.js` (avec un faux GitHub), `node test_social.js`.

## v5.25 : sauvegarde Upstash (gratuite), iframe Wix, comptes Steam
- **Upstash** (alternative à GitHub, une seule à la fois) : crée une base Redis gratuite sur upstash.com, puis sur Render ajoute `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` (onglet *REST API* de la base). Les logs affichent « Sauvegarde Upstash active ». Si `GH_TOKEN` et `GH_REPO` sont aussi définies, GitHub reste prioritaire.
- **`CHAT_FRAME_ANCESTORS`** : adresses https autorisées à afficher `/chat` dans une iframe (ex. `https://monsite.wix-site-host.com`, un « / » final est toléré). `/admin` n'est jamais intégrable.
- **Comptes Steam** (jeton `Authorization: Bearer`) : `GET /v1/steam`, `POST /v1/steam` `{accounts:[{id?, label, steamId, shared}]}` (5 max), `GET /v1/steam/friend?username=` (comptes partagés d'un ami), `GET /v1/vault`, `POST /v1/vault` `{blob}` (128 Ko max, déjà chiffré par l'appli), `POST /v1/vault/delete`. Ne mets jamais de mot de passe Steam en clair.
- Tests : `node test_upstash.js`.

## Photo de profil (v5.44)
La photo du compte est gardée sur le serveur en forme réduite (carré 128 px, ~5-10 Ko) : `POST /v1/register` accepte `avatar` (data URL),
`POST /v1/me/avatar` `{ image }` la change (image vide = retirer), et `register` / `login` / `GET /v1/me` renvoient `avatar` (adresse `/uploads/...`).
Test : `node test_avatar.js`.

## Erreur 502 (v5.45)
- Le serveur écoute **dès le démarrage** (avant, il n'écoutait qu'après la restauration de la sauvegarde : Render renvoyait 502 pendant ce temps). Les demandes attendent la fin de la restauration (50 s max, sinon 503 « Le serveur démarre »).
- `keepAliveTimeout` 120 s : le proxy de Render ne tombe plus sur une connexion déjà fermée (cause classique de 502 au hasard).
- Une erreur imprévue est journalisée mais ne tue plus le processus.
- `GET /healthz` répond `{ok, ready}` : mets `/healthz` dans **Settings > Health Check Path** sur Render, et un ping toutes les 5-10 min (UptimeRobot, gratuit) évite l'endormissement du service gratuit.

## Appli G-Ondzet Admin (v5.46)
`GET /v1/admin/events?after=<ms>&wait=25` (en-tête `x-admin-key`) : requête « longue » utilisée par l'appli Android **G-Ondzet Admin**. Elle répond dès qu'il y a un nouvel **achat** (jeu / thème / PIN), un **nouveau compte** ou un **message du chat** :
`{ events: [{ id, type: "purchase"|"user"|"message", ts, title, text }], now, pending }` (`pending` = achats en attente). `after=0` ne renvoie que le curseur `now`.
Aucun changement pour l'appli du client ni pour `/admin`. Test : `node test_events.js` (serveur lancé avec `ADMIN_KEY=secret123 PORT=3998`).

## v5.47 : nouvelle page /admin (sections), jeu offert, coffre Steam, téléchargements
- **/admin** refaite : Tableau de bord · Achats · Notifications · Comptes · Chat · Coffre Steam · Téléchargements (menu latéral sur ordinateur, onglets sur téléphone / dans l'appli G-Ondzet Admin).
- **Notifications › Code de jeu** : plus de champ de saisie ; liste déroulante de tous les jeux avec une **barre de recherche en haut**. En envoyant, le client **obtient le jeu immédiatement** : `POST /v1/admin/notify` `{kind:"game", game, acc?, to, body?}` débloque le jeu (comme un achat accepté) et crée une notification `unlock` (`unlockGame`, `unlockAcc`) que l'appli applique. Le client (`to`) est obligatoire.
- **Coffre Steam** (chiffré, la phrase secrète ne quitte jamais le navigateur) : `GET/POST /v1/admin/coffre` (le serveur ne stocke que le blob chiffré `{v,s,i,c}` + une version précédente), `POST /v1/admin/coffre/import` (relit `VAULT` dans `comptes.html` du site), `POST /v1/admin/coffre/undo`. Au premier accès, le coffre est importé automatiquement depuis le site.
- **Catalogue des jeux** : `GET/POST /v1/admin/catalog` (noms seulement, sans identifiants). Il est mis à jour automatiquement à chaque déverrouillage / modification du coffre dans /admin et alimente la liste de « Code de jeu ». Première utilisation : ouvre le Coffre Steam et déverrouille-le une fois.
- **Téléchargements** : `GET /v1/admin/downloads` lit `versions.json` du site (cache 60 s) : version, date, lien, SHA-256 par plateforme (Android, iOS, Windows).
- Variable d'environnement facultative **`SITE_URL`** (défaut : `https://headless-txoacprvfyt-tedondzet-1409.wix-site-host.com`).
- Tests : `node test_admin_v547.js` (serveur lancé avec `ADMIN_KEY=secret123 PORT=3998 SITE_URL=http://localhost:3997`, les tests démarrent leur propre faux site sur le port 3997).
