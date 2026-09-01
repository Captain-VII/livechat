import 'dotenv/config';
import path from 'node:path';
import http from 'node:http';

import { WebSocketServer } from 'ws';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';

const WALL_CHANNEL = 'mur-a-memes';

/** Lit un reglage numerique, en gueulant plutot qu'en avalant une valeur bancale. */
function reglage(nom, defaut, { min = 0, max = Infinity } = {}) {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === '') return defaut;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur < min || valeur > max) {
    console.warn(`[mur] ${nom} invalide ("${brut}") : on retombe sur ${defaut}.`);
    return defaut;
  }
  return valeur;
}

const PORT = reglage('PORT', 8787, { min: 1 });

// Temps d'affichage d'un meme, puis la respiration avant le suivant. C'est le
// serveur qui tient l'horloge : tous les overlays connectes suivent le meme
// rythme, quel que soit le nombre de spectateurs.
const DUREE_MS = reglage('OVERLAY_DURATION_MS', 8000, { min: 500 });
const GAP_MS = reglage('OVERLAY_GAP_MS', 500);
const FILE_MAX = reglage('QUEUE_MAX', 40, { min: 1 });

// Combien de temps on laisse a Discord pour resoudre l'embed d'un lien.
const ATTENTE_EMBED_MS = reglage('EMBED_WAIT_MS', 6000, { min: 500 });

const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

// --------------------------------------------------------------------------
// La file : les memes passent un par un, chacun son moment a l'ecran.
// --------------------------------------------------------------------------

/** @type {Array<object>} Memes acceptes, pas encore diffuses. */
const file = [];

let nextId = 1;
let minuteur = null;
let enPause = false;

/**
 * Met un meme dans la file. Renvoie le nombre de memes devant lui.
 * Rien n'est fige ici : id et rotation sont decides au moment ou le meme est
 * vraiment diffuse.
 */
function enfiler(meme) {
  const devant = file.length;
  file.push(meme);

  if (file.length > FILE_MAX) {
    file.shift();
    console.warn('[mur] File pleine : le plus vieux meme en attente est passe a la trappe.');
  }

  relancer();
  return devant;
}

/** Reveille la file si elle dort. */
function relancer() {
  if (minuteur || enPause || file.length === 0) return;
  minuteur = setTimeout(defiler, 0);
}

function defiler() {
  minuteur = null;
  if (enPause) return;

  const meme = file.shift();
  if (!meme) {
    diffuser({ type: 'retrait' });
    return;
  }

  const feuille = {
    id: nextId++,
    // Une legere rotation, decidee ici pour que tous les overlays soient d'accord.
    rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
    duree: DUREE_MS,
    ...meme,
  };

  diffuser({ type: 'meme', meme: feuille });
  console.log(`[mur] ${feuille.author.name} -> ${feuille.mediaUrl ?? feuille.text ?? ''}`);
  minuteur = setTimeout(defiler, DUREE_MS + GAP_MS);
}

function passer() {
  if (minuteur) clearTimeout(minuteur);
  minuteur = null;
  diffuser({ type: 'retrait' });
  relancer();
}

function basculerPause() {
  enPause = !enPause;
  if (enPause) {
    if (minuteur) clearTimeout(minuteur);
    minuteur = null;
  } else {
    relancer();
  }
  console.log(`[mur] ${enPause ? 'En pause.' : 'Reprise.'} ${file.length} en attente.`);
}

// --------------------------------------------------------------------------
// Detection du type de media a partir de l'extension de l'URL
// --------------------------------------------------------------------------

function extensionOf(url) {
  try {
    // Les CDN Discord collent des query params signes : on ne garde que le chemin.
    return path.extname(new URL(url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

function mediaTypeOf(url, contentType) {
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('image/')) return 'image';

  const ext = extensionOf(url);
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return null;
}

function urlsDe(texte) {
  return texte?.match(/https?:\/\/\S+/gi) ?? [];
}

/** Premiere URL du texte qui pointe directement sur une image ou une video. */
function findMediaUrl(text) {
  return urlsDe(text).find((url) => mediaTypeOf(url) !== null) ?? null;
}

/**
 * Cherche un media dans les embeds resolus par Discord. C'est par la qu'arrivent
 * les GIF des selecteurs integres (Klipy, Tenor, Giphy...) : leur lien n'a pas
 * d'extension, seul Discord sait a quel fichier il correspond. On ne code donc
 * aucune liste d'hebergeurs, on lit ce que Discord a trouve.
 */
function mediaDesEmbeds(embeds) {
  for (const embed of embeds ?? []) {
    for (const url of [embed.video?.url, embed.image?.url, embed.thumbnail?.url]) {
      const mediaType = url ? mediaTypeOf(url) : null;
      if (mediaType) return { mediaUrl: url, mediaType };
    }
  }
  return null;
}

function authorOf(user, member) {
  // member peut arriver brut de l'API (pas un GuildMember) : on retombe sur user.
  const isGuildMember = typeof member?.displayAvatarURL === 'function';
  return {
    name: (isGuildMember ? member.displayName : null) ?? user.globalName ?? user.username,
    avatar: (isGuildMember ? member : user).displayAvatarURL({ extension: 'png', size: 128 }),
  };
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

wss.on('connection', (socket, requete) => {
  const adresse = requete.socket.remoteAddress;
  console.log(`[mur] Overlay connecte (${adresse}). ${wss.clients.size} au total.`);
  socket.on('close', () => {
    console.log(`[mur] Overlay deconnecte. ${wss.clients.size} restant(s).`);
  });
});

serveurHttp.listen(PORT, () => {
  console.log(`[mur] Serveur pret sur le port ${PORT}.`);
  console.log(
    `[mur] Overlay local : lance le client avec SERVER_URL=ws://localhost:${PORT}`,
  );
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

client.once(Events.ClientReady, (ready) => {
  console.log(`[bot] Connecte en tant que ${ready.user.tag}`);
  const invite =
    `https://discord.com/api/oauth2/authorize?client_id=${ready.user.id}` +
    '&permissions=68608&scope=bot%20applications.commands';
  console.log(`[bot] Invitation : ${invite}`);
  console.log(`[bot] Salon ecoute automatiquement : #${WALL_CHANNEL}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'meme') return;

  const fichier = interaction.options.getAttachment('fichier');
  const texte = interaction.options.getString('texte');
  const lien = interaction.options.getString('lien');

  if (!fichier && !texte && !lien) {
    await interaction.reply({
      content: 'Il me faut au moins un `fichier`, un `texte` ou un `lien`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mediaUrl = fichier?.url ?? lien ?? null;
  const mediaType = mediaUrl ? mediaTypeOf(mediaUrl, fichier?.contentType) : null;

  if (mediaUrl && !mediaType) {
    await interaction.reply({
      content:
        'Ce lien ne pointe pas directement sur un fichier (jpg, png, gif, webp, mp4, webm).\n' +
        `Pour un GIF du selecteur Discord, poste-le directement dans #${WALL_CHANNEL} : ` +
        'la, Discord resout le lien tout seul.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const devant = enfiler({
    author: authorOf(interaction.user, interaction.member),
    text: texte ?? null,
    mediaUrl,
    mediaType,
  });

  await interaction.reply({
    content: devant === 0 ? "A l'ecran." : `Dans la file, ${devant} devant toi.`,
    flags: MessageFlags.Ephemeral,
  });
});

/**
 * Messages dont on attend encore l'embed de Discord.
 * @type {Map<string, { author: object, text: string|null, minuteur: NodeJS.Timeout }>}
 */
const attenteEmbed = new Map();

function traiterMessage(message) {
  const author = authorOf(message.author, message.member);
  const attachments = [...message.attachments.values()].filter(
    (a) => mediaTypeOf(a.url, a.contentType) !== null,
  );

  if (attachments.length > 0) {
    // La legende accompagne la premiere piece jointe seulement.
    attachments.forEach((attachment, index) => {
      enfiler({
        author,
        text: index === 0 ? message.content || null : null,
        mediaUrl: attachment.url,
        mediaType: mediaTypeOf(attachment.url, attachment.contentType),
      });
    });
    return;
  }

  const mediaUrl = findMediaUrl(message.content);
  if (mediaUrl) {
    enfiler({
      author,
      text: message.content.replace(mediaUrl, '').trim() || null,
      mediaUrl,
      mediaType: mediaTypeOf(mediaUrl),
    });
    return;
  }

  // Parfois Discord a deja resolu l'embed quand le message nous parvient.
  const media = mediaDesEmbeds(message.embeds);
  const liens = urlsDe(message.content);
  const texteSeul = liens.reduce((t, l) => t.replace(l, ''), message.content).trim() || null;

  if (media) {
    enfiler({ author, text: texteSeul, ...media });
    return;
  }

  if (liens.length > 0) {
    // Un lien de GIF n'a pas d'extension : c'est Discord qui dira a quoi il
    // correspond, une fraction de seconde plus tard. On patiente plutot que
    // d'afficher l'URL en toutes lettres.
    patienter(message, author, texteSeul);
    return;
  }

  if (message.content.trim()) {
    enfiler({ author, text: message.content.trim(), mediaUrl: null, mediaType: null });
  }
}

/** Met un message de cote le temps que Discord lui attache son embed. */
function patienter(message, author, text) {
  if (attenteEmbed.has(message.id)) return;

  const minuteur = setTimeout(() => {
    attenteEmbed.delete(message.id);
    if (text) {
      // Le lien n'a rien donne, mais il y avait autre chose a dire.
      enfiler({ author, text, mediaUrl: null, mediaType: null });
    } else {
      console.warn(`[mur] Lien sans media utilisable, laisse de cote : ${message.content.trim()}`);
    }
  }, ATTENTE_EMBED_MS);

  attenteEmbed.set(message.id, { author, text, minuteur });
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // sinon, boucle
  if (message.channel?.name !== WALL_CHANNEL) return;
  traiterMessage(message);
});

/** L'embed arrive apres coup : c'est ici que les GIF finissent par tomber. */
function resoudreEmbed(message) {
  const attente = attenteEmbed.get(message?.id);
  if (!attente) return;

  const media = mediaDesEmbeds(message.embeds);
  if (!media) return;

  clearTimeout(attente.minuteur);
  attenteEmbed.delete(message.id);
  enfiler({ author: attente.author, text: attente.text, ...media });
}

client.on(Events.MessageUpdate, async (_avant, apres) => {
  if (!attenteEmbed.has(apres?.id)) return;
  const message = apres.partial ? await apres.fetch().catch(() => null) : apres;
  if (message) resoudreEmbed(message);
});

// --------------------------------------------------------------------------
// Commandes console : utile quand le serveur tourne sans l'overlay a cote,
// par exemple sur ta machine pendant que tes potes recoivent le flux.
// --------------------------------------------------------------------------

process.stdin.setEncoding('utf8');
process.stdin.on('data', (ligne) => {
  const mot = ligne.trim().toLowerCase();
  if (mot === 'pause') basculerPause();
  else if (mot === 'passer') passer();
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

process.on('SIGINT', () => {
  console.log('\n[mur] Arret.');
  client.destroy().catch(() => {});
  process.exit(0);
});
