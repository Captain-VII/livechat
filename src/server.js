import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

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
    console.warn(`[livechat] ${nom} invalide ("${brut}") : on retombe sur ${defaut}.`);
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

// Garde le trace du dernier message d'annonce par salon, pour l'effacer avant
// d'en poster un nouveau : sinon chaque redemarrage laisse une adresse morte
// derriere lui dans Discord.
const ETAT_ANNONCES_PATH = path.join(process.cwd(), '.livechat-annonces.json');

function lireDernieresAnnonces() {
  try {
    return JSON.parse(fs.readFileSync(ETAT_ANNONCES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function ecrireDernieresAnnonces(etat) {
  try {
    fs.writeFileSync(ETAT_ANNONCES_PATH, JSON.stringify(etat, null, 2));
  } catch (erreur) {
    console.warn("[tunnel] Impossible de sauvegarder l'etat des annonces :", erreur.message);
  }
}

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
 * Le meme actuellement a l'ecran, pour rattraper qui se (re)connecte pendant
 * qu'il tourne encore. Sans ca, un accroc reseau d'une seconde suffit a rater
 * un meme pour de bon : rien ne le rejoue jamais.
 * @type {{ meme: object, finPrevue: number } | null}
 */
let enCours = null;

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
    console.warn('[livechat] File pleine : le plus vieux meme en attente est passe a la trappe.');
  }

  relancer();
  return devant;
}

/** Reveille la file si elle dort. */
// Vrai pendant qu'on attend la duree reelle d'une video : relancer() ne doit
// pas programmer un second defiler() en parallele pendant ce temps-la.
let sondageEnCours = false;

function relancer() {
  if (minuteur || sondageEnCours || enPause || file.length === 0) return;
  minuteur = setTimeout(defiler, 0);
}

async function defiler() {
  minuteur = null;
  if (enPause) return;

  const meme = file.shift();
  if (!meme) {
    enCours = null;
    diffuser({ type: 'retrait' });
    return;
  }

  sondageEnCours = true;
  const duree = meme.mediaType === 'video' ? ((await dureeVideoMs(meme.mediaUrl)) ?? DUREE_MS) : DUREE_MS;
  sondageEnCours = false;

  const feuille = {
    id: nextId++,
    // Une legere rotation, decidee ici pour que tous les overlays soient d'accord.
    rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
    duree,
    ...meme,
  };

  enCours = { meme: feuille, finPrevue: Date.now() + duree };
  diffuser({ type: 'meme', meme: feuille });
  console.log(
    `[livechat] ${feuille.author.name} -> ${feuille.mediaUrl ?? feuille.text ?? ''} (${duree}ms)`,
  );
  minuteur = setTimeout(defiler, duree + GAP_MS);
}

function passer() {
  if (minuteur) clearTimeout(minuteur);
  minuteur = null;
  enCours = null;
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
  console.log(`[livechat] ${enPause ? 'En pause.' : 'Reprise.'} ${file.length} en attente.`);
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

// --------------------------------------------------------------------------
// Duree reelle d'une video : lue dans son conteneur MP4, sans FFmpeg. La boite
// 'mvhd' contient l'echelle de temps et la duree ; on la cherche d'abord dans
// les premiers octets du fichier (encodage "streaming"), sinon dans les
// derniers (encodage classique, ou la table des index arrive a la fin).
// --------------------------------------------------------------------------

const TAILLE_SONDE_OCTETS = 262144; // 256 Ko : large marge, petite requete.

async function plageOctets(url, range) {
  const reponse = await fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(4000) });
  if (!reponse.ok && reponse.status !== 206) throw new Error(`HTTP ${reponse.status}`);
  return Buffer.from(await reponse.arrayBuffer());
}

/** Cherche la boite 'mvhd' dans un extrait de fichier et en tire la duree en secondes. */
function dureeDepuisMvhd(buf) {
  const idx = buf.indexOf('mvhd');
  if (idx === -1) return null;
  try {
    const version = buf[idx + 4];
    if (version === 1) {
      const timescale = buf.readUInt32BE(idx + 24);
      const duration = Number(buf.readBigUInt64BE(idx + 28));
      return timescale > 0 ? duration / timescale : null;
    }
    const timescale = buf.readUInt32BE(idx + 16);
    const duration = buf.readUInt32BE(idx + 20);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

/** Duree d'une video en millisecondes, ou null si elle n'a pas pu etre lue (webm, erreur reseau, format inattendu). */
async function dureeVideoMs(url) {
  try {
    const debut = await plageOctets(url, `bytes=0-${TAILLE_SONDE_OCTETS - 1}`);
    let secondes = dureeDepuisMvhd(debut);

    if (secondes == null) {
      const fin = await plageOctets(url, `bytes=-${TAILLE_SONDE_OCTETS}`);
      secondes = dureeDepuisMvhd(fin);
    }

    if (secondes == null || !Number.isFinite(secondes) || secondes <= 0) return null;
    return Math.min(Math.round(secondes * 1000), DUREE_VIDEO_MAX_MS);
  } catch (erreur) {
    console.warn(`[livechat] Duree de la video illisible (${erreur.message}), duree par defaut utilisee.`);
    return null;
  }
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
  console.log(`[livechat] Overlay connecte (${adresse}). ${wss.clients.size} au total.`);

  // Rattrapage : qui se connecte (ou se reconnecte apres un accroc reseau)
  // pendant qu'un meme est deja a l'ecran le recoit tout de suite, avec le
  // temps qu'il lui reste plutot qu'un plein 8s qui le desynchroniserait des
  // autres.
  if (enCours) {
    const restant = enPause ? enCours.meme.duree : enCours.finPrevue - Date.now();
    if (restant > 300) {
      socket.send(JSON.stringify({ type: 'meme', meme: { ...enCours.meme, duree: restant } }));
    }
  }

  // Le protocole websocket repond tout seul aux ping : ca sert surtout au
  // serveur a reperer une connexion morte sans attendre le timeout TCP, qui
  // peut prendre plusieurs minutes derriere un tunnel.
  socket.estVivant = true;
  socket.on('pong', () => {
    socket.estVivant = true;
  });

  socket.on('close', () => {
    console.log(`[livechat] Overlay deconnecte. ${wss.clients.size} restant(s).`);
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
      passer();
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

serveurHttp.listen(PORT, () => {
  console.log(`[livechat] Serveur pret sur le port ${PORT}.`);
  console.log(
    `[livechat] Overlay local : lance le client avec SERVER_URL=ws://localhost:${PORT}`,
  );
  demarrerTunnel();
});

// --------------------------------------------------------------------------
// Le tunnel : sans lui, exposer le serveur a des potes demande de copier-coller
// une adresse a la main a chaque soiree. cloudflared le fait, et son adresse
// part directement dans Discord des qu'elle est connue.
// --------------------------------------------------------------------------

let urlPublique = null; // wss://... une fois le tunnel pret
let botPret = false;
let dejaAnnonce = false;
let processusTunnel = null;

function demarrerTunnel() {
  if (MODE_TUNNEL === 'none' || MODE_TUNNEL === 'non') {
    console.log("[tunnel] AUTO_TUNNEL=none : lance le tien a la main si besoin.");
    return;
  }

  console.log('[tunnel] Ouverture d\'un tunnel Cloudflare...');
  processusTunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`]);

  // cloudflared journalise tout sur stderr, y compris l'adresse generee.
  let tampon = '';
  processusTunnel.stderr.setEncoding('utf8');
  processusTunnel.stderr.on('data', (morceau) => {
    tampon += morceau;

    if (!urlPublique) {
      const trouve = tampon.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (trouve) {
        urlPublique = trouve[0].replace(/^https:/, 'wss:');
        console.log(`[tunnel] Adresse publique : ${urlPublique}`);
        annoncerSiPret();
      }
    }

    // On ne recopie pas tout le log de cloudflared (tres bavard) : juste ses erreurs.
    for (const ligne of morceau.split('\n')) {
      if (/\bERR\b/.test(ligne)) console.warn(`[tunnel] ${ligne.trim()}`);
    }
  });

  processusTunnel.on('error', (erreur) => {
    if (erreur.code === 'ENOENT') {
      console.error('[tunnel] cloudflared introuvable. Installe-le avec :');
      console.error('[tunnel]   winget install --id Cloudflare.cloudflared');
      console.error("[tunnel] Ou mets AUTO_TUNNEL=none et lance ton propre tunnel a la main.");
    } else {
      console.error('[tunnel] Erreur :', erreur.message);
    }
  });

  processusTunnel.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[tunnel] cloudflared s'est arrete (code ${code}).`);
    }
  });
}

/** Poste l'adresse dans Discord des que le tunnel ET le bot sont prets. */
async function annoncerSiPret() {
  if (dejaAnnonce || !urlPublique || !botPret) return;
  dejaAnnonce = true;

  const salons = client.channels.cache.filter(
    (c) =>
      c.name === SALON_ANNONCE &&
      typeof c.send === 'function' &&
      (!process.env.DISCORD_GUILD_ID || c.guild?.id === process.env.DISCORD_GUILD_ID),
  );

  if (salons.size === 0) {
    console.warn(`[tunnel] Aucun salon #${SALON_ANNONCE} trouve pour annoncer l'adresse.`);
    console.warn(`[tunnel] Donne-la a la main : ${urlPublique}`);
    return;
  }

  const etat = lireDernieresAnnonces();

  for (const salon of salons.values()) {
    // Efface l'annonce precedente de ce salon avant d'en poster une nouvelle.
    const ancienId = etat[salon.id];
    if (ancienId) {
      try {
        const ancien = await salon.messages.fetch(ancienId);
        await ancien.delete();
      } catch {
        // Deja supprimee (par un humain, ou une purge Discord) : tant pis.
      }
    }

    try {
      const message = await salon.send(
        "**LiveChat est en ligne.** Colle cette adresse dans l'appli " +
          "(icone de la barre des taches > *Configurer le serveur*) :\n" +
          `\`\`\`\n${urlPublique}\n\`\`\``,
      );
      etat[salon.id] = message.id;
      console.log(`[tunnel] Adresse annoncee dans #${salon.name} (${salon.guild.name}).`);
    } catch (erreur) {
      console.error(`[tunnel] Envoi impossible dans #${salon.name} :`, erreur.message);
    }
  }

  ecrireDernieresAnnonces(etat);
}

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

  botPret = true;
  annoncerSiPret();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'passer') {
    const yAvaitQuelqueChose = enCours !== null;
    passer();
    await interaction.reply({
      content: yAvaitQuelqueChose ? 'Meme passe.' : "Rien n'etait a l'ecran.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName !== 'meme') return;

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
      console.warn(`[livechat] Lien sans media utilisable, laisse de cote : ${message.content.trim()}`);
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
  console.log('\n[livechat] Arret.');
  processusTunnel?.kill();
  client.destroy().catch(() => {});
  process.exit(0);
});
