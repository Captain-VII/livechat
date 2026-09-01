import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
} from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const VOLUME = reglage('OVERLAY_VOLUME', 0.7, { min: 0, max: 1 });

// Sur quel ecran les memes apparaissent. Vide ou "principal" : l'ecran principal.
const ECRAN_VOULU = (process.env.OVERLAY_DISPLAY ?? '').trim();

// Sur quelle sortie audio le son part. Vide ou "defaut" : celle de Windows.
const SORTIE_VOULUE = (process.env.OVERLAY_AUDIO_DEVICE ?? '').trim();

// Un carre de papier scotche, 32x32 : l'icone de la barre des taches, en dur,
// pour ne pas trimballer un binaire dans le depot.
const ICONE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVUlEQVR42mNgGAUk' +
  'gEfXNrwmBo86gCJL9u1Y8R8XJtYB+MwgygGf3z/Biol1AC79Q98BlOJRB4w6YNQBow4YdcCoA0YdMOqAUQcM' +
  'HQfQEo/2LwcdAABAP5xHY/MUgQAAAABJRU5ErkJggg==';

// Chromium refuse l'autoplay avec du son sans geste utilisateur. Il n'y a personne
// pour cliquer sur un overlay traverse par les clics : on leve la regle.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let fenetre = null;
let fenetreConfig = null;
let tray = null;
let ecranChoisiId = null;
let sonCoupe = false;

// --------------------------------------------------------------------------
// Configuration persistante : l'adresse du serveur. Un ami qui lance le .exe
// n'a ni .env ni terminal ; c'est cette petite fenetre qui la lui demande.
// --------------------------------------------------------------------------

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function lireConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function ecrireConfig(partiel) {
  const config = { ...lireConfig(), ...partiel };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

/** L'URL du serveur : la variable d'environnement prime, sinon ce qui a ete sauvegarde. */
function urlServeur() {
  return (process.env.SERVER_URL ?? '').trim() || lireConfig().serverUrl || null;
}

// --------------------------------------------------------------------------
// La connexion au serveur : c'est de la que viennent les memes, plus du bot
// Discord directement. Reconnexion automatique si le tunnel tombe.
// --------------------------------------------------------------------------

let socket = null;
let tentativeReconnexion = null;

// Backoff progressif : une micro-coupure (wifi qui tousse une seconde) se
// rattrape presque tout de suite, une vraie panne n'assomme pas le serveur
// de tentatives.
const DELAI_RECONNEXION_MIN_MS = 500;
const DELAI_RECONNEXION_MAX_MS = 8000;
let delaiReconnexion = DELAI_RECONNEXION_MIN_MS;

function connecter() {
  const url = urlServeur();
  if (!url) {
    ouvrirConfig();
    return;
  }

  console.log(`[mur] Connexion a ${url}...`);
  majMenu();

  try {
    socket = new WebSocket(url);
  } catch (erreur) {
    console.error('[mur] Adresse de serveur invalide :', erreur.message);
    ouvrirConfig();
    return;
  }

  socket.addEventListener('open', () => {
    console.log('[mur] Connecte au serveur.');
    delaiReconnexion = DELAI_RECONNEXION_MIN_MS;
    majMenu();
  });

  socket.addEventListener('message', (evenement) => {
    let message;
    try {
      message = JSON.parse(evenement.data);
    } catch {
      return;
    }

    if (message.type === 'meme') afficher(message.meme);
    else if (message.type === 'retrait') cacher();
  });

  socket.addEventListener('close', () => {
    console.warn(`[mur] Deconnecte du serveur. Nouvelle tentative dans ${delaiReconnexion} ms.`);
    majMenu();
    clearTimeout(tentativeReconnexion);
    tentativeReconnexion = setTimeout(connecter, delaiReconnexion);
    delaiReconnexion = Math.min(delaiReconnexion * 2, DELAI_RECONNEXION_MAX_MS);
  });

  socket.addEventListener('error', () => {
    // 'close' suit toujours 'error' sur WebSocket : la reconnexion est deja geree la-bas.
  });
}

function estConnecte() {
  return socket?.readyState === WebSocket.OPEN;
}

/** Demande au serveur de passer le meme actuellement affiche, pour tout le monde. */
function demanderPasser() {
  if (!estConnecte()) return;
  socket.send(JSON.stringify({ type: 'passer' }));
}

/** Change de serveur a chaud : ferme la connexion actuelle, la nouvelle prend le relai. */
function changerServeur(url) {
  ecrireConfig({ serverUrl: url });
  clearTimeout(tentativeReconnexion);
  socket?.close();
  connecter();
}

// --------------------------------------------------------------------------
// Affichage : identique a la version solo, la fenetre ne fait qu'obeir.
// --------------------------------------------------------------------------

function afficher(meme) {
  if (!fenetre || fenetre.isDestroyed()) return;

  const feuille = { volume: sonCoupe ? 0 : VOLUME, ...meme };

  // showInactive et jamais show : show donnerait le focus a l'overlay, ce qui
  // sortirait un jeu de son plein ecran.
  if (!fenetre.isVisible()) fenetre.showInactive();
  fenetre.webContents.send('meme', feuille);
}

function cacher() {
  if (!fenetre || fenetre.isDestroyed() || !fenetre.isVisible()) return;
  fenetre.webContents.send('retrait');
  fenetre.hide();
}

function basculerSon() {
  sonCoupe = !sonCoupe;
  console.log(`[mur] Son ${sonCoupe ? 'coupe' : 'retabli'}.`);
  majMenu();
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
// Le choix de la sortie audio : envoyer les memes sur un canal a part, pour les
// piloter separement du jeu ou du micro.
// --------------------------------------------------------------------------

/** @type {Array<{ deviceId: string, label: string }>} Annoncees par la fenetre. */
let sortiesAudio = [];
let sortieChoisieId = null;

/** Les sorties presentables : Chromium ajoute un alias "communications" inutile ici. */
function sortiesUtiles() {
  return sortiesAudio.filter((s) => s.deviceId !== 'communications');
}

/** Resout OVERLAY_AUDIO_DEVICE dans la liste annoncee par la fenetre. */
function sortieVoulue() {
  if (!SORTIE_VOULUE || /^(defaut|default)$/i.test(SORTIE_VOULUE)) return null;

  const trouvee = sortiesUtiles().find((s) =>
    s.label?.toLowerCase().includes(SORTIE_VOULUE.toLowerCase()),
  );
  if (trouvee) return trouvee.deviceId;

  console.warn(`[mur] OVERLAY_AUDIO_DEVICE="${SORTIE_VOULUE}" ne correspond a aucune sortie.`);
  console.warn('[mur] On reste sur la sortie par defaut. Sorties disponibles :');
  sortiesUtiles().forEach((s) => console.warn(`[mur]   ${s.label}`));
  return null;
}

/** Envoie le son vers une sortie. null = celle de Windows. */
function routerVers(deviceId) {
  sortieChoisieId = deviceId;
  if (fenetre && !fenetre.isDestroyed()) {
    fenetre.webContents.send('sortie-audio', deviceId ?? 'default');
  }
  const nom = sortiesUtiles().find((s) => s.deviceId === deviceId)?.label;
  console.log(`[mur] Son envoye sur : ${nom ?? 'la sortie par defaut de Windows'}.`);
  majMenu();
}

/** La fenetre vient d'enumerer les peripheriques (au demarrage, ou apres un branchement). */
function surSortiesAnnoncees(liste) {
  const premiereFois = sortiesAudio.length === 0;
  sortiesAudio = liste;

  if (premiereFois) {
    console.log('[mur] Sorties audio (nom a mettre dans OVERLAY_AUDIO_DEVICE) :');
    sortiesUtiles().forEach((s) => console.log(`[mur]   ${s.label}`));
  }

  // La sortie choisie a pu disparaitre avec le peripherique.
  const existeEncore = sortiesUtiles().some((s) => s.deviceId === sortieChoisieId);
  if (sortieChoisieId && !existeEncore) {
    console.warn('[mur] La sortie audio choisie a disparu. Retour a celle par defaut.');
    routerVers(sortieVoulue());
    return;
  }

  if (premiereFois) routerVers(sortieVoulue());
  else majMenu();
}

ipcMain.on('sorties-audio', (_evenement, liste) => surSortiesAnnoncees(liste));

// --------------------------------------------------------------------------
// La fenetre de reglage du serveur : le seul endroit ou un ami sans terminal
// doit taper quelque chose.
// --------------------------------------------------------------------------

ipcMain.handle('config:lire', () => ({ serverUrl: urlServeur() ?? '' }));
ipcMain.handle('config:sauver', (_evenement, url) => {
  const propre = url.trim();
  if (!propre) return { ok: false, erreur: 'Adresse vide.' };
  if (!/^wss?:\/\//i.test(propre)) {
    return { ok: false, erreur: "L'adresse doit commencer par ws:// ou wss://." };
  }
  changerServeur(propre);
  return { ok: true };
});

function ouvrirConfig() {
  if (fenetreConfig && !fenetreConfig.isDestroyed()) {
    fenetreConfig.focus();
    return;
  }

  fenetreConfig = new BrowserWindow({
    width: 480,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Le mur — Serveur',
    webPreferences: {
      preload: path.join(__dirname, 'config-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  fenetreConfig.setMenuBarVisibility(false);
  fenetreConfig.loadFile(path.join(__dirname, 'config.html'));
  fenetreConfig.on('closed', () => {
    fenetreConfig = null;
  });
}

// --------------------------------------------------------------------------
// La fenetre overlay : tout l'ecran choisi, transparente, traversee par les clics
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

  const etatConnexion = estConnecte() ? 'Connecte' : 'Deconnecte...';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Le mur — ${etatConnexion}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Passer ce meme  (Ctrl+Alt+M)',
        click: demanderPasser,
        enabled: estConnecte(),
      },
      { type: 'separator' },
      { label: 'Configurer le serveur...', click: ouvrirConfig },
      { label: sonCoupe ? 'Retablir le son' : 'Couper le son', click: basculerSon },
      {
        label: 'Sortie audio',
        submenu:
          sortiesUtiles().length === 0
            ? [{ label: 'Detection en cours...', enabled: false }]
            : [
                {
                  label: 'Sortie par defaut de Windows',
                  type: 'radio',
                  checked: sortieChoisieId === null,
                  click: () => routerVers(null),
                },
                { type: 'separator' },
                ...sortiesUtiles()
                  .filter((s) => s.deviceId !== 'default')
                  .map((sortie) => ({
                    label: sortie.label,
                    type: 'radio',
                    checked: sortie.deviceId === sortieChoisieId,
                    click: () => routerVers(sortie.deviceId),
                  })),
              ],
      },
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
// Demarrage
// --------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  console.error('[mur] Le mur tourne deja. Regarde dans la barre des taches.');
  app.quit();
} else {
  app.whenReady().then(() => {
    // Chromium masque le nom des peripheriques audio tant que la permission
    // media n'est pas accordee. On l'accorde a notre propre page : elle n'ouvre
    // jamais le micro, elle se contente de lire la liste des sorties.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, accorder) =>
      accorder(permission === 'media'),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    creerFenetre();
    creerTray();

    globalShortcut.register('Control+Alt+M', demanderPasser);

    screen.on('display-added', surChangementEcrans);
    screen.on('display-removed', surChangementEcrans);
    screen.on('display-metrics-changed', surChangementEcrans);

    console.log('[mur] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :');
    ecrans().forEach((ecran, index) => {
      const ici = ecran.id === ecranChoisiId ? "  <-- les memes s'affichent ici" : '';
      console.log(`[mur]   ${decrire(ecran, index)}${ici}`);
    });

    console.log("[mur] Pour quitter : l'icone dans la barre des taches.");

    connecter();
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  socket?.close();
});

// L'overlay n'a pas de fenetre a fermer : il vit dans la barre des taches.
app.on('window-all-closed', () => app.quit());
