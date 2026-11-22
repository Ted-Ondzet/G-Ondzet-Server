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
