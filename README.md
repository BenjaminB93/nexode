# Nexode

Suivi de séries perso, dans l'esprit de TV Showtime. Node 26 (TypeScript exécuté tel quel, sans build), Hono, SQLite (`node:sqlite`), front statique dans `public/`. Données des séries : TMDB.

## En local

```sh
npm ci
cp .env.example .env          # puis renseigner TMDB_READ_TOKEN
npm run dev                   # http://localhost:3000, redémarre à chaque modification
node --env-file-if-exists=.env src/cli/create-admin.ts camille
```

`create-admin` affiche un lien à usage unique pour choisir le mot de passe. Tests : `npm test` ; types : `npm run typecheck`.

**Depuis le téléphone** (même réseau) : `HOST=0.0.0.0` et `SITE_URL=http://<IP du PC>:3000` dans `.env` (sinon les liens d'invitation et de réinitialisation pointent vers `localhost`), relancer `npm run dev`, ouvrir `http://<IP du PC>:3000`. Le pare-feu Windows doit autoriser Node sur le réseau privé.

## Déployer sur le Raspberry Pi

Deux conteneurs : l'appli, qui n'ouvre aucun port, et **Caddy**, seul joignable depuis Internet. Caddy reçoit les connexions sur 80/443, obtient et renouvelle tout seul le certificat HTTPS auprès de Let's Encrypt (qui vérifie, en joignant le Pi sur ces ports, que le domaine pointe bien vers lui), redirige `http://` vers `https://` et transmet les requêtes à l'appli.

Prérequis :

- Docker et le plugin compose sur le Pi (`docker compose version` répond).
- Raspberry Pi OS désactive les limites mémoire des conteneurs (`cgroup_disable=memory`) : ajouter ` cgroup_enable=memory` à la fin de l'unique ligne de `/boot/firmware/cmdline.txt` puis redémarrer, sinon `mem_limit` est ignoré (avertissement au `docker compose up`). Un conteneur créé avant doit être recréé (`--force-recreate`).
- Box : ports TCP 80 et 443 redirigés vers le Pi (UDP 443 en plus pour HTTP/3, facultatif).
- Le nom de domaine (ex. `series.exemple.fr`) pointe vers l'adresse publique de la box.

Le code arrive sur le Pi par `git push` depuis le PC : `~/series` sur le Pi est un dépôt git dont les fichiers suivent chaque push (`updateInstead`). Le Pi n'accède à aucun dépôt distant ; `.env` et `data/`, ignorés par git, ne sont jamais touchés par un push.

Première installation :

```sh
# Sur le Pi
git init -b main ~/series && cd ~/series
git config receive.denyCurrentBranch updateInstead

# Sur le PC
git remote add pi <utilisateur>@<IP du Pi>:series
git push pi main

# Sur le Pi, dans ~/series
mkdir data && sudo chown 1000:1000 data     # le conteneur tourne en utilisateur node (uid 1000)
cp .env.example .env && chmod 600 .env
nano .env                                   # SITE_DOMAIN=series.exemple.fr et TMDB_READ_TOKEN=…
docker compose up -d --build
docker compose ps                           # app doit passer à « healthy »
docker compose exec app node src/cli/create-admin.ts camille
```

`SITE_URL` est déduit de `SITE_DOMAIN` (`https://…`) ; `HOST`, `PORT`, `DB_PATH`, `NODE_ENV` et `TRUST_PROXY` sont imposés par `docker-compose.yml`.

## Mettre à jour

Depuis le PC, après commit :

```sh
git push pi main
ssh <utilisateur>@<IP du Pi> "cd series && docker compose up -d --build"
```

Le push est refusé si un fichier suivi a été modifié directement sur le Pi (rien n'est écrasé).

Les migrations de la base s'appliquent au démarrage.

## Notifications

Web Push : le serveur s'identifie auprès des services push (Google, Apple, Mozilla, Microsoft) par une paire de clés **VAPID**. À générer une seule fois (en changer désabonne tous les appareils) :

```sh
node src/cli/vapid-keys.ts        # sur le PC ; copier les deux lignes dans le .env du Pi, puis docker compose up -d
```

Sans ces clés, l'appli tourne sans notifications (Profil l'indique). Elles exigent le HTTPS : en local, seul `localhost` fonctionne (navigateur du PC). Sur iPhone (iOS 16.4 et plus), l'appli doit être ajoutée à l'écran d'accueil (Partager › Sur l'écran d'accueil), sinon Safari ne propose pas les notifications.

Envoi : chaque heure pile, chaque compte dont l'heure choisie est passée reçoit une notification par série suivie (hors De côté) ayant un épisode non vu qui sort ce jour-là, une seule fois par série et par jour. Les journaux (`docker compose logs app`) résument chaque envoi. Si `Caddyfile` a changé : `docker compose restart caddy` (le fichier est monté seul, le conteneur garde sinon l'ancienne version). Les anciennes images s'accumulent : `docker image prune -f` de temps en temps.

## Sauvegarder

```sh
docker compose exec app node src/cli/backup.ts
```

Copie cohérente de la base, même pendant que l'appli tourne, dans `data/sauvegardes/app-<date UTC>.sqlite`. Elle reste sur le Pi : la copier ailleurs, par exemple depuis le PC :

```sh
scp <utilisateur>@<IP du Pi>:series/data/sauvegardes/app-2026-11-14_153012Z.sqlite .
```

Restaurer : `docker compose stop app`, remplacer `data/app.sqlite` par la sauvegarde (propriétaire 1000:1000), **supprimer** `data/app.sqlite-wal` et `data/app.sqlite-shm`, puis `docker compose start app`.

## Journaux

```sh
docker compose logs -f app
docker compose logs caddy        # obtention du certificat, erreurs de connexion
```

Docker garde au plus 3 × 10 Mo de journaux par conteneur.

Chaque nuit à 4 h 30 (heure de Paris), l'appli met à jour depuis TMDB les séries suivies ou de côté et purge les sessions expirées ; une ligne « maintenance : … » apparaît dans les journaux. Pour la lancer tout de suite : `docker compose exec app node src/cli/refresh.ts`.

## Versions

Numérotation SemVer, dans `package.json` (affichée dans Profil › À propos et au démarrage dans les journaux). Pour publier une version : changer `version` dans `package.json` et `package-lock.json`, commit « Version x.y.z », puis `git tag -a vx.y.z -m "Version x.y.z"` et `git push pi main --follow-tags`.

## Licence

[GNU AGPL-3.0 ou ultérieure](LICENSE). Une version modifiée mise à disposition d'autres personnes doit leur donner accès à son code source.
