# Le mur

Un mur de memes en direct pour une bande de potes. Quelqu'un balance une image
sur Discord, elle apparait dans la seconde sur une page web ouverte chez tout le
monde. Pas d'OBS, pas de FFmpeg, pas de compte a creer.

Un seul process : le bot Discord et le serveur web tournent ensemble.

---

## 1. Installation

```bash
npm install
cp .env.example .env
```

Il faut Node 18 ou plus.

## 2. Cote Discord

### 2.1 Creer l'application et le bot

1. Va sur https://discord.com/developers/applications et clique **New Application**.
2. Onglet **General Information** : copie l'**Application ID** dans `DISCORD_CLIENT_ID` (fichier `.env`).
3. Onglet **Bot** : clique **Reset Token**, copie le token dans `DISCORD_TOKEN`.
   Ce token ne se reaffiche jamais, et il ne se commit nulle part.

### 2.2 Activer l'intent MESSAGE CONTENT — **obligatoire**

Toujours dans l'onglet **Bot**, section **Privileged Gateway Intents**, active
**MESSAGE CONTENT INTENT**, puis **Save Changes**.

C'est la cause numero 1 de "ca marche pas". Sans cet intent, le bot voit passer
les messages du salon mais leur contenu et leurs pieces jointes arrivent vides :
le mode automatique reste desesperement muet (la commande `/meme`, elle,
continue de marcher — ce qui rend le probleme encore plus deroutant).
Si le bot refuse carrement de demarrer avec une erreur `Used disallowed intents`,
c'est exactement ca.

### 2.3 Recuperer l'ID du serveur (recommande)

Dans Discord : **Parametres utilisateur > Avances > Mode developpeur**, puis clic
droit sur ton serveur > **Copier l'identifiant**. Colle-le dans `DISCORD_GUILD_ID`.

- Rempli : `/meme` est enregistree sur ce serveur et **disponible immediatement**.
- Vide : la commande est enregistree globalement, avec **jusqu'a une heure** de
  propagation avant d'apparaitre.

### 2.4 Inviter le bot

Lance le serveur une fois (`npm start`) : l'URL d'invitation est affichee dans la
console, construite depuis le client ID du bot. Ouvre-la, choisis ton serveur.

Les permissions demandees sont le minimum : voir les salons, lire l'historique,
repondre.

### 2.5 Creer le salon

Cree un salon texte nomme exactement **`mur-a-memes`**. Tout ce qui y est poste
part sur le mur, sans commande. Verifie que le bot y a acces.

## 3. Enregistrer la commande slash

```bash
npm run deploy
```

A relancer seulement si tu changes la definition de la commande (ou si tu
ajoutes `DISCORD_GUILD_ID` apres coup).

## 4. Lancer

```bash
npm start
```

Puis ouvre http://localhost:3000.

---

## Utilisation

**Mode soiree (le principal)** : poste n'importe quoi dans `#mur-a-memes`.
Image, video, lien direct, ou juste du texte. Plusieurs pieces jointes dans un
meme message donnent plusieurs feuilles sur le mur.

**Commande** : `/meme` avec au moins une des trois options —
`fichier` (piece jointe), `texte` (legende ou texte seul), `lien` (URL directe
vers une image ou une video). Les trois vides : reponse d'erreur visible de toi
seul. La reponse du bot est toujours ephemere, pour ne pas polluer le salon.

Les `.mp4` et `.webm` sont rendus en `<video>` autoplay, en boucle, sans son.
Le reste (`.png`, `.jpg`, `.gif`, `.webp`, `.avif`) en image.

## Le rythme du mur

Trois choses reglent ce qu'on voit, et elles sont toutes reglables dans `.env`.

**La file d'attente.** Les memes se collent **un par un**, au plus un toutes les
`MEME_INTERVAL_MS` (1,5 s par defaut). Quelqu'un qui balance huit images d'un
coup ne repeint pas le mur d'un bloc : ca defile, et chaque feuille a son moment.
Le bot repond `Dans la file, 3 devant toi.` quand ca bouchonne. Au-dela de
`QUEUE_MAX` memes en attente, les plus vieux de la file sont abandonnes — sinon
un plaisantin condamne la soiree a regarder son dossier d'images pendant dix
minutes.

**La taille du mur.** `HISTORY_SIZE` feuilles au maximum (12 par defaut). Quand
une nouvelle arrive sur un mur plein, la plus ancienne se decolle.

**La duree de vie.** Passe `MEME_TTL_MINUTES` (30 par defaut), une feuille se
decolle toute seule, chez tout le monde en meme temps, meme si le mur est loin
d'etre plein. `MEME_TTL_MINUTES=0` desactive la limite de temps : un meme reste
alors jusqu'a ce que les suivants le poussent dehors.

Le mur affiche exactement le meme etat pour tout le monde : celui qui ouvre la
page a 3h du matin voit les memes feuilles que celui qui n'a jamais ferme
l'onglet.

## Configuration

| Variable | Defaut | Role |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Token du bot. Requis. |
| `DISCORD_CLIENT_ID` | — | Application ID. Requis pour `npm run deploy`. |
| `DISCORD_GUILD_ID` | — | Facultatif. Enregistrement instantane de la commande sur ce serveur. |
| `PORT` | `3000` | Port de la page du mur. |
| `HISTORY_SIZE` | `12` | Feuilles au mur, et rattrapage envoye aux retardataires. |
| `MEME_TTL_MINUTES` | `30` | Duree de vie d'une feuille. `0` = pas de limite de temps. |
| `MEME_INTERVAL_MS` | `1500` | Delai minimum entre deux memes qui se collent. |
| `QUEUE_MAX` | `40` | Taille max de la file d'attente. |

## Ce que le mur ne fait pas

Il n'y a pas de base de donnees. Tout vit dans un tableau en memoire ; un
redemarrage efface le mur. C'est voulu : c'est ephemere.

Le mur n'a aucune authentification. Qui a l'URL voit le mur. Pour une soiree
entre potes c'est le but ; ne le mets pas sur une URL devinable si le contenu te
gene.

---

## Montrer le mur aux potes

Le mur a besoin de **WebSockets** : n'importe quel hebergement qui ne les
supporte pas ne marchera pas.

### Le temps d'une soiree

Laisse tourner `npm start` sur ta machine, et ouvre un tunnel :

```bash
npx localtunnel --port 3000
```

ou, si tu preferes ngrok :

```bash
ngrok http 3000
```

Les deux relaient les WebSockets sans configuration. L'URL donnee est a envoyer
aux potes ; elle meurt quand tu fermes le tunnel. Localtunnel affiche parfois une
page d'avertissement au premier chargement — il faut cliquer pour passer.

### En permanence

**Railway** : connecte le depot, ajoute les variables d'environnement,
`npm start` est detecte tout seul. WebSockets supportes par defaut.

**Fly.io** : `fly launch` puis `fly deploy`. Passe les secrets avec
`fly secrets set DISCORD_TOKEN=... DISCORD_CLIENT_ID=...`. Dans `fly.toml`,
garde `force_https` et laisse `auto_stop_machines` a `false` — une machine qui
s'endort coupe le bot et vide l'historique.

Dans les deux cas, ne fixe pas `PORT` a la main : la plateforme l'injecte.

## Structure

```
src/index.js             serveur web + bot Discord, un seul process
src/deploy-commands.js   enregistrement de /meme, a lancer a la main
src/public/index.html    la page du mur, autonome
.env.example
```

## Ca ne marche pas

**Rien n'apparait quand je poste dans le salon** — l'intent MESSAGE CONTENT
n'est pas active (voir 2.2), ou le salon ne s'appelle pas exactement
`mur-a-memes`, ou le bot n'a pas acces au salon.

**`/meme` n'existe pas dans Discord** — `npm run deploy` n'a pas ete lance, ou
`DISCORD_GUILD_ID` est vide et la commande globale n'est pas encore propagee.

**La page reste vide meme apres un meme envoye** — regarde la console du
serveur : chaque meme accepte y est logue. Si la ligne apparait mais pas le mur,
c'est le WebSocket qui ne passe pas (proxy ou hebergement sans support WS).

**Le bot repond `Ce lien ne ressemble pas a une image`** — `lien` doit pointer
directement sur le fichier (l'URL finit par `.jpg`, `.png`, `.gif`, `.webp`,
`.mp4`, `.webm`), pas sur une page qui contient l'image.
