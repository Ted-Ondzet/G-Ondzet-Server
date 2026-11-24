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

## v5.26 : statistiques et coffre Steam dans /admin
- **Statistiques** : joueurs inscrits / nouveaux / connectés (24 h, 7 j), téléchargements et achats (total, 7 j, 30 j, courbe 14 jours, top des articles).
- **Coffre Steam** : liste des comptes Steam enregistrés et des coffres sauvegardés (date, taille). Le contenu des coffres reste chiffré par l'appli et n'est jamais envoyé à l'admin.
- **`POST /v1/track`** `{type:'download'|'purchase', item}` (jeton facultatif, 60 appels/h/IP) : l'appli l'appelle à chaque téléchargement ou achat pour alimenter les courbes.
