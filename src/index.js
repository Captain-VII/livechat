import 'dotenv/config';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server as SocketServer } from 'socket.io';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const WALL_CHANNEL = 'mur-a-memes';

/** Lit un reglage numerique, en gueulant plutot qu'en avalant une valeur bancale. */
function reglage(nom, defaut, { min = 0 } = {}) {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === '') return defaut;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur < min) {
    console.warn(`[mur] ${nom} invalide ("${brut}") : on retombe sur ${defaut}.`);
    return defaut;
  }
  return valeur;
}

// Nombre de feuilles au mur. C'est aussi ce que recoit un retardataire :
// tout le monde voit exactement la meme chose.
const HISTORY_SIZE = reglage('HISTORY_SIZE', 12, { min: 1 });

// Duree de vie d'un meme, en minutes. 0 = il tient jusqu'a ce qu'un autre le pousse dehors.
const TTL_MINUTES = reglage('MEME_TTL_MINUTES', 30);
const TTL_MS = TTL_MINUTES * 60_000;
const BALAYAGE_MS = 5_000;

// Les memes se collent un par un, a ce rythme. Une rafale de dix images ne
// repeint pas le mur d'un coup : elle defile.
const INTERVALLE_MS = reglage('MEME_INTERVAL_MS', 1500);
const FILE_MAX = reglage('QUEUE_MAX', 40, { min: 1 });

const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

// --------------------------------------------------------------------------
// Le mur : historique en memoire, plafonne, perdu au redemarrage. C'est voulu.
// --------------------------------------------------------------------------

/**
 * Ce qui est colle au mur, du plus recent au plus ancien. C'est a la fois l'etat
 * affiche et le rattrapage envoye aux retardataires : tous les ecrans montrent
 * la meme chose, qu'on soit arrive au debut ou a 3h du matin.
 * @type {Array<object>}
 */
const mur = [];

/** Memes acceptes, pas encore colles : ils attendent leur tour. @type {Array<object>} */
const file = [];

let nextId = 1;
let minuteur = null;

/**
 * Met un meme dans la file d'attente. Renvoie le nombre de memes devant lui.
 * Rien n'est fige ici : id, heure et rotation sont decides au moment ou la
 * feuille touche vraiment le mur, pour que sa duree de vie parte de la.
 */
function enfiler(meme) {
  const devant = file.length;
  file.push(meme);

  if (file.length > FILE_MAX) {
    file.shift();
    console.warn('[mur] File pleine : le plus vieux meme en attente est passe a la trappe.');
  }

  // File a l'arret : le prochain tour de boucle colle celui-la tout de suite.
  if (!minuteur) minuteur = setTimeout(defiler, 0);
  return devant;
}

function defiler() {
  const meme = file.shift();
  if (!meme) {
    minuteur = null;
    return;
  }
  coller(meme);
  minuteur = setTimeout(defiler, INTERVALLE_MS);
}

/** Colle une feuille au mur, et pousse dehors celles qui debordent. */
function coller(meme) {
  const feuille = {
    id: nextId++,
    createdAt: Date.now(),
    // Une rotation par feuille, decidee ici pour que tous les ecrans soient d'accord.
    rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
    ...meme,
  };

  mur.unshift(feuille);
  io.emit('meme', feuille);
  console.log(`[mur] ${feuille.author.name} -> ${feuille.mediaUrl ?? feuille.text ?? ''}`);

  if (mur.length > HISTORY_SIZE) {
    decoller(mur.splice(HISTORY_SIZE).map((vieux) => vieux.id));
  }
  return feuille;
}

/** Retire des feuilles de tous les ecrans a la fois. Sans animation : ca disparait, point. */
function decoller(ids) {
  if (ids.length > 0) io.emit('expire', ids);
}

/** Decolle les memes qui ont fait leur temps. */
function decollerLesVieux() {
  if (!TTL_MS) return;

  const limite = Date.now() - TTL_MS;
  const expires = [];
  // Le mur est du plus recent au plus ancien : les perimes sont a la fin.
  while (mur.length > 0 && mur[mur.length - 1].createdAt <= limite) {
    expires.push(mur.pop().id);
  }

  if (expires.length > 0) {
    decoller(expires);
    console.log(`[mur] ${expires.length} meme(s) decolle(s) apres ${TTL_MINUTES} min.`);
  }
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

/** Premiere URL du texte qui ressemble a une image ou une video. */
function findMediaUrl(text) {
  if (!text) return null;
  const urls = text.match(/https?:\/\/\S+/gi) ?? [];
  return urls.find((url) => mediaTypeOf(url) !== null) ?? null;
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
// Serveur web : la page du mur + socket.io
// --------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, memes: mur.length, file: file.length }));

const server = http.createServer(app);
const io = new SocketServer(server);

io.on('connection', (socket) => {
  // Le retardataire recupere ce qu'il a rate — deja debarrasse des perimes.
  decollerLesVieux();
  socket.emit('history', mur);
});

setInterval(decollerLesVieux, BALAYAGE_MS).unref();

server.listen(PORT, () => {
  console.log(`[web] Le mur est servi sur http://localhost:${PORT}`);
  console.log(
    `[mur] ${HISTORY_SIZE} feuilles au mur, une nouvelle toutes les ${INTERVALLE_MS} ms au maximum.`,
  );
  console.log(
    TTL_MS
      ? `[mur] Chaque meme tient ${TTL_MINUTES} min, puis se decolle tout seul.`
      : '[mur] Pas de duree de vie : les memes restent jusqu\'a ce qu\'un autre les pousse dehors.',
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
      content: "Ce lien ne ressemble pas a une image ou une video (jpg, png, gif, webp, mp4, webm).",
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
    content: devant === 0 ? 'Colle au mur.' : `Dans la file, ${devant} devant toi.`,
    flags: MessageFlags.Ephemeral,
  });
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // sinon, boucle
  if (message.channel?.name !== WALL_CHANNEL) return;

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

  if (message.content.trim()) {
    enfiler({ author, text: message.content.trim(), mediaUrl: null, mediaType: null });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN absent : le mur tourne, mais rien ne viendra le remplir.');
  console.error('[bot] Copie .env.example vers .env et remplis-le.');
} else {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('[bot] Connexion impossible :', error.message);
    console.error('[bot] Verifie DISCORD_TOKEN, et que l\'intent MESSAGE CONTENT est active.');
  });
}
