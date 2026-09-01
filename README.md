# Le mur

Les memes de la bande, en direct, **par-dessus ton écran**. Quelqu'un balance une
image sur Discord, elle s'affiche en grand au milieu de l'écran de ton choix,
huit secondes, puis disparaît. Pas d'OBS, pas de FFmpeg, pas de compte à créer.

Une seule application : le bot Discord et la fenêtre tournent dans le même
processus.

---

## 1. Installation

```bash
npm install
cp .env.example .env
```

`npm install` télécharge le binaire Electron, environ 250 Mo. C'est normal, ça
n'arrive qu'une fois, et rien n'est à installer chez les potes : c'est ta machine
qui affiche.

## 2. Côté Discord

### 2.1 Créer l'application et le bot

1. Va sur https://discord.com/developers/applications et clique **New Application**.
2. Onglet **General Information** : copie l'**Application ID** dans `DISCORD_CLIENT_ID` (fichier `.env`).
3. Onglet **Bot** : clique **Reset Token**, copie le token dans `DISCORD_TOKEN`.
   Ce token ne se réaffiche jamais, et il ne se commit nulle part.

### 2.2 Activer l'intent MESSAGE CONTENT — **obligatoire**

Toujours dans l'onglet **Bot**, section **Privileged Gateway Intents**, active
**MESSAGE CONTENT INTENT**, puis **Save Changes**.

C'est la cause numéro 1 de « ça marche pas ». Sans cet intent, le bot voit passer
les messages du salon mais leur contenu et leurs pièces jointes arrivent vides :
le mode automatique reste désespérément muet (la commande `/meme`, elle, continue
de marcher — ce qui rend le problème encore plus déroutant). Si l'application
refuse carrément de démarrer avec une erreur `Used disallowed intents`, c'est
exactement ça.

### 2.3 Récupérer l'ID du serveur (recommandé)

Dans Discord : **Paramètres utilisateur > Avancés > Mode développeur**, puis clic
droit sur ton serveur > **Copier l'identifiant**. Colle-le dans `DISCORD_GUILD_ID`.

- Rempli : `/meme` est enregistrée sur ce serveur et **disponible immédiatement**.
- Vide : la commande est enregistrée globalement, avec **jusqu'à une heure** de
  propagation avant d'apparaître.

### 2.4 Inviter le bot

Lance l'application une fois (`npm start`) : l'URL d'invitation est affichée dans
la console, construite depuis le client ID du bot. Ouvre-la, choisis ton serveur.

Les permissions demandées sont le minimum : voir les salons, lire l'historique,
répondre.

### 2.5 Créer le salon

Crée un salon texte nommé exactement **`mur-a-memes`**. Tout ce qui y est posté
part à l'écran, sans commande. Vérifie que le bot y a accès.

## 3. Enregistrer la commande slash

```bash
npm run deploy
```

À relancer seulement si tu changes la définition de la commande (ou si tu ajoutes
`DISCORD_GUILD_ID` après coup).

## 4. Lancer

```bash
npm start
```

Il n'y a pas de fenêtre à regarder : l'application vit dans la **barre des
tâches**, à côté de l'horloge. La fenêtre n'apparaît que quand un meme arrive,
et elle est traversée par les clics — tu peux continuer à jouer ou à bosser
pendant qu'un meme est affiché.

**Pour quitter, c'est par l'icône dans la barre des tâches.** Il n'y a pas de
croix à cliquer, c'est le principe même d'un overlay.

L'icône donne aussi : pause, passer le meme affiché, couper le son, et **choisir
l'écran**. Deux raccourcis globaux font le reste sans lâcher la souris :

- `Ctrl+Alt+M` — passe le meme affiché
- `Ctrl+Alt+P` — met la file en pause (les memes continuent de s'accumuler)

## Choisir l'écran

Par défaut les memes s'affichent sur l'écran principal. Si tu joues dessus, ce
n'est pas ce que tu veux : un meme en plein milieu d'une ranked, c'est vite
arrivé. Envoie-les sur ton deuxième écran.

Au démarrage, la console liste tes écrans numérotés :

```
[mur] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :
[mur]   1. MAG 274Q X24 — 2560x1440 (principal)  <-- les memes s'affichent ici
[mur]   2. MAG 274QF X24 — 1440x2560
```

`OVERLAY_DISPLAY` accepte trois formes :

- `principal` (ou vide) — l'écran principal.
- un numéro — `OVERLAY_DISPLAY=2`, celui de la liste ci-dessus.
- un bout du nom — `OVERLAY_DISPLAY=274QF`, insensible à la casse. **C'est le
  plus sûr** : un numéro change si Windows réordonne tes écrans, un nom non.
  Prends un fragment qui ne désigne qu'un seul écran (`274Q` correspondrait aussi
  bien à `MAG 274Q X24` qu'à `MAG 274QF X24`).

Si la valeur ne correspond à aucun écran, l'application ne reste pas muette :
elle prévient dans la console, liste les écrans disponibles et retombe sur le
principal.

**En cours de soirée**, le sous-menu **Afficher sur** de l'icône déplace
l'overlay tout de suite, sans redémarrer. Ce choix vaut pour la session ;
`OVERLAY_DISPLAY` est ce qui décide au prochain lancement.

Un écran débranché en cours de route ne casse rien : l'overlay revient sur le
réglage de `.env`.

---

## Utilisation

**Mode soirée (le principal)** : poste n'importe quoi dans `#mur-a-memes`.
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
l'envoi : l'application attend cet embed (`EMBED_WAIT_MS`, 6 s par défaut) au lieu
d'afficher l'URL en toutes lettres. Aucun hébergeur n'est codé en dur, donc ceux
qui apparaîtront demain marcheront aussi.

Un lien qui ne donne rien au bout du délai est laissé de côté, avec un mot dans
la console. S'il y avait une phrase à côté du lien, c'est elle qui s'affiche.

## Le rythme

**Un meme à la fois.** Chacun a l'écran pour lui pendant `OVERLAY_DURATION_MS`,
les autres attendent leur tour. Une rafale de huit images ne repeint pas l'écran
d'un bloc : ça défile. Le bot répond `Dans la file, 3 devant toi.` quand ça
bouchonne, et au-delà de `QUEUE_MAX` memes en attente, les plus vieux de la file
sont abandonnés — sinon un plaisantin condamne la soirée à regarder son dossier
d'images pendant dix minutes.

Il n'y a **pas d'historique**. Un meme passé est passé ; rien n'est gardé, rien
n'est rejouable. C'est le principe d'un overlay.

## Configuration

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Token du bot. Requis. |
| `DISCORD_CLIENT_ID` | — | Application ID. Requis pour `npm run deploy`. |
| `DISCORD_GUILD_ID` | — | Facultatif. Enregistrement instantané de la commande sur ce serveur. |
| `OVERLAY_DISPLAY` | `principal` | Écran d'affichage : `principal`, un numéro, ou un bout du nom. |
| `OVERLAY_DURATION_MS` | `8000` | Temps d'affichage d'un meme. |
| `OVERLAY_GAP_MS` | `500` | Respiration entre deux memes. |
| `OVERLAY_VOLUME` | `0.7` | Volume des vidéos, de 0 à 1. |
| `QUEUE_MAX` | `40` | Taille max de la file d'attente. |
| `EMBED_WAIT_MS` | `6000` | Délai laissé à Discord pour résoudre le lien d'un GIF. |

## Deux limites à connaître

**Jeu en plein écran exclusif : le meme ne s'affichera pas.** Aucune fenêtre ne
peut se dessiner par-dessus, c'est une limite de Windows et pas un bug de
l'application. En **plein écran fenêtré** (« borderless »), tout marche — c'est
le mode par défaut de la plupart des jeux aujourd'hui, et c'est comme ça que
l'overlay a été vérifié, par-dessus une partie en cours. Si rien n'apparaît
pendant que tu joues, c'est le premier réglage à changer dans le jeu.

**Écran noir à la place de la transparence.** Sur certaines configurations
graphiques, une fenêtre transparente se peint en noir. Le contournement est
`app.disableHardwareAcceleration()` en tête de `src/main.js` — il n'est pas
activé par défaut parce qu'il dégrade la lecture des vidéos.

## Structure

```
src/main.js             la fenêtre overlay, le bot Discord et la file d'attente
src/preload.cjs         le pont entre le processus principal et la fenêtre
src/overlay.html        ce qui s'affiche, autonome
src/deploy-commands.js  enregistrement de /meme, à lancer à la main
```

## Ça ne marche pas

**Rien n'apparaît quand je poste dans le salon** — l'intent MESSAGE CONTENT n'est
pas activé (voir 2.2), ou le salon ne s'appelle pas exactement `mur-a-memes`, ou
le bot n'y a pas accès.

**`/meme` n'existe pas dans Discord** — `npm run deploy` n'a pas été lancé, ou
`DISCORD_GUILD_ID` est vide et la commande globale n'est pas encore propagée.

**Le bot répond mais rien ne s'affiche** — regarde la console : chaque meme
accepté y est logué. Si la ligne apparaît, c'est l'affichage : le meme part sur
un autre écran (voir « Choisir l'écran »), jeu en plein écran exclusif (voir plus
haut), ou file en pause (`Ctrl+Alt+P` pour reprendre).

**Les memes tombent sur le mauvais écran** — la console dit au démarrage lequel
est choisi, avec la liste numérotée. Si `OVERLAY_DISPLAY` est un numéro et que tu
as rebranché tes écrans, la numérotation a pu changer : passe à un bout du nom de
l'écran, qui ne bouge pas.

**`Le mur tourne déjà`** — une instance précédente n'a pas été fermée. Son icône
est dans la barre des tâches ; quitte-la depuis là.

**`/meme lien:` refuse mon lien de GIF** — l'option `lien` veut une URL qui finit
par `.jpg`, `.png`, `.gif`, `.webp`, `.mp4` ou `.webm`. Un lien du sélecteur GIF
n'en est pas un : poste-le directement dans `#mur-a-memes`, c'est là que Discord
le résout.

**Un GIF s'affiche en texte** — le délai d'attente de l'embed a expiré avant que
Discord réponde. Monte `EMBED_WAIT_MS` si ta connexion traîne.
