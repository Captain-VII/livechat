# LiveChat

Les memes de la bande, en direct, **par-dessus l'écran de chacun**. Quelqu'un
poste une image sur Discord : elle s'affiche quelques secondes au milieu de
l'écran de tous ceux qui ont l'appli ouverte, puis disparaît. Pas d'OBS, pas de
compte à créer, rien n'est gardé : ce qui n'a pas été vu est raté.

LiveChat a deux morceaux :

- **le serveur** (`src/server.js`) : le bot Discord et la file d'attente. Il
  tourne sur **une seule machine**, celle de l'hôte, la seule qui connaisse le
  token Discord ;
- **le client** (`src/client/`) : l'overlay, une appli Windows que chacun
  installe chez soi et relie au serveur par une adresse. Il ne contient aucun
  secret.

**Sommaire** — [Pour les joueurs](#pour-les-joueurs) ·
[Envoyer des memes](#envoyer-des-memes) · [Héberger LiveChat](#héberger-livechat) ·
[Configuration](#configuration) · [Développement](#développement) ·
[Dépannage](#dépannage)

---

## Pour les joueurs

### Installer

Télécharge `LiveChat-Setup-<version>.exe` depuis la
[dernière release](https://github.com/Captain-VII/livechat/releases/latest) et
lance-le. L'installation est silencieuse, sans droits administrateur, et l'appli
démarre toute seule à la fin.

Au premier lancement, une fenêtre demande **l'adresse du serveur**, celle que
l'hôte a postée dans Discord. Colle-la telle quelle : les accents graves du bloc
de code, un `https://` ou un protocole manquant sont corrigés tout seuls. La
fenêtre indique si la connexion réussit, puis l'adresse est retenue.

### L'icône de la barre des tâches

L'overlay n'a pas de fenêtre : les clics le traversent. Tout passe par son icône
dans la barre des tâches, **y compris pour quitter**.

| Entrée | Rôle |
| --- | --- |
| Passer ce meme (`Ctrl+Alt+M`) | Coupe le meme en cours, pour tout le monde. |
| Tester un meme | Affiche un carré de test, pour vérifier l'écran et le son. |
| Configurer le serveur… | Change l'adresse du serveur. |
| Couper le son | Coupe le son des vidéos, chez toi seulement. |
| Sortie audio | Choisit le périphérique de sortie, à chaud. |
| Afficher sur | Choisit l'écran, et active la bascule automatique. |
| Indicateur sur l'autre écran | Active la pastille « Livechat en cours » et choisit son coin. |
| Démarrer avec Windows | Lance LiveChat à l'ouverture de la session. |
| Vérifier les mises à jour… | Force une vérification immédiate. |

Tous ces choix sont retenus d'un lancement à l'autre.

### Bascule automatique

Quand tu **joues ou regardes un film sur l'écran principal** de Windows,
l'overlay part tout seul sur ton autre écran, puis revient quand c'est fini. Pas
besoin d'être en plein écran : un jeu en fenêtre ou une vidéo dans un coin de
l'écran suffisent.

- **Un jeu** est reconnu à son exécutable : jeux connus de la Game Bar de
  Windows, jeux installés par Steam, Epic, Riot, Xbox, GOG, Ubisoft ou EA, ou ta
  liste perso `OVERLAY_GAMES`. Les lanceurs eux-mêmes ne comptent pas. En
  dernier recours, toute fenêtre en plein écran au premier plan compte aussi.
- **Un film** est reconnu à la lecture annoncée à Windows (celle que pilotent
  les touches multimédia) dans un navigateur ou un lecteur, sur l'écran
  principal. Spotify et les applis de musique ne comptent pas. Dans un
  navigateur, il faut en plus que l'onglet qui joue soit celui affiché, hors
  sites de musique (YouTube Music, Deezer…) et hors clips (chaîne « - Topic »
  ou VEVO, « Official Audio », « Clip officiel », « Lyrics »…).

L'overlay part après ~4 s d'activité. Il reste ensuite à l'abri tant que le jeu
ou le film continue, **même si tu cliques sur l'autre écran** ou changes
d'onglet, et revient après la fermeture du jeu ou 60 s de pause. Un choix fait à
la main dans **Afficher sur** est respecté 20 s.

Seul l'écran principal est surveillé : si les memes s'affichent déjà sur un
autre écran, rien ne bouge. Il faut au moins deux écrans.

> **Limite :** une musique YouTube dont le titre ne ressemble pas à un clip, sur
> une chaîne ordinaire, dans l'onglet affiché, compte encore comme un film.

### Indicateur « Livechat en cours »

Pendant qu'un meme s'affiche, une petite pastille discrète « Livechat en cours ·
pseudo » apparaît sur l'écran qui **n'affiche pas** l'overlay. Utile quand la
bascule a envoyé les memes à côté : on sait qu'il faut tourner la tête. Elle
laisse passer les clics, ne prend jamais le focus et disparaît avec le meme. En
haut à gauche par défaut, réglable dans le menu de l'icône.

### Son

Les vidéos jouent avec le son. **Sortie audio** l'envoie sur le périphérique de
ton choix : pratique avec une carte son à plusieurs canaux (GoXLR, Voicemeeter)
pour régler les memes à part du jeu et du micro. L'appli demande la permission
« média » à Windows uniquement pour lire le nom des périphériques ; elle n'ouvre
jamais le micro.

### Mises à jour

L'appli vérifie les nouvelles versions 10 s après son lancement, puis toutes les
6 h. Une mise à jour trouvée se télécharge en silence ; une notification
prévient, puis l'appli redémarre d'elle-même 15 s plus tard.

---

## Envoyer des memes

**Dans le salon `#livechat`**, tout ce qui est posté part à l'écran : image,
vidéo, lien direct ou simple texte. Plusieurs pièces jointes donnent plusieurs
passages.

**Avec `/meme`**, depuis n'importe quel salon, avec au moins une option :
`fichier`, `texte` ou `lien` (URL directe vers une image ou une vidéo). La
réponse du bot n'est visible que de toi.

| Contenu | Affichage |
| --- | --- |
| `.png` `.jpg` `.gif` `.webp` `.avif` | Image. |
| `.mp4` `.webm` | Vidéo avec le son, pendant sa durée réelle (60 s au plus). |
| Texte seul | Affiche : plus le texte est court, plus il est gros. |
| GIF du sélecteur Discord (Tenor, Giphy, Klipy…) | Marche dans le salon : le serveur attend que Discord résolve le lien. Pas avec `/meme lien:`. |

### Le rythme

**Un meme à la fois**, en même temps sur tous les écrans. Les autres attendent
leur tour, et le bot répond « Dans la file, 3 devant toi » quand ça bouchonne.
Au-delà de `QUEUE_MAX` memes en attente, les plus anciens sont abandonnés. Une
image reste 5 s ; une vidéo joue sa durée réelle.

Un client qui se reconnecte pendant un meme le rattrape avec le temps qu'il lui
reste, sans se désynchroniser des autres.

### Les commandes

| Commande | Qui | Rôle |
| --- | --- | --- |
| `/meme` | Tout le monde | Envoie un meme. |
| `/passer` | Tout le monde | Coupe le meme en cours, partout. |
| `/file` | Tout le monde | Montre ce qui est à l'écran et ce qui attend. |
| `/connectes` | Tout le monde | Liste qui a l'overlay ouvert, et depuis quand. |
| `/vider` | Modérateurs | Vide la file (le meme à l'écran va au bout). |
| `/bannir @membre` | Modérateurs | Prive quelqu'un de LiveChat, sans toucher au serveur Discord. |
| `/debannir @membre` | Modérateurs | Le remet dans le circuit. |

Les commandes de modération sont réservées à qui peut **gérer les messages** du
salon. La liste des bannis est gardée dans `.livechat-bannis.json`, à côté du
serveur.

On peut aussi couper un meme avec le bouton **⏭** de l'overlay (survole-le, puis
clique) ou le bouton **Passer** posté par le bot dans `#livechat`.

---

## Héberger LiveChat

Tout ce qui suit ne concerne que l'hôte.

### 1. Installer

```bash
npm install
cp .env.example .env
```

`npm install` télécharge Electron (~250 Mo), nécessaire seulement pour le
client. Sur une machine qui ne fait tourner que le serveur :
`npm install --omit=dev`.

### 2. Créer le bot Discord

1. Sur le [portail développeur](https://discord.com/developers/applications),
   crée une application. Copie son **Application ID** dans `DISCORD_CLIENT_ID`.
2. Onglet **Bot** : **Reset Token**, puis copie le token dans `DISCORD_TOKEN`.
   Il ne se réaffiche jamais et ne doit jamais être commité.
3. Toujours dans **Bot**, active **MESSAGE CONTENT INTENT**. **C'est
   obligatoire** : sans lui, les messages du salon arrivent vides (seul `/meme`
   marche), et le serveur peut refuser de démarrer avec `Used disallowed intents`.
4. Lance `npm run server` une fois : la console affiche le lien d'invitation du
   bot. Ouvre-le et choisis ton serveur Discord.
5. Crée un salon texte nommé exactement **`livechat`**.
6. Enregistre les commandes slash :

   ```bash
   npm run deploy
   ```

   À relancer quand une version ajoute ou modifie des commandes.

> **`DISCORD_GUILD_ID` : choisis une fois pour toutes.** Vide, les commandes
> sont enregistrées pour tous les serveurs (jusqu'à une heure avant
> d'apparaître). Rempli, elles le sont pour ce serveur seulement, tout de suite.
> Ne mélange pas les deux : chaque commande apparaîtrait en double.

### 3. Lancer le serveur

```bash
npm run server
```

Deux commandes se tapent directement dans ce terminal : `pause` (met la file en
pause ou la relance ; les memes continuent d'arriver) et `passer`.

Pour voir les memes toi aussi, lance un client à côté (`npm start`, ou l'appli
installée) avec l'adresse `ws://localhost:8787`.

### 4. Ouvrir le serveur aux autres

**Le plus simple : le tunnel automatique.** Installe cloudflared une fois :

```bash
winget install --id Cloudflare.cloudflared
```

À chaque `npm run server`, le serveur ouvre alors un tunnel Cloudflare gratuit et
poste son adresse (`wss://…trycloudflare.com`) dans `#livechat`. L'adresse
**change à chaque lancement** ; l'ancienne annonce est supprimée. Si cloudflared
manque, le serveur le dit dans sa console et continue sans annonce.

Pour gérer le tunnel toi-même (ngrok…), mets `AUTO_TUNNEL=none`, puis donne
l'adresse du tunnel en remplaçant `https://` par `wss://`.

**Pour une adresse fixe : un VPS.** Le bot tourne alors en continu, même PC
éteint. Les fichiers de départ sont dans [`deploy/`](deploy/) :

1. Un petit VPS avec Node 18+, et un sous-domaine qui pointe dessus
   (enregistrement DNS A).
2. Clone le dépôt dans `/opt/livechat`, copie ton `.env` avec **`PUBLIC_URL`**
   rempli (par ex. `wss://livechat.tondomaine.fr`), puis
   `npm install --omit=dev`.
3. [`nginx-livechat.conf`](deploy/nginx-livechat.conf) relaie le HTTPS vers le
   port du serveur. Crée le certificat avec
   `certbot certonly --nginx -d livechat.tondomaine.fr`.
4. [`livechat.service`](deploy/livechat.service) garde le serveur en vie : copie-le
   dans `/etc/systemd/system/`, puis `systemctl enable --now livechat`.
5. [`update.sh`](deploy/update.sh) met à jour en une commande (`git pull`,
   `npm install`, redémarrage).

### 5. Publier une version du client

```bash
npm version 2.5.1 --no-git-tag-version
npm run dist
```

`dist/` contient alors l'installeur (~110 Mo), son `.blockmap` et `latest.yml`.
Commite la nouvelle version, crée le tag (`git tag v2.5.1`, puis
`git push origin master v2.5.1`), puis publie une release GitHub sur ce tag avec
**les trois fichiers**. Sans `latest.yml` et le `.blockmap`, les clients ne
voient pas la mise à jour.

---

## Configuration

Toutes les variables sont facultatives sauf mention contraire. Elles se
mettent dans le `.env`. Un joueur qui a juste installé l'appli n'a besoin
d'aucune : la fenêtre du premier lancement et le menu de l'icône suffisent.

### Serveur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Token du bot. **Requis.** |
| `DISCORD_CLIENT_ID` | — | Application ID. **Requis** pour `npm run deploy`. |
| `DISCORD_GUILD_ID` | — | Enregistre les commandes sur ce serveur seulement (voir plus haut). |
| `PORT` | `8787` | Port d'écoute. |
| `AUTO_TUNNEL` | `cloudflare` | `none` pour désactiver le tunnel automatique. |
| `PUBLIC_URL` | — | Adresse fixe à annoncer, sans tunnel (VPS). |
| `ANNOUNCE_CHANNEL` | `livechat` | Salon où poster l'adresse. |
| `OVERLAY_DURATION_MS` | `5000` | Durée d'affichage d'une image ou d'un texte. |
| `OVERLAY_GAP_MS` | `500` | Pause entre deux memes. |
| `OVERLAY_VIDEO_MAX_MS` | `60000` | Durée maximale d'une vidéo. |
| `QUEUE_MAX` | `40` | Taille maximale de la file. |
| `EMBED_WAIT_MS` | `6000` | Temps laissé à Discord pour résoudre un lien de GIF. |

### Client

Les variables priment sur les choix faits dans le menu.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SERVER_URL` | — | Adresse du serveur. Sinon, demandée au premier lancement. |
| `OVERLAY_DISPLAY` | `principal` | Écran : `principal`, un numéro, ou un bout de son nom. |
| `OVERLAY_VOLUME` | `0.7` | Volume des vidéos, de 0 à 1. |
| `OVERLAY_AUDIO_DEVICE` | `defaut` | Sortie audio : `defaut`, ou un bout du nom du périphérique. |
| `OVERLAY_AUTO_SWITCH` | dernier choix du menu | `off` pour désactiver la bascule automatique. |
| `OVERLAY_GAMES` | — | Exe à traiter comme des jeux, séparés par `;` (ex. `Celeste.exe;Hades`). |
| `OVERLAY_AUTO_UPDATE` | `on` | `off` pour désactiver les mises à jour automatiques. |
| `OVERLAY_NAME` | pseudo Windows | Nom affiché par `/connectes`. |

Les choix du menu sont gardés dans `%APPDATA%\LiveChat\config.json`. On peut y
ajouter une liste `"jeux"`, au même format que `OVERLAY_GAMES`.

---

## Développement

```bash
npm start      # le client, depuis les sources
npm test       # les tests, sans Discord ni réseau
```

```
src/server.js                bot Discord + serveur WebSocket
src/file-memes.js            la file d'attente
src/medias.js                reconnaissance des médias, durée réelle d'une vidéo
src/deploy-commands.js       enregistrement des commandes slash

src/client/main.js           assemblage : overlay, connexion, menu de l'icône
src/client/ecrans.js         choix de l'écran et bascule automatique
src/client/activite.js       jeu ou film sur l'écran principal ?
src/client/sonde-activite.js le PowerShell qui décrit l'écran toutes les 2 s
src/client/indicateur.js     la pastille « Livechat en cours »
src/client/coins.js          position de la pastille
src/client/audio.js          sortie audio
src/client/maj.js            mises à jour automatiques
src/client/reglages.js       .env et choix du menu
src/client/url-serveur.js    nettoyage de l'adresse collée
src/client/overlay.html      ce qui s'affiche
src/client/config.html       fenêtre de l'adresse du serveur
```

Les tests couvrent ce qui casse en silence : le rythme de la file, la durée des
vidéos, l'adresse du serveur, la détection des jeux et des films, et la position
de l'indicateur.

---

## Dépannage

**Rien n'apparaît quand je poste dans `#livechat`.** L'intent MESSAGE CONTENT
n'est pas activé, le salon ne s'appelle pas exactement `livechat`, ou le bot n'y
a pas accès.

**`/meme` n'existe pas, ou apparaît en double.** Absente : lance
`npm run deploy`, et patiente jusqu'à une heure si `DISCORD_GUILD_ID` est vide.
En double : les commandes ont été enregistrées une fois avec
`DISCORD_GUILD_ID` et une fois sans. Supprime l'un des deux enregistrements.

**Le bot répond, mais rien ne s'affiche chez quelqu'un.** Son appli n'est pas
connectée : la première ligne du menu de l'icône indique `LiveChat — Connecté`
ou `LiveChat — Déconnecté…`. Avec le tunnel gratuit, l'adresse change à
chaque lancement du serveur : il faut recoller la nouvelle dans
**Configurer le serveur…**.

**L'appli installée se connecte à `localhost` au lieu du serveur.** Elle a été
lancée depuis le dossier du projet, dont le `.env` impose son `SERVER_URL`.
Lance-la depuis le menu Démarrer.

**Aucune adresse postée au démarrage du serveur.** `[tunnel] cloudflared
introuvable` dans la console : installe-le. Sinon, vérifie que
`AUTO_TUNNEL` n'est pas sur `none` et que le bot a accès au salon d'annonce.

**`/meme lien:` refuse mon GIF.** L'option `lien` veut une URL qui finit par
`.jpg`, `.png`, `.gif`, `.webp`, `.mp4` ou `.webm`. Poste plutôt le GIF
directement dans `#livechat`.

**Un GIF s'affiche en texte.** Discord a mis trop de temps à résoudre le lien :
augmente `EMBED_WAIT_MS`.

**Aucun son.** Vérifie **Sortie audio** et **Couper le son** dans le menu.

**Les memes ne s'affichent pas pendant un jeu.** Un jeu en **plein écran
exclusif** empêche toute fenêtre de se dessiner par-dessus : c'est une limite de
Windows. La bascule automatique contourne le problème, à condition d'avoir un
second écran, que le jeu soit sur l'écran **principal** et qu'il soit reconnu
(sinon, ajoute son exe à `OVERLAY_GAMES`). Sans second écran, passe le jeu en
plein écran fenêtré.

**« LiveChat tourne déjà ».** Une instance est déjà ouverte : quitte-la depuis
son icône avant d'en relancer une.

**L'appli ne se met jamais à jour.** Vérifie que la dernière release contient
les trois fichiers, et que `OVERLAY_AUTO_UPDATE` n'est pas sur `off`. Une
installation antérieure à la 2.0.0 (portable, ou nommée « Le mur ») ne peut pas
se mettre à jour seule : réinstalle-la une fois avec l'installeur actuel.

**« Démarrer avec Windows » est grisé.** L'option n'existe que sur l'appli
installée, pas avec `npm start`.
