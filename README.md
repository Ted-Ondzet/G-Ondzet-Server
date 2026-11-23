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
| `CHAT_FRAME_ANCESTORS` | adresses https autorisées à intégrer `/chat` dans une iframe, séparées par des espaces (ex. `https://monsite.wixsite.com https://www.mondomaine.fr`). `/admin` n'est jamais intégrable. |

## Pages
- `/chat` : discussion du site (inscription, connexion, mot de passe oublié, messages, images)
- `/admin` : envoi de promos / codes, comptes (suspendre), modération du chat

## Mettre en ligne (exemple Render ou Railway)
1. Mets le contenu de ce dossier dans un dépôt GitHub (`server.js`, `package.json` et `public/` à la racine du dépôt).
2. Crée un « Web Service » Node relié au dépôt. Commande de démarrage : `npm start`.
3. Variables d'environnement : `ADMIN_KEY` = ta clé secrète, `TRUST_PROXY` = `1`, `DATA_DIR` = `/data`.
4. Ajoute un **disque persistant** monté sur `/data`. Sans lui, les comptes et messages sont effacés à chaque redémarrage.
5. Ouvre `https://TON-ADRESSE/chat` pour vérifier, puis copie cette adresse dans `Net.java`.

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

## Garder les données gratuitement (hébergeur sans disque)
Sur Render gratuit, les fichiers sont effacés à chaque redémarrage. Le serveur sait donc aussi enregistrer comptes, sessions, messages, notifications et images chez **Upstash Redis** (offre gratuite) et les restaurer au démarrage.
1. Crée un compte sur upstash.com, puis **Create Database** (type Redis, région proche de ton serveur Render, offre Free).
2. Dans l'onglet **REST API** de la base, copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
3. Sur Render, **Environment** : ajoute ces deux variables telles quelles, puis enregistre (redéploiement automatique).
4. Au démarrage, les logs affichent « Sauvegarde distante active ». Sans ces variables, le serveur reste en stockage local seulement.

Limites de l'offre gratuite : une requête fait environ 1 Mo au maximum, donc les images sont limitées à 700 Ko (le chat les réduit déjà avant l'envoi) et les plus anciens messages sont retirés si la discussion devient trop volumineuse. Si Upstash est injoignable au démarrage, le serveur s'arrête et réessaie plutôt que de repartir à vide et d'écraser les données en ligne.

## Amis, discussions privées, comptes Steam (API)
Toutes ces routes demandent `Authorization: Bearer <jeton>` (le même que pour le chat).

| Route | Rôle |
|---|---|
| `GET /v1/users/search?q=` | cherche un joueur (2 à 20 caractères) ; renvoie `status` : `none`, `outgoing`, `incoming`, `friend` |
| `GET /v1/friends` | `friends` (avec `online`), `incoming` (demandes reçues), `outgoing` (demandes envoyées) |
| `POST /v1/friends/request` `{username}` | envoie une demande (si l'autre t'avait déjà invité, vous devenez amis) |
| `POST /v1/friends/accept` `{username}` | accepte une demande reçue |
| `POST /v1/friends/decline` `{username}` | refuse une demande reçue ou annule une demande envoyée |
| `POST /v1/friends/remove` `{username}` | retire un ami |
| `GET /v1/dm` | conversations avec dernier message et `unread` (total dans `unread`) |
| `GET /v1/dm/thread?with=&after=` | messages d'une conversation (ouvrir la conversation la marque comme lue) |
| `POST /v1/dm/send` `{to, text, image?}` | message privé, **entre amis uniquement** (texte 1000 caractères, image comme dans le chat) |
| `POST /v1/dm/delete` `{id}` | supprime un de ses messages privés |
| `GET /v1/steam` | mes comptes Steam + indique si un coffre existe |
| `POST /v1/steam` `{accounts:[{id?, label, steamId, shared}]}` | remplace la liste (5 max). `steamId` : SteamID64, nom de profil ou lien steamcommunity.com |
| `GET /v1/steam/friend?username=` | comptes que cet **ami** a choisi de partager (`shared: true`) |
| `GET /v1/vault` · `POST /v1/vault` `{blob}` · `POST /v1/vault/delete` | coffre privé (128 Ko max) |

**Coffre :** l'appli doit envoyer le coffre **déjà chiffré** (le serveur ne le déchiffre jamais et l'administrateur ne peut pas le lire). Ne mets jamais de mot de passe Steam en clair dans `/v1/steam`.
Les discussions privées ne sont visibles ni dans `/admin` ni par les autres joueurs. Tout est sauvegardé chez Upstash si les variables sont définies (le coffre champ par champ).
Tests : `node test-social.js` (serveur lancé avec `ADMIN_KEY=secret123`), `node test-remote.js` (sauvegarde distante).
