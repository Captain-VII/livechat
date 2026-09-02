# LiveChat

Les memes de la bande, en direct, **par-dessus l'écran de chacun**. Quelqu'un
balance une image sur Discord, elle s'affiche en grand au milieu de l'écran de
chacun de ceux qui ont l'overlay ouvert, huit secondes, puis disparaît. Pas
d'OBS, pas de FFmpeg, pas de compte à créer côté joueurs.

## Deux morceaux

- **Le serveur** (`src/server.js`) — le bot Discord et la file d'attente. Il
  tourne sur **une seule machine**, celle de l'hôte de la soirée. C'est le seul
  endroit où le token Discord existe.
- **Le client** (`src/client/`) — la fenêtre overlay. Chacun le lance chez soi,
  se connecte au serveur par une adresse, et voit les memes s'afficher sur son
  propre écran, choisi par lui, en même temps que tout le monde. Aucun token,
  aucune donnée secrète dedans — c'est lui qui part en `.exe` vers les potes.

Le serveur ne garde aucun historique : ce qui n'a pas été vu par un client
connecté à l'instant T est simplement raté. Ephémère par nature, comme avant.

---

## 1. Installation (côté développeur / hôte)

```bash
npm install
cp .env.example .env
```

`npm install` télécharge le binaire Electron, environ 250 Mo — nécessaire pour
lancer le client en développement et construire son `.exe`, pas pour faire
tourner le serveur seul.

## 2. Configurer le bot Discord

### 2.1 Créer l'application et le bot

1. Va sur https://discord.com/developers/applications et clique **New Application**.
2. Onglet **General Information** : copie l'**Application ID** dans `DISCORD_CLIENT_ID` (fichier `.env`).
3. Onglet **Bot** : clique **Reset Token**, copie le token dans `DISCORD_TOKEN`.
   Ce token ne se réaffiche jamais, et il ne se commit nulle part. Il ne vit que
   sur la machine qui fait tourner `server.js`.

### 2.2 Activer l'intent MESSAGE CONTENT — **obligatoire**

Onglet **Bot**, section **Privileged Gateway Intents**, active
**MESSAGE CONTENT INTENT**, puis **Save Changes**.

C'est la cause numéro 1 de « ça marche pas ». Sans cet intent, le bot voit passer
les messages du salon mais leur contenu et leurs pièces jointes arrivent vides :
le mode automatique reste désespérément muet (la commande `/meme`, elle,
continue de marcher). Si le serveur refuse carrément de démarrer avec une erreur
`Used disallowed intents`, c'est exactement ça.

### 2.3 Récupérer l'ID du serveur (recommandé)

**Paramètres utilisateur > Avancés > Mode développeur**, puis clic droit sur ton
serveur Discord > **Copier l'identifiant**. Colle-le dans `DISCORD_GUILD_ID`.

- Rempli : `/meme` est enregistrée sur ce serveur et **disponible immédiatement**.
- Vide : la commande est enregistrée globalement, avec **jusqu'à une heure** de
  propagation avant d'apparaître.

### 2.4 Inviter le bot

Lance le serveur une fois (`npm run server`) : l'URL d'invitation est affichée
dans la console, construite depuis le client ID du bot. Ouvre-la, choisis ton
serveur. Permissions minimales : voir les salons, lire l'historique, répondre.

### 2.5 Créer le salon

Crée un salon texte nommé exactement **`livechat`**. Tout ce qui y est posté
part à l'écran, sans commande.

### 2.6 Enregistrer la commande slash

```bash
npm run deploy
```

À relancer seulement si tu changes la définition de la commande.

---

## 3. Lancer le serveur (toi, pendant la soirée)

```bash
npm run server
```

La console liste le port d'écoute et confirme la connexion du bot. Aucune
fenêtre ne s'ouvre — c'est un process en ligne de commande.

Deux commandes tapées directement dans ce terminal, suivies d'Entrée :

- `pause` — met la file en pause (les memes reçus continuent de s'accumuler).
- `passer` — passe le meme en cours à tous les overlays connectés.

### Toi aussi, tu veux voir les memes

Le serveur seul n'affiche rien : lance en plus ton propre client, pointé sur ta
machine.

```bash
npm start
```

Au premier lancement, une petite fenêtre demande l'adresse du serveur — mets
`ws://localhost:8787` (ou le `PORT` que tu as choisi dans `.env`). Elle n'est
plus redemandée ensuite.

---

## 4. Exposer le serveur à tes potes

Ton PC n'est pas visible depuis internet par défaut. Un **tunnel** ouvre un
passage temporaire, sans configurer ta box, sans compte payant — et depuis la
v1.1, **le serveur s'en occupe tout seul** : il ouvre le tunnel au démarrage et
poste l'adresse dans `#livechat` automatiquement.

### Installer cloudflared (une fois)

```bash
winget install --id Cloudflare.cloudflared
```

C'est tout. Au prochain `npm run server`, le déroulé est :

1. Le serveur démarre et se connecte à Discord.
2. Il ouvre un tunnel Cloudflare vers son propre port.
3. Dès que l'adresse est prête **et** que le bot est connecté, il poste dans
   `#livechat` :

   > **LiveChat est en ligne.** Colle cette adresse dans l'appli (icône de la
   > barre des tâches > *Configurer le serveur*) :
   > ```
   > wss://quelque-chose-au-hasard.trycloudflare.com
   > ```

4. Chacun colle cette adresse dans la fenêtre qui s'ouvre au premier lancement
   de son client (`npm start` en développement, ou le `.exe`).

Cette adresse **change à chaque lancement** du serveur — c'est le principe d'un
tunnel gratuit sans compte. Le message est donc reposté à chaque démarrage,
sans que tu aies rien à copier-coller toi-même — et l'annonce précédente est
supprimée au passage, pour que le salon ne garde jamais qu'une seule adresse
valide à la fois.

### Réglages (`.env`, section serveur)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `AUTO_TUNNEL` | `cloudflare` | `cloudflare` pour le tunnel automatique, `none` pour le désactiver. |
| `ANNOUNCE_CHANNEL` | — | Salon où poster l'adresse. Vide : le même que `#livechat`. |

Si `cloudflared` n'est pas installé, le serveur le signale clairement dans sa
console et continue de tourner normalement — seule l'annonce automatique
manque, le reste (bot, file d'attente, connexions locales) n'est pas affecté.

### `AUTO_TUNNEL=none` : tunnel manuel ou alternative

Pour piloter le tunnel toi-même (ngrok, un tunnel Cloudflare nommé avec ton
propre compte, ou un hébergement fixe) :

```bash
AUTO_TUNNEL=none npm run server
```

Puis, dans un second terminal :

```bash
ngrok http 8787
```

Récupère l'adresse générée, remplace `https://` par `wss://`, et donne-la à la
main dans Discord ou directement à tes potes.

**Limite à connaître, dans tous les cas** : si ton PC s'éteint ou perd le
réseau, l'overlay de tout le monde s'arrête — c'est ta machine qui fait tourner
le bot. Pour une soirée où tu es de toute façon devant ton PC, ce n'est en
général pas un problème. Pour que LiveChat tourne en continu, indépendamment
de ton PC, voir la section suivante.

### Aller plus loin : héberger sur un VPS (serveur toujours allumé)

Tout ce qui précède suppose que le serveur tourne sur ta machine, allumée
pendant que vos potes jouent. Un petit VPS (OVH, Scaleway, Hetzner…) enlève
cette contrainte : le bot et la file de memes tournent en continu, avec une
**adresse fixe** qui ne change plus jamais — plus de tunnel, plus d'adresse à
reposter dans Discord à chaque démarrage.

Grandes lignes (fichiers de départ dans [`deploy/`](deploy/)) :

1. **VPS + domaine** : le plus petit VPS Node-compatible suffit (LiveChat est
   très léger, il n'affiche rien lui-même). Pointe un sous-domaine dessus,
   par ex. `livechat.tondomaine.fr` (enregistrement DNS de type A vers l'IP
   du VPS).
2. **Node et le dépôt** : installe Node 18+ sur le VPS, clone ce dépôt dans
   `/opt/livechat`, copie ton `.env` (avec `AUTO_TUNNEL=none` — plus besoin de
   tunnel, nginx s'en charge), puis `npm install --omit=dev` (`--omit=dev`
   évite de télécharger Electron, inutile côté serveur).
3. **nginx + certbot** : [`deploy/nginx-livechat.conf`](deploy/nginx-livechat.conf)
   fait le relais HTTPS vers le port local du serveur (`8787` par défaut) —
   c'est lui qui expose le port 443, jamais le serveur Node directement.
   Génère le certificat avec `certbot certonly --nginx -d livechat.tondomaine.fr`
   avant d'activer le bloc HTTPS du fichier.
4. **systemd** : [`deploy/livechat.service`](deploy/livechat.service) garde le
   serveur en vie (redémarrage automatique en cas de plantage, démarrage au
   boot du VPS). Copie-le dans `/etc/systemd/system/`, puis
   `systemctl enable --now livechat`.
5. **Mises à jour** : [`deploy/update.sh`](deploy/update.sh) fait `git pull` +
   `npm install` + redémarre le service en une commande.

Une fois en place, l'adresse à donner à tes potes (et dans `SERVER_URL` côté
client) devient `wss://livechat.tondomaine.fr` — fixe, à ne plus jamais
retaper. `DISCORD_TOKEN` vit alors sur le VPS plutôt que sur ta machine : à
traiter avec les mêmes précautions (fichier `.env`, jamais commité).

---

## 5. Construire et distribuer le client

```bash
npm run dist
```

Produit un petit installeur dans `dist/` :

- `LiveChat-Setup-<version>.exe` — l'installeur, ~110 Mo (le runtime Electron,
  incompressible). Double-clic, installation silencieuse en quelques secondes
  dans `%LOCALAPPDATA%\Programs\LiveChat\` (pas besoin d'être admin), l'appli se
  lance toute seule à la fin.
- `latest.yml` et `LiveChat-Setup-<version>.exe.blockmap` — les fichiers dont la
  **mise à jour automatique** a besoin pour savoir qu'une nouvelle version
  existe. Sans eux, l'app continue de tourner mais ne se met jamais à jour.

Ce n'est plus un `.exe` portable : le passage à un vrai (petit) installeur est
ce qui rend possibles la mise à jour automatique et le démarrage avec Windows
— un portable s'auto-extrait dans un dossier temporaire différent à chaque
lancement, un chemin qui change tout le temps ne peut servir de point d'ancrage
à rien de durable.

### Distribution par GitHub Releases

```bash
git tag v2.0.0
git push origin v2.0.0
```

Sur la page GitHub du dépôt : **Releases > Draft a new release**, choisis le
tag, glisse **les trois fichiers** de `dist/` (le Setup, le `.yml`, le
`.blockmap`) dans les fichiers joints, publie. `package.json` pointe déjà vers
ce dépôt (`build.publish`), donc electron-updater sait où chercher sans rien
configurer de plus.

**Si tes potes ont déjà l'ancien `.exe` portable (v1.0.0)** : il n'a pas la
mise à jour automatique intégrée, elle ne peut pas se déclencher toute seule
pour eux. Ils doivent retélécharger et relancer une fois l'installeur
manuellement ; à partir de là, les mises à jour suivantes seront automatiques.

**Si tes potes ont une version « Le mur » installée (avant la v2.0.0)** : le
projet s'appelait encore comme ça. Le renommage en LiveChat change le dossier
d'installation et le dossier de configuration — comme pour le portable
ci-dessus, la mise à jour automatique ne peut pas migrer toute seule d'une
appli vers une autre. Chacun doit retélécharger et relancer l'installeur
`LiveChat-Setup-2.0.0.exe` une fois (l'ancienne « Le mur » peut être
désinstallée séparément, elle ne sera pas remplacée automatiquement), et
recoller l'adresse du serveur dans la fenêtre qui s'ouvre au premier
lancement. À partir de là, les mises à jour suivantes seront automatiques,
comme avant.

### Ce que voit un ami qui lance l'installeur

Rien à configurer à l'avance. Au premier lancement, une fenêtre demande
l'adresse du serveur — celle que tu leur as donnée dans Discord, en `wss://`.
Elle dit clairement si la connexion a réussi (et se ferme toute seule) ou si
ça bloque après plusieurs tentatives. Une fois validée, l'adresse est
mémorisée : les lancements suivants s'y connectent tout seuls.

L'icône dans la barre des tâches permet de changer d'adresse, de choisir
l'écran et la sortie audio, de couper le son, de passer un meme, d'activer le
démarrage avec Windows.

**Pour quitter, c'est par cette icône.** Il n'y a pas de fenêtre à fermer,
l'overlay est traversé par les clics — c'est le principe même d'un overlay.

---

## Utilisation (côté Discord, inchangée)

**Mode soirée (le principal)** : poste n'importe quoi dans `#livechat`.
Image, vidéo, lien direct, ou juste du texte. Plusieurs pièces jointes dans un
même message donnent plusieurs passages à l'écran.

**Commande** : `/meme` avec au moins une des trois options —
`fichier` (pièce jointe), `texte` (légende ou texte seul), `lien` (URL directe
vers une image ou une vidéo). Les trois vides : réponse d'erreur visible de toi
seul. La réponse du bot est toujours éphémère, pour ne pas polluer le salon.

Les `.mp4` et `.webm` sont joués en boucle **avec le son** pendant leur passage.
Le reste (`.png`, `.jpg`, `.gif`, `.webp`, `.avif`) en image. Un meme sans image
devient une affiche : plus le texte est court, plus il est gros.

**Les GIF du sélecteur Discord marchent aussi** (Klipy, Tenor, Giphy…). Leur lien
n'a pas d'extension — `https://klipy.com/gifs/greetings-PSr` ne dit pas à quel
fichier il correspond. C'est Discord qui le résout, une fraction de seconde après
l'envoi : le serveur attend cet embed (`EMBED_WAIT_MS`, 6 s par défaut) au lieu
d'afficher l'URL en toutes lettres. Aucun hébergeur n'est codé en dur, donc ceux
qui apparaîtront demain marcheront aussi.

Un lien qui ne donne rien au bout du délai est laissé de côté, avec un mot dans
la console. S'il y avait une phrase à côté du lien, c'est elle qui s'affiche.

Un GIF n'a pas de son : c'est normal, un GIF est muet par définition. Le son ne
concerne que les vraies vidéos.

## Le rythme

**Un meme à la fois**, sur tous les overlays connectés en même temps. Chacun a
l'écran pour lui, les autres attendent leur tour. Une rafale de huit images ne
repeint pas l'écran d'un bloc : ça défile. Le bot répond
`Dans la file, 3 devant toi.` quand ça bouchonne, et au-delà de `QUEUE_MAX`
memes en attente, les plus vieux sont abandonnés — sinon un plaisantin condamne
la soirée à regarder son dossier d'images pendant dix minutes. C'est le serveur
qui tient l'horloge : le rythme est identique pour tout le monde, quel que soit
le nombre de clients connectés.

**Les images et les textes** restent affichés `OVERLAY_DURATION_MS` (8 s par
défaut). **Les vidéos jouent leur durée réelle** : un clip de 3 s ne traîne pas
inutilement, un clip de 20 s n'est pas coupé au milieu. C'est lu directement
dans le fichier (la boîte `mvhd` d'un MP4, sans FFmpeg), plafonné à
`OVERLAY_VIDEO_MAX_MS` (60 s par défaut) pour qu'un pote ne puisse pas
monopoliser LiveChat avec un film entier. Si la durée ne peut pas être lue (une
poignée de formats particuliers, ou un souci réseau passager), la vidéo retombe
sur `OVERLAY_DURATION_MS` comme avant.

**Couper un meme trop long** : deux façons, équivalentes.

- Depuis l'appli — l'icône de la barre des tâches, **Passer ce meme**, ou le
  raccourci `Ctrl+Alt+M`. Marche pour n'importe qui a l'overlay ouvert.
- Depuis Discord — la commande `/passer`, utilisable par tout le monde dans le
  salon.

Les deux font la même chose : le meme s'efface tout de suite, sur tous les
écrans connectés, et le suivant dans la file prend le relais.

**En cas d'accroc réseau** (tunnel qui tousse, wifi qui coupe une seconde), un
client qui se reconnecte pendant qu'un meme est à l'écran le rattrape aussitôt,
avec le temps qu'il lui reste — pas un plein cycle qui le désynchroniserait des
autres. Le serveur détecte aussi les connexions mortes en ~15 s au lieu de
compter sur le système d'exploitation, qui peut mettre plusieurs minutes.

## Qui est connecté

La commande `/connectes` liste, depuis Discord, qui a son overlay ouvert en ce
moment et depuis combien de temps :

> **2 overlay(s) connecté(s) :**
> • **Dorian** — connecté depuis 12 min
> • **Alex** — connecté depuis 3 min

Chaque client s'identifie par son pseudo Windows par défaut — rien à
configurer. `OVERLAY_NAME` (variable du client) permet d'en choisir un autre,
plus parlant que le nom de session Windows.

## Choisir l'écran (par client)

Chacun choisit son propre écran, indépendamment des autres. Au démarrage, la
console liste les écrans détectés :

```
[livechat] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :
[livechat]   1. MAG 274Q X24 - 2560x1440 (principal)  <-- les memes s'affichent ici
[livechat]   2. MAG 274QF X24 - 1440x2560
```

`OVERLAY_DISPLAY` accepte `principal` (ou vide), un numéro, ou un bout du nom —
insensible à la casse et plus sûr qu'un numéro, qui change si Windows réordonne
les écrans. Le sous-menu **Afficher sur** de l'icône bascule à chaud, et ce
choix devient le nouvel écran « préféré ».

### Bascule automatique si tu es en plein écran ailleurs

Un jeu ou un film en **plein écran exclusif** empêche n'importe quelle fenêtre
(donc l'overlay) de se dessiner par-dessus — c'est une limite de Windows, déjà
documentée plus bas. Plutôt que de rater tous les memes pendant ce temps-là,
le client détecte ce cas et bascule tout seul sur l'autre écran, le temps que
ça dure.

Ça s'appuie sur `SHQueryUserNotificationState`, l'API Windows qui sert
normalement à couper les notifications pendant un jeu — un petit script
PowerShell interrogé toutes les 3 secondes, aucun module natif à compiler. La
détection exige plusieurs sondages d'affilée dans le même sens (~6 s) avant de
bouger, pour ignorer un état qui vacille, et un choix fait à la main dans le
sous-menu **Afficher sur** est respecté pendant 20 s avant que la bascule
automatique ne puisse le reprendre.

`OVERLAY_AUTO_SWITCH=off` désactive complètement le mécanisme ; la case
**Basculer seul si plein écran ailleurs** dans le sous-menu **Afficher sur**
fait pareil, en cours de soirée. N'a d'effet qu'avec au moins deux écrans
branchés — sans second écran, il n'y a nulle part où basculer.

## Choisir la sortie audio (par client)

Même logique pour le son : `OVERLAY_AUDIO_DEVICE` prend un bout du nom du
périphérique, listé au démarrage. Pratique avec une carte son à plusieurs
canaux (GoXLR, Voicemeeter) pour régler les memes indépendamment du jeu et du
micro. Le sous-menu **Sortie audio** de l'icône bascule à chaud, même pendant
qu'une vidéo joue. L'application demande la permission « média » à Chromium au
démarrage — c'est ce qui débloque le nom des périphériques ; elle n'ouvre jamais
le micro.

## Mise à jour automatique

Une fois installée (pas en portable — voir plus haut), l'appli vérifie la
dernière version publiée sur GitHub Releases 10 s après le démarrage, puis
toutes les 6 h si elle reste ouverte plusieurs jours. Si une nouvelle version
est trouvée, elle se télécharge en silence et s'installe au redémarrage
suivant de l'appli, sans rien demander.

`OVERLAY_AUTO_UPDATE=off` désactive la vérification. Ça ne concerne que le
client — le serveur (`src/server.js`) n'a pas de mécanisme de mise à jour, tu
le mets à jour toi-même avec `git pull`.

L'icône affiche la version installée (**Version x.y.z**, ligne grisée) et un
bouton **Vérifier les mises à jour...** pour forcer un contrôle immédiat sans
attendre le prochain cycle de 6h — utile si tu sais qu'une release vient de
sortir. Une notification Windows confirme dans tous les cas (déjà à jour,
mise à jour trouvée, ou vérification impossible).

## Démarrer avec Windows

L'icône propose une case **Démarrer avec Windows**, qui ajoute (ou retire)
l'appli du démarrage automatique de la session — via
`app.setLoginItemSettings`, la même mécanique que n'importe quelle appli
Windows légitime, sans dépendance de plus. Disponible uniquement sur une
version installée : en développement, il n'y a pas de chemin stable vers quoi
pointer.

## Configuration

### Serveur (`.env` sur la machine de l'hôte)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Token du bot. Requis. |
| `DISCORD_CLIENT_ID` | — | Application ID. Requis pour `npm run deploy`. |
| `DISCORD_GUILD_ID` | — | Facultatif. Enregistrement instantané de la commande sur ce serveur. |
| `PORT` | `8787` | Port d'écoute, celui que le tunnel expose. |
| `OVERLAY_DURATION_MS` | `8000` | Temps d'affichage d'un meme. |
| `OVERLAY_GAP_MS` | `500` | Respiration entre deux memes. |
| `QUEUE_MAX` | `40` | Taille max de la file d'attente. |
| `EMBED_WAIT_MS` | `6000` | Délai laissé à Discord pour résoudre le lien d'un GIF. |
| `OVERLAY_VIDEO_MAX_MS` | `60000` | Durée maximale d'une vidéo, même si elle dure plus longtemps. |

### Client (par machine qui affiche l'overlay)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SERVER_URL` | — | Adresse du serveur. Sinon demandée au premier lancement. |
| `OVERLAY_DISPLAY` | `principal` | Écran d'affichage : `principal`, un numéro, ou un bout du nom. |
| `OVERLAY_VOLUME` | `0.7` | Volume des vidéos, de 0 à 1. |
| `OVERLAY_AUDIO_DEVICE` | `defaut` | Sortie audio : `defaut`, ou un bout du nom du périphérique. |
| `OVERLAY_AUTO_SWITCH` | `on` | Bascule sur l'autre écran en cas de plein écran exclusif. `off` pour désactiver. |
| `OVERLAY_AUTO_UPDATE` | `on` | Vérifie les mises à jour tout seul (version installée uniquement). `off` pour désactiver. |
| `OVERLAY_NAME` | pseudo Windows | Nom affiché par `/connectes` côté Discord. |

Un ami qui lance l'installeur sans `.env` n'a besoin de rien de tout ça : la
fenêtre au premier lancement et les sous-menus de l'icône suffisent.

## Structure

```
src/server.js             bot Discord + file d'attente + serveur websocket
src/deploy-commands.js    enregistrement de /meme, a lancer a la main
src/client/main.js        fenetre overlay + connexion au serveur (le .exe)
src/client/preload.cjs    pont overlay <-> processus principal
src/client/overlay.html   ce qui s'affiche, autonome
src/client/config.html    fenetre de reglage de l'adresse du serveur
```

## Ça ne marche pas

**Rien n'apparaît quand je poste dans le salon** — l'intent MESSAGE CONTENT
n'est pas activé (voir 2.2), ou le salon ne s'appelle pas exactement
`livechat`, ou le bot n'y a pas accès.

**`/meme` n'existe pas dans Discord** — `npm run deploy` n'a pas été lancé, ou
`DISCORD_GUILD_ID` est vide et la commande globale n'est pas encore propagée.

**Le bot répond mais rien ne s'affiche chez un pote** — son client n'est pas
connecté au serveur. L'icône dans sa barre des tâches indique l'état
(« Connecté » / « Déconnecté... ») ; « Configurer le serveur » pour vérifier
l'adresse.

**Ça marchait, et plus rien depuis que j'ai relancé le tunnel** — l'adresse a
changé (normal, sur le plan gratuit). Renvoie la nouvelle dans Discord, chacun
la recolle dans « Configurer le serveur ».

**`LiveChat tourne déjà`** — une instance du client tourne déjà sur cette
machine. Son icône est dans la barre des tâches ; quitte-la depuis là avant
d'en relancer une.

**Aucune adresse postée dans Discord au démarrage du serveur** — regarde la
console : `[tunnel] cloudflared introuvable` veut dire qu'il faut l'installer
(`winget install --id Cloudflare.cloudflared`). `AUTO_TUNNEL=none` dans `.env`
désactive volontairement l'automatique. Si le tunnel a démarré mais que rien
n'est posté, vérifie que `#livechat` (ou `ANNOUNCE_CHANNEL`) existe bien et
que le bot y a accès.

**`/meme lien:` refuse mon lien de GIF** — l'option `lien` veut une URL qui finit
par `.jpg`, `.png`, `.gif`, `.webp`, `.mp4` ou `.webm`. Un lien du sélecteur GIF
n'en est pas un : poste-le directement dans `#livechat`.

**Un GIF s'affiche en texte** — le délai d'attente de l'embed a expiré avant que
Discord réponde. Monte `EMBED_WAIT_MS` côté serveur si la connexion traîne.

**Aucun son du tout** — vérifie « Sortie audio » dans le menu de l'icône, et que
« Couper le son » n'est pas actif.

**Les memes n'apparaissent jamais alors que je suis en plein écran** — c'est
peut-être un plein écran *exclusif* (voir plus haut) : normalement la bascule
automatique t'envoie sur l'autre écran, mais il en faut un second de branché,
et `OVERLAY_AUTO_SWITCH` ne doit pas être sur `off`. Sans second écran, il n'y
a nulle part où basculer — reste en plein écran fenêtré pour ce jeu-là.

**L'appli ne se met jamais à jour** — la mise à jour automatique ne marche que
sur une version installée (l'ancien `.exe` portable n'a pas ce mécanisme,
voir « Distribution par GitHub Releases » plus haut). Vérifie aussi que la
dernière release GitHub contient bien les trois fichiers (`Setup.exe`,
`.yml`, `.blockmap`), et que `OVERLAY_AUTO_UPDATE` n'est pas sur `off`.

**« Démarrer avec Windows » est grisée** — cette option n'a de sens que sur
une version installée ; en développement (`npm start`), il n'y a pas de
chemin stable vers quoi pointer.
