import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { WebSocketServer } from 'ws';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';

import { creerFile } from './file-memes.js';
import { dureeVideoMs, findMediaUrl, mediaDesEmbeds, mediaTypeOf, urlsDe } from './medias.js';

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

// --------------------------------------------------------------------------
// Moderation : de quoi couper le robinet a quelqu'un sans l'exclure du serveur
// Discord. Volontairement limite a LiveChat — bannir pour de vrai reste le
// travail des moderateurs du serveur.
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

/** Moderer LiveChat suit le droit de gerer les messages du salon. */
function peutModerer(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
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

  const contenu = `**${actuel.meme.author.name}** est a l'ecran.`;
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

  const salon = client.channels.cache.find(
    (c) =>
      c.name === WALL_CHANNEL &&
      typeof c.send === 'function' &&
      (!process.env.DISCORD_GUILD_ID || c.guild?.id === process.env.DISCORD_GUILD_ID),
  );
  if (!salon) return;

  try {
    messageControle = await salon.send({ content: contenu, components: composants });
  } catch (erreur) {
    console.warn('[livechat] Bouton Passer : envoi impossible :', erreur.message);
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
  // temps qu'il lui reste plutot qu'un plein 8s qui le desynchroniserait des
  // autres.
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

// Un tunnel qui tombe (coupure reseau, cloudflared qui plante, quota atteint)
// emportait tout LiveChat avec lui : le serveur continuait de tourner, mais
// plus personne ne pouvait l'atteindre et rien ne le relancait. On le
// redemarre donc, en espacant les tentatives pour ne pas marteler Cloudflare.
const RELANCE_TUNNEL_MIN_MS = 2000;
const RELANCE_TUNNEL_MAX_MS = 60000;
let delaiRelanceTunnel = RELANCE_TUNNEL_MIN_MS;
let arretDemande = false; // vrai a partir du Ctrl+C : plus rien a relancer
let cloudflaredIntrouvable = false; // inutile de reessayer : le binaire manque

function demarrerTunnel() {
  // Adresse fixe (VPS, domaine derriere nginx...) : pas de tunnel a ouvrir,
  // mais l'annonce automatique dans Discord reste utile telle quelle.
  const adressePublique = (process.env.PUBLIC_URL ?? '').trim();
  if (adressePublique) {
    urlPublique = adressePublique;
    console.log(`[tunnel] Adresse publique fixe : ${urlPublique}`);
    annoncerSiPret();
    return;
  }

  if (MODE_TUNNEL === 'none' || MODE_TUNNEL === 'non') {
    console.log("[tunnel] AUTO_TUNNEL=none : lance le tien a la main si besoin.");
    return;
  }

  lancerCloudflared();
}

function lancerCloudflared() {
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
        // Le tunnel a tenu assez longtemps pour donner une adresse : la
        // prochaine panne repart d'un delai court.
        delaiRelanceTunnel = RELANCE_TUNNEL_MIN_MS;
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
      cloudflaredIntrouvable = true;
      console.error('[tunnel] cloudflared introuvable. Installe-le avec :');
      console.error('[tunnel]   winget install --id Cloudflare.cloudflared');
      console.error("[tunnel] Ou mets AUTO_TUNNEL=none et lance ton propre tunnel a la main.");
    } else {
      console.error('[tunnel] Erreur :', erreur.message);
    }
  });

  processusTunnel.on('exit', (code) => {
    processusTunnel = null;
    if (arretDemande || cloudflaredIntrouvable) return;

    console.warn(`[tunnel] cloudflared s'est arrete (code ${code}). Relance dans ${delaiRelanceTunnel / 1000}s.`);

    // L'adresse d'un tunnel ephemere ne survit pas au processus : la prochaine
    // sera differente, donc il faudra la re-annoncer dans Discord.
    urlPublique = null;
    dejaAnnonce = false;

    setTimeout(lancerCloudflared, delaiRelanceTunnel);
    delaiRelanceTunnel = Math.min(delaiRelanceTunnel * 2, RELANCE_TUNNEL_MAX_MS);
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

  botPret = true;
  annoncerSiPret();
});

/** Raccourcit un lien ou un texte pour tenir dans une ligne de la file. */
function apercuCourt(texte) {
  const propre = (texte ?? '').replace(/\s+/g, ' ').trim();
  return propre.length > 60 ? `${propre.slice(0, 57)}…` : propre;
}

/** "3 min", "1 h 12 min"... a partir d'une duree en ms. */
function dureeLisible(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith('passer:')) return;
    const idCible = Number(interaction.customId.slice('passer:'.length));
    if (file.memeEnCours()?.meme.id !== idCible) {
      await interaction.reply({ content: 'Deja passe.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate(); // actualiserMessageControle() fera l'edition
    file.passer();
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'connectes') {
    const maintenant = Date.now();
    const liste = [...wss.clients]
      .filter((s) => s.readyState === s.OPEN)
      .sort((a, b) => a.connecteDepuis - b.connecteDepuis)
      .map((s) => `• **${s.pseudo}** — connecte depuis ${dureeLisible(maintenant - s.connecteDepuis)}`);

    await interaction.reply({
      content:
        liste.length === 0
          ? "Personne n'a l'overlay ouvert en ce moment."
          : `**${liste.length} overlay(s) connecte(s) :**\n${liste.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === 'passer') {
    const yAvaitQuelqueChose = file.passer();
    await interaction.reply({
      content: yAvaitQuelqueChose ? 'Meme passe.' : "Rien n'etait a l'ecran.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === 'file') {
    const { enPause, aLEcran, attente } = file.apercu();

    const lignes = [];
    if (enPause) lignes.push('_(diffusion en pause)_');
    lignes.push(
      aLEcran ? `**A l'ecran :** ${aLEcran.author.name}` : "**A l'ecran :** rien pour le moment.",
    );

    if (attente.length === 0) {
      lignes.push('**En attente :** rien.');
    } else {
      lignes.push(`**En attente (${attente.length}) :**`);
      // Discord coupe a 2000 caracteres : on montre le debut de la file, qui
      // est de toute facon la seule partie sur laquelle on peut encore agir.
      for (const [index, item] of attente.slice(0, 15).entries()) {
        lignes.push(`${index + 1}. **${item.auteur}** — ${item.type} ${apercuCourt(item.apercu)}`);
      }
      if (attente.length > 15) lignes.push(`… et ${attente.length - 15} de plus.`);
    }

    await interaction.reply({ content: lignes.join('\n'), flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === 'vider') {
    if (!peutModerer(interaction)) {
      await interaction.reply({
        content: 'Il faut le droit de gerer les messages pour vider la file.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const combien = file.vider();
    console.log(`[livechat] File videe (${combien} meme(s)) par ${interaction.user.tag}.`);
    await interaction.reply({
      content:
        combien === 0
          ? "La file etait deja vide (le meme a l'ecran, lui, va au bout : /passer pour le couper)."
          : `${combien} meme(s) en attente supprime(s).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === 'bannir' || interaction.commandName === 'debannir') {
    if (!peutModerer(interaction)) {
      await interaction.reply({
        content: 'Il faut le droit de gerer les messages pour ca.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cible = interaction.options.getUser('membre');
    const bannir = interaction.commandName === 'bannir';

    if (bannir && cible.id === interaction.user.id) {
      await interaction.reply({
        content: 'Te bannir toi-meme, vraiment ?',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (bannir) bannis.add(cible.id);
    else bannis.delete(cible.id);
    ecrireBannis();

    console.log(
      `[livechat] ${cible.tag} ${bannir ? 'banni de' : 'reautorise sur'} LiveChat par ${interaction.user.tag}.`,
    );
    await interaction.reply({
      content: bannir
        ? `**${cible.username}** ne peut plus envoyer de memes sur LiveChat.`
        : `**${cible.username}** peut de nouveau envoyer des memes.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName !== 'meme') return;

  if (bannis.has(interaction.user.id)) {
    await interaction.reply({
      content: "Tu n'as plus acces a LiveChat.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

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

  const devant = file.enfiler({
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
      file.enfiler({
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
    file.enfiler({
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
    file.enfiler({ author, text: texteSeul, ...media });
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
    file.enfiler({ author, text: message.content.trim(), mediaUrl: null, mediaType: null });
  }
}

/** Met un message de cote le temps que Discord lui attache son embed. */
function patienter(message, author, text) {
  if (attenteEmbed.has(message.id)) return;

  const minuteur = setTimeout(() => {
    attenteEmbed.delete(message.id);
    if (text) {
      // Le lien n'a rien donne, mais il y avait autre chose a dire.
      file.enfiler({ author, text, mediaUrl: null, mediaType: null });
    } else {
      console.warn(`[livechat] Lien sans media utilisable, laisse de cote : ${message.content.trim()}`);
    }
  }, ATTENTE_EMBED_MS);

  attenteEmbed.set(message.id, { author, text, minuteur });
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // sinon, boucle
  if (message.channel?.name !== WALL_CHANNEL) return;
  if (bannis.has(message.author.id)) return; // banni de LiveChat : le message reste dans Discord, mais ne passe pas a l'ecran
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
  file.enfiler({ author: attente.author, text: attente.text, ...media });
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
  arretDemande = true;
  processusTunnel?.kill();
  client.destroy().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', arreter);
// systemd arrete le service avec SIGTERM : sans ce second gestionnaire, on
// mourait sans tuer cloudflared, qui restait a trainer apres un redemarrage.
process.on('SIGTERM', arreter);
