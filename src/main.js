import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  nativeImage,
  screen,
} from 'electron';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Temps d'affichage d'un meme, puis la respiration avant le suivant.
const DUREE_MS = reglage('OVERLAY_DURATION_MS', 8000, { min: 500 });
const GAP_MS = reglage('OVERLAY_GAP_MS', 500);
const VOLUME = reglage('OVERLAY_VOLUME', 0.7, { min: 0, max: 1 });
const FILE_MAX = reglage('QUEUE_MAX', 40, { min: 1 });

// Combien de temps on laisse a Discord pour resoudre l'embed d'un lien.
const ATTENTE_EMBED_MS = reglage('EMBED_WAIT_MS', 6000, { min: 500 });

// Sur quel ecran les memes apparaissent. Vide ou "principal" : l'ecran principal.
// Sinon un numero (celui affiche au demarrage et dans le menu) ou un bout du nom
// de l'ecran, ce qui resiste au reordonnancement de Windows.
const ECRAN_VOULU = (process.env.OVERLAY_DISPLAY ?? '').trim();

const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

// Un carre de papier scotche, 32x32 : l'icone de la barre des taches, en dur,
// pour ne pas trimballer un binaire dans le depot.
const ICONE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVUlEQVR42mNgGAUk' +
  'gEfXNrwmBo86gCJL9u1Y8R8XJtYB+MwgygGf3z/Biol1AC79Q98BlOJRB4w6YNQBow4YdcCoA0YdMOqAUQcM' +
  'HQfQEo/2LwcdAABAP5xHY/MUgQAAAABJRU5ErkJggg==';

// Chromium refuse l'autoplay avec du son sans geste utilisateur. Il n'y a personne
// pour cliquer sur un overlay traverse par les clics : on leve la regle.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// --------------------------------------------------------------------------
// La file : les memes passent un par un, chacun son moment a l'ecran.
// --------------------------------------------------------------------------

/** @type {Array<object>} Memes acceptes, pas encore affiches. */
const file = [];

let nextId = 1;
let minuteur = null;
let enPause = false;
let sonCoupe = false;
let fenetre = null;
let tray = null;
let ecranChoisiId = null;

/**
 * Met un meme dans la file. Renvoie le nombre de memes devant lui.
 * Rien n'est fige ici : id et rotation sont decides au moment ou la feuille
 * arrive vraiment a l'ecran.
 */
function enfiler(meme) {
  const devant = file.length;
  file.push(meme);

  if (file.length > FILE_MAX) {
    file.shift();
    console.warn('[mur] File pleine : le plus vieux meme en attente est passe a la trappe.');
  }

  majMenu();
  relancer();
  return devant;
}

/** Reveille la file si elle dort. */
function relancer() {
  if (minuteur || enPause || file.length === 0) return;
  minuteur = setTimeout(defiler, 0);
}

/**
 * Le process principal tient l'horloge : il n'attend aucun accuse de reception
 * de la fenetre. Une page muette ne peut donc pas bloquer la file.
 */
function defiler() {
  minuteur = null;
  if (enPause) return;

  const meme = file.shift();
  if (!meme) {
    cacher();
    return;
  }

  if (!afficher(meme)) {
    // Fenetre pas encore prete : on remet le meme devant plutot que de le perdre.
    file.unshift(meme);
    minuteur = setTimeout(defiler, 200);
    return;
  }

  majMenu();
  minuteur = setTimeout(defiler, DUREE_MS + GAP_MS);
}

/** Envoie une feuille a la fenetre et la fait apparaitre a l'ecran. Faux si la fenetre manque. */
function afficher(meme) {
  if (!fenetre || fenetre.isDestroyed()) return false;

  const feuille = {
    id: nextId++,
    // Une legere rotation, differente a chaque fois.
    rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
    duree: DUREE_MS,
    volume: sonCoupe ? 0 : VOLUME,
    ...meme,
  };

  // showInactive et jamais show : show donnerait le focus a l'overlay, ce qui
  // sortirait un jeu de son plein ecran.
  if (!fenetre.isVisible()) fenetre.showInactive();
  fenetre.webContents.send('meme', feuille);
  console.log(`[mur] ${feuille.author.name} -> ${feuille.mediaUrl ?? feuille.text ?? ''}`);
  return true;
}

/** Plus rien a montrer : on retire la fenetre du chemin. */
function cacher() {
  if (!fenetre || fenetre.isDestroyed() || !fenetre.isVisible()) return;
  fenetre.webContents.send('retrait');
  fenetre.hide();
}

/** Coupe court au meme affiche et passe au suivant. */
function passer() {
  if (minuteur) clearTimeout(minuteur);
  minuteur = null;
  cacher();
  relancer();
}

function basculerPause() {
  enPause = !enPause;
  if (enPause) {
    if (minuteur) clearTimeout(minuteur);
    minuteur = null;
    cacher();
  } else {
    relancer();
  }
  console.log(`[mur] ${enPause ? 'En pause.' : 'Reprise.'} ${file.length} en attente.`);
  majMenu();
}

function basculerSon() {
  sonCoupe = !sonCoupe;
  console.log(`[mur] Son ${sonCoupe ? 'coupe' : 'retabli'}.`);
  majMenu();
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
// Le choix de l'ecran : personne ne veut d'un meme en plein milieu d'une ranked.
// --------------------------------------------------------------------------

/** Les ecrans, le principal en tete, puis de gauche a droite. */
function ecrans() {
  const principal = screen.getPrimaryDisplay();
  return screen.getAllDisplays().sort((a, b) => {
    if (a.id === principal.id) return -1;
    if (b.id === principal.id) return 1;
    return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y;
  });
}

function decrire(ecran, index) {
  const principal = ecran.id === screen.getPrimaryDisplay().id ? ' (principal)' : '';
  const nom = ecran.label || `ecran ${index + 1}`;
  return `${index + 1}. ${nom} - ${ecran.bounds.width}x${ecran.bounds.height}${principal}`;
}

/** Resout OVERLAY_DISPLAY. Retombe sur le principal plutot que de ne rien afficher. */
function ecranVoulu() {
  const liste = ecrans();
  if (!ECRAN_VOULU || /^(principal|primary)$/i.test(ECRAN_VOULU)) return liste[0];

  const numero = Number(ECRAN_VOULU);
  const trouve = Number.isInteger(numero)
    ? liste[numero - 1]
    : liste.find((e) => e.label?.toLowerCase().includes(ECRAN_VOULU.toLowerCase()));

  if (trouve) return trouve;

  console.warn(`[mur] OVERLAY_DISPLAY="${ECRAN_VOULU}" ne correspond a aucun ecran.`);
  console.warn('[mur] On reste sur le principal. Ecrans disponibles :');
  liste.forEach((e, i) => console.warn(`[mur]   ${decrire(e, i)}`));
  return liste[0];
}

/** Deplace l'overlay sur un ecran, tout de suite. */
function placerSur(ecran) {
  if (!ecran) return;
  ecranChoisiId = ecran.id;

  if (fenetre && !fenetre.isDestroyed()) {
    // La fenetre est figee (transparent + resizable est instable sur Windows) :
    // on la degele juste le temps de la reposer sur l'autre ecran.
    fenetre.setResizable(true);
    fenetre.setBounds(ecran.bounds);
    fenetre.setResizable(false);
  }

  console.log(`[mur] Les memes s'affichent sur : ${ecran.label} (${ecran.bounds.width}x${ecran.bounds.height}).`);
  majMenu();
}

/** Un ecran branche, debranche ou redimensionne : on se recale. */
function surChangementEcrans() {
  const actuel = screen.getAllDisplays().find((e) => e.id === ecranChoisiId);
  if (actuel) {
    placerSur(actuel); // ses bornes ont pu changer
    return;
  }
  console.warn("[mur] L'ecran choisi a disparu.");
  placerSur(ecranVoulu());
}

// --------------------------------------------------------------------------
// La fenetre : tout l'ecran choisi, transparente, traversee par les clics
// --------------------------------------------------------------------------

function creerFenetre() {
  const ecran = ecranVoulu();
  ecranChoisiId = ecran.id;
  const { bounds } = ecran;

  fenetre = new BrowserWindow({
    // bounds et pas workArea : on couvre aussi la barre des taches.
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    // transparent + resizable est instable sur Windows : on fige la fenetre.
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  fenetre.setAlwaysOnTop(true, 'screen-saver');
  fenetre.setIgnoreMouseEvents(true, { forward: true });
  fenetre.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  fenetre.loadFile(path.join(__dirname, 'overlay.html'));

  // A la creation, Windows rabote la fenetre a la zone de travail : elle perd la
  // hauteur de la barre des taches. On repose les bornes exactes par le meme
  // chemin que le changement d'ecran.
  placerSur(ecran);
}

// --------------------------------------------------------------------------
// Icone de notification : sans elle, une fenetre traversee par les clics et
// absente de la barre des taches serait impossible a quitter.
// --------------------------------------------------------------------------

function majMenu() {
  if (!tray) return;

  const etat = enPause
    ? `En pause — ${file.length} en attente`
    : file.length > 0
      ? `${file.length} meme(s) en attente`
      : 'Rien en attente';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Le mur — ${etat}`, enabled: false },
      { type: 'separator' },
      { label: enPause ? 'Reprendre' : 'Pause', click: basculerPause },
      { label: 'Passer ce meme', click: passer },
      { label: sonCoupe ? 'Retablir le son' : 'Couper le son', click: basculerSon },
      {
        label: 'Afficher sur',
        submenu: ecrans().map((ecran, index) => ({
          label: decrire(ecran, index),
          type: 'radio',
          checked: ecran.id === ecranChoisiId,
          click: () => placerSur(ecran),
        })),
      },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]),
  );
}

function creerTray() {
  tray = new Tray(nativeImage.createFromDataURL(ICONE_PNG));
  tray.setToolTip('Le mur');
  majMenu();
  tray.on('click', () => tray.popUpContextMenu());
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
// Demarrage
// --------------------------------------------------------------------------

// Deux instances, ce serait deux bots sur le meme token.
if (!app.requestSingleInstanceLock()) {
  console.error('[mur] Le mur tourne deja. Regarde dans la barre des taches.');
  app.quit();
} else {
  app.whenReady().then(() => {
    creerFenetre();
    creerTray();

    globalShortcut.register('Control+Alt+M', passer);
    globalShortcut.register('Control+Alt+P', basculerPause);

    screen.on('display-added', surChangementEcrans);
    screen.on('display-removed', surChangementEcrans);
    screen.on('display-metrics-changed', surChangementEcrans);

    console.log('[mur] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :');
    ecrans().forEach((ecran, index) => {
      const ici = ecran.id === ecranChoisiId ? '  <-- les memes s\'affichent ici' : '';
      console.log(`[mur]   ${decrire(ecran, index)}${ici}`);
    });

    console.log(`[mur] Overlay pret : un meme a la fois, ${DUREE_MS} ms chacun.`);
    console.log('[mur] Ctrl+Alt+M passe le meme affiche, Ctrl+Alt+P met la file en pause.');
    console.log("[mur] Pour quitter : l'icone dans la barre des taches.");

    if (!process.env.DISCORD_TOKEN) {
      console.error(
        "[bot] DISCORD_TOKEN absent : l'overlay tourne, mais rien ne viendra le remplir.",
      );
      console.error('[bot] Copie .env.example vers .env et remplis-le.');
    } else {
      client.login(process.env.DISCORD_TOKEN).catch((error) => {
        console.error('[bot] Connexion impossible :', error.message);
        console.error("[bot] Verifie DISCORD_TOKEN, et que l'intent MESSAGE CONTENT est active.");
      });
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  client.destroy().catch(() => {});
});

// L'overlay n'a pas de fenetre a fermer : il vit dans la barre des taches.
app.on('window-all-closed', () => app.quit());
