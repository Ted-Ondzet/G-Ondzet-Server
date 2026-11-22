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
