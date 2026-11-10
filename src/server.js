import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { WebSocketServer } from 'ws';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

import { creerGestionnaireInteractions } from './commandes.js';
import { creerFile } from './file-memes.js';
import { dureeVideoMs } from './medias.js';
import { creerLecteurMessages } from './messages.js';
import { estSalon, salonsNommes } from './salons.js';
import { creerTunnel } from './tunnel.js';

const WALL_CHANNEL = 'livechat';

/** Lit un reglage numerique, en gueulant plutot qu'en avalant une valeur bancale. */
function reglage(nom, defaut, { min = 0, max = Infinity } = {}) {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === '') return defaut;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur < min || valeur > max) {
    console.warn(`[livechat] ${nom} invalide ("${brut}") : on retombe sur ${defaut}.`);
    return defaut;
  }
  return valeur;
}

const PORT = reglage('PORT', 8787, { min: 1 });

// Temps d'affichage d'un meme, puis la respiration avant le suivant. C'est le
// serveur qui tient l'horloge : tous les overlays connectes suivent le meme
// rythme, quel que soit le nombre de spectateurs.
const DUREE_MS = reglage('OVERLAY_DURATION_MS', 5000, { min: 500 });
const GAP_MS = reglage('OVERLAY_GAP_MS', 500);
const FILE_MAX = reglage('QUEUE_MAX', 40, { min: 1 });

// Combien de temps on laisse a Discord pour resoudre l'embed d'un lien.
const ATTENTE_EMBED_MS = reglage('EMBED_WAIT_MS', 6000, { min: 500 });

// Une video joue sa duree reelle plutot qu'un temps fixe : un clip de 3s ne
// traine pas 8s, un clip de 20s n'est pas coupe au milieu. Ce plafond evite
// qu'un film entier ne monopolise LiveChat.
const DUREE_VIDEO_MAX_MS = reglage('OVERLAY_VIDEO_MAX_MS', 60000, { min: 1000 });

// 'cloudflare' : un tunnel s'ouvre tout seul au demarrage et son adresse est
// postee dans Discord. 'none' : rien d'automatique, expose le port toi-meme.
const MODE_TUNNEL = (process.env.AUTO_TUNNEL ?? 'cloudflare').trim().toLowerCase();

// Salon ou l'adresse du tunnel est annoncee. Par defaut, le meme que celui
// qui recoit les memes.
const SALON_ANNONCE = (process.env.ANNOUNCE_CHANNEL ?? '').trim() || WALL_CHANNEL;

/** Les salons de ce nom ou le bot peut ecrire (DISCORD_GUILD_ID respecte). */
const salons = (nom) => salonsNommes(client.channels.cache.values(), nom, process.env.DISCORD_GUILD_ID);

// --------------------------------------------------------------------------
// Les bannis de LiveChat (voir /bannir dans commandes.js), gardes d'un
// redemarrage a l'autre.
// --------------------------------------------------------------------------

const BANNIS_PATH = path.join(process.cwd(), '.livechat-bannis.json');

/** @type {Set<string>} Identifiants Discord prives de LiveChat. */
const bannis = new Set(lireBannis());

function lireBannis() {
  try {
    const brut = JSON.parse(fs.readFileSync(BANNIS_PATH, 'utf8'));
    return Array.isArray(brut) ? brut : [];
  } catch {
    return [];
  }
}

function ecrireBannis() {
  try {
    fs.writeFileSync(BANNIS_PATH, JSON.stringify([...bannis], null, 2));
  } catch (erreur) {
    console.warn('[livechat] Impossible de sauvegarder la liste des bannis :', erreur.message);
  }
}

// La file vit dans son propre module : elle ne sait rien de Discord ni des
// websockets, on lui passe juste de quoi diffuser et mesurer une video.
const file = creerFile({
  dureeMs: DUREE_MS,
  gapMs: GAP_MS,
  max: FILE_MAX,
  dureeVideoMs: (url) => dureeVideoMs(url, DUREE_VIDEO_MAX_MS),
  diffuser: (message) => diffuser(message),
  surChangement: () => actualiserMessageControle(),
});

/** Le message Discord qui porte le bouton "Passer" du meme actuellement affiche. */
let messageControle = null;

/**
 * Poste (ou remplace) le message Discord public qui porte le bouton "Passer"
 * du meme actuellement affiche. Gere les trois transitions (rien->meme,
 * meme->meme, meme->rien) en un seul endroit : un seul message est reutilise
 * (edite en place) tant que la file tourne, pour ne pas spammer le salon
 * d'un nouveau message a chaque meme ; il n'est supprime que lorsqu'il n'y a
 * plus rien a l'ecran.
 */
async function actualiserMessageControle() {
  const actuel = file.memeEnCours();
  if (!actuel) {
    if (messageControle) {
      const ancien = messageControle;
      messageControle = null;
      try {
        await ancien.delete();
      } catch {
        // Deja supprime (par un humain, ou une purge Discord) : tant pis.
      }
    }
    return;
  }

  const contenu = `**${actuel.meme.author.name}** est à l'écran.`;
  const composants = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`passer:${actuel.meme.id}`)
        .setLabel('Passer')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (messageControle) {
    try {
      await messageControle.edit({ content: contenu, components: composants });
      return;
    } catch {
      messageControle = null; // supprime entretemps : on retombe sur un envoi neuf
    }
  }

  const [salon] = salons(WALL_CHANNEL);
  if (!salon) return;

  try {
    messageControle = await salon.send({ content: contenu, components: composants });
  } catch (erreur) {
    console.warn('[livechat] Bouton Passer : envoi impossible :', erreur.message);
  }
}

// --------------------------------------------------------------------------
// Diffusion : un serveur websocket, un client par overlay connecte (le tien,
// et ceux de tes potes via le tunnel).
// --------------------------------------------------------------------------

const serveurHttp = http.createServer((_req, res) => {
  // Sert de point de sante : verifier que le tunnel atteint bien le serveur.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, overlays: wss?.clients.size ?? 0 }));
});

const wss = new WebSocketServer({ server: serveurHttp });

function diffuser(message) {
  const donnees = JSON.stringify(message);
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) socket.send(donnees);
  }
}

/** Tire un pseudo present dans l'URL de connexion (?pseudo=...), sinon 'anonyme'. */
function pseudoDepuisUrl(url) {
  try {
    const brut = new URL(url, 'http://x').searchParams.get('pseudo');
    const propre = (brut ?? '').trim().slice(0, 32);
    return propre || 'anonyme';
  } catch {
    return 'anonyme';
  }
}

wss.on('connection', (socket, requete) => {
  const adresse = requete.socket.remoteAddress;
  socket.pseudo = pseudoDepuisUrl(requete.url);
  socket.connecteDepuis = Date.now();
  console.log(
    `[livechat] Overlay connecte : ${socket.pseudo} (${adresse}). ${wss.clients.size} au total.`,
  );

  // Rattrapage : qui se connecte (ou se reconnecte apres un accroc reseau)
  // pendant qu'un meme est deja a l'ecran le recoit tout de suite, avec le
  // temps qu'il lui reste plutot qu'une duree pleine qui le desynchroniserait
  // des autres.
  const actuel = file.memeEnCours();
  if (actuel && actuel.restant > 300) {
    socket.send(JSON.stringify({ type: 'meme', meme: { ...actuel.meme, duree: actuel.restant } }));
  }

  // Le protocole websocket repond tout seul aux ping : ca sert surtout au
  // serveur a reperer une connexion morte sans attendre le timeout TCP, qui
  // peut prendre plusieurs minutes derriere un tunnel.
  socket.estVivant = true;
  socket.on('pong', () => {
    socket.estVivant = true;
  });

  socket.on('close', () => {
    console.log(`[livechat] Overlay deconnecte : ${socket.pseudo}. ${wss.clients.size} restant(s).`);
  });

  // Seul message qu'un client envoie : la demande de passer le meme affiche.
  socket.on('message', (donnees) => {
    let message;
    try {
      message = JSON.parse(donnees);
    } catch {
      return;
    }
    if (message?.type === 'passer') {
      console.log(`[livechat] Passer demande depuis l'overlay (${adresse}).`);
      file.passer();
    }
  });
});

setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.estVivant === false) {
      socket.terminate();
      continue;
    }
    socket.estVivant = false;
    socket.ping();
  }
}, 15000).unref();

const tunnel = creerTunnel({
  port: PORT,
  adresseFixe: (process.env.PUBLIC_URL ?? '').trim(),
  mode: MODE_TUNNEL,
  nomSalon: SALON_ANNONCE,
  salonsAnnonce: () => salons(SALON_ANNONCE),
});

serveurHttp.listen(PORT, () => {
  console.log(`[livechat] Serveur pret sur le port ${PORT}.`);
  console.log(
    `[livechat] Overlay local : lance le client avec SERVER_URL=ws://localhost:${PORT}`,
  );
  tunnel.demarrer();
});

// --------------------------------------------------------------------------
// Bot Discord
// --------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Necessite l'intent privilegie MESSAGE CONTENT active dans le portail Discord.
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async (ready) => {
  console.log(`[bot] Connecte en tant que ${ready.user.tag}`);
  const invite =
    `https://discord.com/api/oauth2/authorize?client_id=${ready.user.id}` +
    '&permissions=68608&scope=bot%20applications.commands';
  console.log(`[bot] Invitation : ${invite}`);
  console.log(`[bot] Salon ecoute automatiquement : #${WALL_CHANNEL}`);

  // Le pseudo du bot ne suit pas le renommage du projet tout seul : on le
  // met a jour ici, une bonne fois, plutot que de demander un geste manuel
  // dans le portail Discord a chaque redemarrage (ne fait rien une fois que
  // c'est deja bon).
  if (ready.user.username !== 'LiveChat') {
    try {
      await ready.user.setUsername('LiveChat');
      console.log('[bot] Renomme en LiveChat.');
    } catch (erreur) {
      console.warn('[bot] Renommage du bot impossible :', erreur.message);
    }
  }

  tunnel.surBotPret();
});

client.on(
  Events.InteractionCreate,
  creerGestionnaireInteractions({
    file,
    overlays: () => [...wss.clients].filter((s) => s.readyState === s.OPEN),
    bannis,
    sauverBannis: ecrireBannis,
    nomSalon: WALL_CHANNEL,
  }),
);

const lecteur = creerLecteurMessages({
  enfiler: (meme) => file.enfiler(meme),
  attenteEmbedMs: ATTENTE_EMBED_MS,
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // sinon, boucle
  if (!estSalon(message.channel, WALL_CHANNEL)) return; // "📡┃livechat" compte aussi
  if (bannis.has(message.author.id)) return; // banni de LiveChat : le message reste dans Discord, mais ne passe pas a l'ecran
  lecteur.traiter(message);
});

client.on(Events.MessageUpdate, async (_avant, apres) => {
  if (!lecteur.attend(apres?.id)) return;
  const message = apres.partial ? await apres.fetch().catch(() => null) : apres;
  if (message) lecteur.resoudreEmbed(message);
});

// --------------------------------------------------------------------------
// Commandes console : utile quand le serveur tourne sans l'overlay a cote,
// par exemple sur ta machine pendant que tes potes recoivent le flux.
// --------------------------------------------------------------------------

process.stdin.setEncoding('utf8');
process.stdin.on('data', (ligne) => {
  const mot = ligne.trim().toLowerCase();
  if (mot === 'pause') file.basculerPause();
  else if (mot === 'passer') file.passer();
});

if (!process.env.DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN absent : le serveur tourne, mais rien ne viendra le remplir.');
  console.error('[bot] Copie .env.example vers .env et remplis-le.');
} else {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('[bot] Connexion impossible :', error.message);
    console.error("[bot] Verifie DISCORD_TOKEN, et que l'intent MESSAGE CONTENT est active.");
  });
}

function arreter() {
  console.log('\n[livechat] Arret.');
  tunnel.arreter();
  client.destroy().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', arreter);
// systemd arrete le service avec SIGTERM : sans ce second gestionnaire, on
// mourait sans tuer cloudflared, qui restait a trainer apres un redemarrage.
process.on('SIGTERM', arreter);
