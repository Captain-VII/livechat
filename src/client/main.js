import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
} from 'electron';

import { creerAudio } from './audio.js';
import { creerEcrans } from './ecrans.js';
import { demarrerVerificationMaj, verificationEnCours, verifierMajMaintenant } from './maj.js';
import { ecrireConfig, lireConfig, reglage, reglageActif } from './reglages.js';
import { normaliserUrlServeur } from './url-serveur.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VOLUME = reglage('OVERLAY_VOLUME', 0.7, { min: 0, max: 1 });

// Sur quel ecran les memes apparaissent. Vide ou "principal" : l'ecran principal.
const ECRAN_VOULU = (process.env.OVERLAY_DISPLAY ?? '').trim();

// Sur quelle sortie audio le son part. Vide ou "defaut" : celle de Windows.
const SORTIE_VOULUE = (process.env.OVERLAY_AUDIO_DEVICE ?? '').trim();

// Bascule tout seul sur un autre ecran quand un jeu ou un film occupe l'ecran
// choisi. La variable d'environnement prime ; sinon, le dernier choix du menu.
const BASCULE_AUTO_ACTIVE = reglageActif(
  'OVERLAY_AUTO_SWITCH',
  lireConfig().basculeAutoActive ?? true,
);

// Verifie les mises a jour tout seul, en arriere-plan. 'off' desactive.
const MAJ_AUTO_ACTIVE = reglageActif('OVERLAY_AUTO_UPDATE', true);

// Le nom sous lequel ce client apparait dans /connectes cote Discord. Par
// defaut le pseudo Windows de la session : ca marche sans rien configurer,
// et OVERLAY_NAME permet d'en mettre un plus parlant.
const PSEUDO = ((process.env.OVERLAY_NAME ?? '').trim() || os.userInfo().username || 'anonyme').slice(0, 32);

// Une bulle de discussion avec une pastille "live", 32x32 : l'icone de la
// barre des taches, en dur, pour ne pas trimballer un binaire dans le depot.
const ICONE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABN0lEQVR42mN4Eq7HMJCYYVg74PP7JwKf3z9xgGIBchwA0uRAKn5eHuLz8faZ7Z/fP/mPhvvRHYLL4oAn4Xrnn4Tr/ScVP02w/P/h0qH/WCyH4f2EHJBAjsUw/GZxJz7LYTgBlwMUKLEchD/eOUuMA/bjckA/pQ4gwnIwxuWA/ZQ64NOzmwQt//Tw8hOaOeDttgUEHfD+yMbjNHPAsyxXvKEAknuW6dxOMweA8POSAKyOACVQkBzQrgaaOgBWHryeVQeOkjdrpvx/NaEILAaVp70DCOBRB4w6AKcD5tPJAQ64HOBAB8vvE6qOaR0KAcQ0SPpp5PMAUppkoKbTezRDzkMTECm4ADnOSXGAARbLBejZKkZOC/MHolkOC/7+gegXwBqmCQPVMZlPD8txOUAAmgBH+4YjwwEAz3gC4Y1oil8AAAAASUVORK5CYII=';

// Chromium refuse l'autoplay avec du son sans geste utilisateur. Il n'y a personne
// pour cliquer sur un overlay traverse par les clics : on leve la regle.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let fenetre = null;
let fenetreConfig = null;
let tray = null;
let sonCoupe = lireConfig().sonCoupe ?? false;

const getFenetre = () => fenetre;

const ecrans = creerEcrans({
  getFenetre,
  surChangement: () => majMenu(),
  ecranVouluEnv: ECRAN_VOULU,
  basculeAutoParDefaut: BASCULE_AUTO_ACTIVE,
});

const audio = creerAudio({
  getFenetre,
  surChangement: () => majMenu(),
  sortieVoulueEnv: SORTIE_VOULUE,
});

// --------------------------------------------------------------------------
// L'adresse du serveur. Un ami qui lance le .exe n'a ni .env ni terminal ;
// c'est la petite fenetre de configuration qui la lui demande.
// --------------------------------------------------------------------------

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

// Une coupure ne se voyait que dans la console, que personne n'ouvre : un ami
// pouvait passer une soiree devant un overlay muet sans comprendre pourquoi.
// On previent donc, mais seulement si ca dure : un wifi qui tousse une seconde
// se repare tout seul et ne merite pas de notification.
const DELAI_AVANT_ALERTE_MS = 20000;
let coupureDepuis = 0;
let alerteCoupureEnvoyee = false;
let minuteurAlerte = null;

function notifier(corps) {
  if (!Notification.isSupported()) return;
  new Notification({ title: 'LiveChat', body: corps, silent: true }).show();
}

function surConnexionPerdue() {
  if (!coupureDepuis) coupureDepuis = Date.now();
  if (minuteurAlerte || alerteCoupureEnvoyee) return;

  minuteurAlerte = setTimeout(() => {
    minuteurAlerte = null;
    if (estConnecte()) return;
    alerteCoupureEnvoyee = true;
    notifier('Connexion au serveur perdue. Nouvelles tentatives en cours...');
  }, DELAI_AVANT_ALERTE_MS);
}

function surConnexionRetablie() {
  clearTimeout(minuteurAlerte);
  minuteurAlerte = null;
  // On ne fete le retour que si on avait signale le depart : sinon la premiere
  // connexion au lancement declencherait une notification pour rien.
  if (alerteCoupureEnvoyee) {
    const duree = coupureDepuis ? Math.round((Date.now() - coupureDepuis) / 1000) : 0;
    notifier(`Connexion retablie${duree ? ` apres ${duree} s` : ''}.`);
  }
  alerteCoupureEnvoyee = false;
  coupureDepuis = 0;
}

function connecter() {
  const url = urlServeur();
  if (!url) {
    ouvrirConfig();
    return;
  }

  console.log(`[livechat] Connexion a ${url}...`);
  majMenu();
  notifierConfig({ type: 'connexion' });

  // Le pseudo part dans l'URL : c'est ce que /connectes cote Discord affiche.
  let urlAvecPseudo = url;
  try {
    const u = new URL(url);
    u.searchParams.set('pseudo', PSEUDO);
    urlAvecPseudo = u.toString();
  } catch {
    // Adresse invalide : tant pis pour le pseudo, l'erreur normale plus bas s'en charge.
  }

  try {
    socket = new WebSocket(urlAvecPseudo);
  } catch (erreur) {
    console.error('[livechat] Adresse de serveur invalide :', erreur.message);
    ouvrirConfig();
    return;
  }

  socket.addEventListener('open', () => {
    console.log('[livechat] Connecte au serveur.');
    delaiReconnexion = DELAI_RECONNEXION_MIN_MS;
    surConnexionRetablie();
    majMenu();
    notifierConfig({ type: 'ouvert' });
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
    console.warn(`[livechat] Deconnecte du serveur. Nouvelle tentative dans ${delaiReconnexion} ms.`);
    surConnexionPerdue();
    majMenu();
    notifierConfig({ type: 'ferme', prochaineTentativeMs: delaiReconnexion });
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

// Un simple carre orange, genere sur place : verifie l'affichage (ecran, taille,
// son) sans avoir besoin d'attendre un vrai meme depuis Discord.
const IMAGE_TEST =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">' +
      '<rect width="100%" height="100%" fill="#e4572e"/>' +
      '<text x="50%" y="50%" font-size="48" fill="#fff" font-family="sans-serif" ' +
      'text-anchor="middle" dominant-baseline="middle">Test</text></svg>',
  );

let idTest = -1;

/** Affiche un faux meme localement, sans passer par le serveur ni Discord. */
function testerMeme() {
  afficher({
    id: idTest--,
    rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
    duree: 8000,
    author: { name: 'Toi (test)', avatar: '' },
    text: null,
    mediaUrl: IMAGE_TEST,
    mediaType: 'image',
  });
  setTimeout(cacher, 8000);
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
  ecrireConfig({ sonCoupe });
  console.log(`[livechat] Son ${sonCoupe ? 'coupe' : 'retabli'}.`);
  majMenu();
}

// --------------------------------------------------------------------------
// Les messages de la fenetre overlay
// --------------------------------------------------------------------------

ipcMain.on('sorties-audio', (_evenement, liste) => audio.surSortiesAnnoncees(liste));

// Le bouton "Passer" affiche sur l'overlay lui-meme : la fenetre entiere
// redevient cliquable pendant le survol (le seul moyen d'avoir une zone
// cliquable dans une fenetre par ailleurs traversee par les clics), et
// repasse traversee des que le curseur en sort.
ipcMain.on('demander-passer', () => demanderPasser());
ipcMain.on('survol-bouton-passer', (_evenement, survole) => {
  fenetre?.setIgnoreMouseEvents(!survole, { forward: true });
});

// --------------------------------------------------------------------------
// La fenetre de reglage du serveur : le seul endroit ou un ami sans terminal
// doit taper quelque chose.
// --------------------------------------------------------------------------

ipcMain.handle('config:lire', () => ({ serverUrl: urlServeur() ?? '' }));
ipcMain.handle('config:sauver', (_evenement, url) => {
  const resultat = normaliserUrlServeur(url);
  if (!resultat.ok) return resultat;
  changerServeur(resultat.url);
  return { ok: true, url: resultat.url };
});

/** Tient la fenetre de reglage au courant de l'etat reel de la connexion. */
function notifierConfig(statut) {
  if (fenetreConfig && !fenetreConfig.isDestroyed()) {
    fenetreConfig.webContents.send('config:statut', statut);
  }
}

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
    title: 'LiveChat — Serveur',
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
  const ecran = ecrans.ecranVoulu();
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

  // Le choix de depart devient "chez soi", mais ce n'est pas un clic de
  // l'utilisateur : pas de pause de la bascule automatique pour autant.
  ecrans.definirEcranPrefere(ecran);

  // A la creation, Windows rabote la fenetre a la zone de travail : elle perd la
  // hauteur de la barre des taches. On repose les bornes exactes par le meme
  // chemin que le changement d'ecran.
  ecrans.placerSur(ecran, { manuel: false });
}

// --------------------------------------------------------------------------
// Icone de notification : sans elle, une fenetre traversee par les clics et
// absente de la barre des taches serait impossible a quitter.
// --------------------------------------------------------------------------

function menuSortieAudio() {
  const sorties = audio.sortiesUtiles();
  if (sorties.length === 0) return [{ label: 'Detection en cours...', enabled: false }];

  return [
    {
      label: 'Sortie par defaut de Windows',
      type: 'radio',
      checked: audio.sortieChoisieId() === null,
      click: () => audio.routerVers(null, { manuel: true }),
    },
    { type: 'separator' },
    ...sorties
      .filter((s) => s.deviceId !== 'default')
      .map((sortie) => ({
        label: sortie.label,
        type: 'radio',
        checked: sortie.deviceId === audio.sortieChoisieId(),
        click: () => audio.routerVers(sortie.deviceId, { manuel: true }),
      })),
  ];
}

function menuEcrans() {
  const choisi = ecrans.ecranChoisiId();
  return [
    ...ecrans.ecrans().map((ecran, index) => ({
      label:
        ecrans.decrire(ecran, index) +
        (ecrans.estBasculeAuto() && ecran.id === choisi ? ' (bascule auto)' : ''),
      type: 'radio',
      checked: ecran.id === choisi,
      click: () => ecrans.placerSur(ecran),
    })),
    { type: 'separator' },
    {
      label: 'Basculer seul si plein ecran ailleurs',
      type: 'checkbox',
      checked: ecrans.basculeAutoActive(),
      click: () => ecrans.basculerBasculeAuto(),
    },
  ];
}

function majMenu() {
  if (!tray) return;

  const etatConnexion = estConnecte() ? 'Connecte' : 'Deconnecte...';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `LiveChat — ${etatConnexion}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Passer ce meme  (Ctrl+Alt+M)',
        click: demanderPasser,
        enabled: estConnecte(),
      },
      { label: 'Tester un meme', click: testerMeme },
      { type: 'separator' },
      { label: 'Configurer le serveur...', click: ouvrirConfig },
      { label: sonCoupe ? 'Retablir le son' : 'Couper le son', click: basculerSon },
      { label: 'Sortie audio', submenu: menuSortieAudio() },
      { label: 'Afficher sur', submenu: menuEcrans() },
      {
        label: 'Demarrer avec Windows',
        type: 'checkbox',
        checked: demarreAvecWindows(),
        enabled: app.isPackaged,
        click: basculerDemarrageAvecWindows,
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      {
        label: verificationEnCours() ? 'Verification en cours...' : 'Verifier les mises a jour...',
        enabled: app.isPackaged && !verificationEnCours(),
        click: () => verifierMajMaintenant({ surChangement: majMenu }),
      },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]),
  );
}

function creerTray() {
  tray = new Tray(nativeImage.createFromDataURL(ICONE_PNG));
  tray.setToolTip('LiveChat');
  majMenu();
  tray.on('click', () => tray.popUpContextMenu());
}

// --------------------------------------------------------------------------
// Demarrer avec Windows : app.setLoginItemSettings gere lui-meme la cle de
// registre "Run", sans dependance supplementaire. Ne marche que sur une
// version installee (chemin stable) — en developpement, process.execPath
// pointe sur electron.exe et l'option n'a pas de sens.
// --------------------------------------------------------------------------

function demarreAvecWindows() {
  return app.isPackaged && app.getLoginItemSettings().openAtLogin;
}

function basculerDemarrageAvecWindows() {
  if (!app.isPackaged) return;
  const actuel = demarreAvecWindows();
  app.setLoginItemSettings({ openAtLogin: !actuel });
  console.log(`[livechat] Demarrage avec Windows : ${!actuel ? 'active' : 'desactive'}.`);
  majMenu();
}

// --------------------------------------------------------------------------
// Demarrage
// --------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  console.error('[livechat] LiveChat tourne deja. Regarde dans la barre des taches.');
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

    screen.on('display-added', ecrans.surChangementEcrans);
    screen.on('display-removed', ecrans.surChangementEcrans);
    screen.on('display-metrics-changed', ecrans.surChangementEcrans);

    if (ecrans.ecrans().length > 1) setInterval(ecrans.verifierPleinEcran, 3000).unref();

    demarrerVerificationMaj({ actif: MAJ_AUTO_ACTIVE, surChangement: majMenu });

    console.log('[livechat] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :');
    ecrans.ecrans().forEach((ecran, index) => {
      const ici = ecran.id === ecrans.ecranChoisiId() ? "  <-- les memes s'affichent ici" : '';
      console.log(`[livechat]   ${ecrans.decrire(ecran, index)}${ici}`);
    });

    console.log("[livechat] Pour quitter : l'icone dans la barre des taches.");

    connecter();
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  socket?.close();
});

// L'overlay n'a pas de fenetre a fermer : il vit dans la barre des taches.
app.on('window-all-closed', () => app.quit());
