import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// --------------------------------------------------------------------------
// Configuration persistante : reglages choisis a la main (menu), qui doivent
// survivre a un redemarrage du PC. L'adresse du serveur y vivait deja seule ;
// ecran, sortie audio, son coupe et bascule auto la rejoignent ici.
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

const VOLUME = reglage('OVERLAY_VOLUME', 0.7, { min: 0, max: 1 });

// Sur quel ecran les memes apparaissent. Vide ou "principal" : l'ecran principal.
const ECRAN_VOULU = (process.env.OVERLAY_DISPLAY ?? '').trim();

// Sur quelle sortie audio le son part. Vide ou "defaut" : celle de Windows.
const SORTIE_VOULUE = (process.env.OVERLAY_AUDIO_DEVICE ?? '').trim();

// Bascule tout seul sur un autre ecran quand un jeu ou un film tourne en plein
// ecran exclusif sur l'ecran choisi (sans ca, l'overlay ne pourrait pas s'y
// dessiner de toute facon). 'off' desactive completement.
const OVERLAY_AUTO_SWITCH_ENV = (process.env.OVERLAY_AUTO_SWITCH ?? '').trim();
const BASCULE_AUTO_ACTIVE = OVERLAY_AUTO_SWITCH_ENV
  ? !/^(off|non|false)$/i.test(OVERLAY_AUTO_SWITCH_ENV)
  : (lireConfig().basculeAutoActive ?? true);

// Verifie les mises a jour tout seul, en arriere-plan. 'off' desactive.
const MAJ_AUTO_ACTIVE = !/^(off|non|false)$/i.test(
  (process.env.OVERLAY_AUTO_UPDATE ?? 'on').trim(),
);

// Le nom sous lequel ce client apparait dans /connectes cote Discord. Par
// defaut le pseudo Windows de la session : ca marche sans rien configurer,
// et OVERLAY_NAME permet d'en mettre un plus parlant.
const PSEUDO = ((process.env.OVERLAY_NAME ?? '').trim() || os.userInfo().username || 'anonyme').slice(0, 32);

// Une bulle de discussion avec une pastille "live", 32x32 : l'icone de la
// barre des taches, en dur, pour ne pas trimballer un binaire dans le depot.
const ICONE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABN0lEQVR42mN4Eq7HMJCY' +
  'YVg74PP7JwKf3z9xgGIBchwA0uRAKn5eHuLz8faZ7Z/fP/mPhvvRHYLL4oAn4Xrnn4Tr/ScVP02w/P/h0qH/WCyH4f' +
  '2EHJBAjsUw/GZxJz7LYTgBlwMUKLEchD/eOUuMA/bjckA/pQ4gwnIwxuWA/ZQ64NOzmwQt//Tw8hOaOeDttgUEHfD+' +
  'yMbjNHPAsyxXvKEAknuW6dxOMweA8POSAKyOACVQkBzQrgaaOgBWHryeVQeOkjdrpvx/NaEILAaVp70DCOBRB4w6AK' +
  'cD5tPJAQ64HOBAB8vvE6qOaR0KAcQ0SPpp5PMAUppkoKbTezRDzkMTECm4ADnOSXGAARbLBejZKkZOC/MHolkOC/7' +
  '+gegXwBqmCQPVMZlPD8txOUAAmgBH+4YjwwEAz3gC4Y1oil8AAAAASUVORK5CYII=';

// Chromium refuse l'autoplay avec du son sans geste utilisateur. Il n'y a personne
// pour cliquer sur un overlay traverse par les clics : on leve la regle.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let fenetre = null;
let fenetreConfig = null;
let tray = null;
let ecranChoisiId = null;
let ecranPrefere = null; // l'ecran "chez soi", choisi au demarrage ou a la main
let ecranBascule = false; // true si on est la-dessus a cause de la bascule auto
let pauseBasculeAutoJusqua = 0;
let sonCoupe = lireConfig().sonCoupe ?? false;

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
  // OVERLAY_DISPLAY prime ; sinon, le dernier ecran choisi a la main (menu),
  // retenu d'une session a l'autre.
  const voulu = ECRAN_VOULU || lireConfig().ecranLabel || '';
  if (!voulu || /^(principal|primary)$/i.test(voulu)) return liste[0];

  const numero = Number(voulu);
  const trouve = Number.isInteger(numero)
    ? liste[numero - 1]
    : liste.find((e) => e.label?.toLowerCase().includes(voulu.toLowerCase()));

  if (trouve) return trouve;

  console.warn(`[livechat] Ecran voulu ("${voulu}") introuvable.`);
  console.warn('[livechat] On reste sur le principal. Ecrans disponibles :');
  liste.forEach((e, i) => console.warn(`[livechat]   ${decrire(e, i)}`));
  return liste[0];
}

/** Deplace l'overlay sur un ecran, tout de suite. */
function placerSur(ecran, { manuel = true } = {}) {
  if (!ecran) return;
  ecranChoisiId = ecran.id;

  if (manuel) {
    // Un choix explicite (menu, ou reglage au demarrage) devient le nouveau
    // "chez soi" : c'est la qu'on revient une fois le plein ecran termine.
    ecranPrefere = ecran;
    ecranBascule = false;
    // Empeche la bascule auto de revenir immediatement dessus si l'utilisateur
    // vient justement de choisir a la main l'ecran qui est en plein ecran.
    pauseBasculeAutoJusqua = Date.now() + 20000;
    // Un clic dans le menu : on retient ce choix pour le prochain demarrage.
    if (ecran.label) ecrireConfig({ ecranLabel: ecran.label });
  }

  if (fenetre && !fenetre.isDestroyed()) {
    // La fenetre est figee (transparent + resizable est instable sur Windows) :
    // on la degele juste le temps de la reposer sur l'autre ecran.
    fenetre.setResizable(true);
    fenetre.setBounds(ecran.bounds);
    fenetre.setResizable(false);
  }

  console.log(`[livechat] Les memes s'affichent sur : ${ecran.label} (${ecran.bounds.width}x${ecran.bounds.height}).`);
  majMenu();
}

/** Un ecran branche, debranche ou redimensionne : on se recale. */
function surChangementEcrans() {
  const actuel = screen.getAllDisplays().find((e) => e.id === ecranChoisiId);
  if (actuel) {
    placerSur(actuel, { manuel: false }); // ses bornes ont pu changer
    return;
  }
  console.warn("[livechat] L'ecran choisi a disparu.");
  ecranBascule = false;
  placerSur(ecranVoulu());
}

// --------------------------------------------------------------------------
// Bascule automatique : un jeu ou un film en plein ecran exclusif empeche
// n'importe quelle fenetre (donc l'overlay) de se dessiner par-dessus. Windows
// expose justement une API pour le detecter (SHQueryUserNotificationState,
// celle qui sert normalement a couper les notifications pendant un jeu) ; on
// s'en sert pour deplacer les memes sur un autre ecran le temps que ca dure.
// --------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// PowerShell fait l'appel Win32 : pas de module natif a compiler, juste un
// petit script lance a intervalles reguliers.
const SCRIPT_SONDE_PLEIN_ECRAN = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LiveChatNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
'@
$state = 0
[LiveChatNative]::SHQueryUserNotificationState([ref]$state) | Out-Null
$hwnd = [LiveChatNative]::GetForegroundWindow()
$hmon = [LiveChatNative]::MonitorFromWindow($hwnd, 2)
$mi = New-Object LiveChatNative+MONITORINFO
$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][LiveChatNative+MONITORINFO])
[LiveChatNative]::GetMonitorInfo($hmon, [ref]$mi) | Out-Null
@{ state = $state; left = $mi.rcMonitor.Left; top = $mi.rcMonitor.Top; right = $mi.rcMonitor.Right; bottom = $mi.rcMonitor.Bottom } | ConvertTo-Json -Compress
`.trim();

// QUNS_RUNNING_D3D_FULL_SCREEN : la valeur specifique a "quelque chose occupe
// l'ecran en exclusif", pas juste "une fenetre maximisee".
const QUNS_RUNNING_D3D_FULL_SCREEN = 2;

let basculeAutoActive = BASCULE_AUTO_ACTIVE;
let comptePleinEcran = 0;
let compteRetour = 0;
// A 3s par sondage (voir plus bas), 2 confirmations = ~6s de plein ecran
// continu avant de bouger : assez court pour reagir vite, assez long pour
// ignorer un etat qui vacille (ex. changement de fenetre active).
const SEUIL_CONFIRMATION_POLLS = 2;
let avertiEchecSonde = false;

function basculerBasculeAuto() {
  basculeAutoActive = !basculeAutoActive;
  ecrireConfig({ basculeAutoActive });
  console.log(`[livechat] Bascule automatique d'ecran : ${basculeAutoActive ? 'activee' : 'desactivee'}.`);
  majMenu();
}

async function verifierPleinEcran() {
  if (!basculeAutoActive) return;

  let info;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT_SONDE_PLEIN_ECRAN],
      { timeout: 3000, windowsHide: true },
    );
    info = JSON.parse(stdout);
  } catch (erreur) {
    if (!avertiEchecSonde) {
      avertiEchecSonde = true;
      console.warn('[livechat] Detection du plein ecran indisponible :', erreur.message);
    }
    return;
  }

  const largeur = info.right - info.left;
  const hauteur = info.bottom - info.top;
  const ecranActif = ecrans().find(
    (e) => e.bounds.x === info.left && e.bounds.y === info.top && e.bounds.width === largeur && e.bounds.height === hauteur,
  );

  // Toujours compare a l'ecran PREFERE, jamais a l'ecran affiche actuellement :
  // une fois bascule ailleurs, ecranChoisiId pointe deja sur l'autre ecran, et
  // comparer a ca aurait declenche un retour au tour suivant, plein ecran ou pas.
  const pleinEcranExclusif = info.state === QUNS_RUNNING_D3D_FULL_SCREEN;
  const surEcranPrefere = ecranActif?.id === ecranPrefere?.id;
  const enPause = Date.now() < pauseBasculeAutoJusqua;

  // Un sondage isole ne suffit pas : l'etat peut vaciller (changement de
  // fenetre active, etc.). On exige plusieurs sondages d'affilee dans le meme
  // sens avant de bouger, dans les deux directions.
  if (pleinEcranExclusif && surEcranPrefere) {
    comptePleinEcran += 1;
    compteRetour = 0;
  } else {
    compteRetour += 1;
    comptePleinEcran = 0;
  }

  if (comptePleinEcran >= SEUIL_CONFIRMATION_POLLS && !ecranBascule && !enPause) {
    const autre = ecrans().find((e) => e.id !== ecranPrefere?.id);
    if (autre) {
      console.log('[livechat] Plein ecran detecte sur cet ecran : bascule automatique.');
      ecranBascule = true;
      placerSur(autre, { manuel: false });
    }
    return;
  }

  if (ecranBascule && compteRetour >= SEUIL_CONFIRMATION_POLLS) {
    console.log("[livechat] Plein ecran termine : retour sur l'ecran prefere.");
    ecranBascule = false;
    if (ecranPrefere) placerSur(ecranPrefere, { manuel: false });
  }
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
  // OVERLAY_AUDIO_DEVICE prime ; sinon, la derniere sortie choisie a la main.
  const voulue = SORTIE_VOULUE || lireConfig().sortieAudioLabel || '';
  if (!voulue || /^(defaut|default)$/i.test(voulue)) return null;

  const trouvee = sortiesUtiles().find((s) => s.label?.toLowerCase().includes(voulue.toLowerCase()));
  if (trouvee) return trouvee.deviceId;

  console.warn(`[livechat] Sortie audio voulue ("${voulue}") introuvable.`);
  console.warn('[livechat] On reste sur la sortie par defaut. Sorties disponibles :');
  sortiesUtiles().forEach((s) => console.warn(`[livechat]   ${s.label}`));
  return null;
}

/** Envoie le son vers une sortie. null = celle de Windows. manuel : clic dans le menu, a retenir. */
function routerVers(deviceId, { manuel = false } = {}) {
  sortieChoisieId = deviceId;
  if (manuel) {
    const label = sortiesUtiles().find((s) => s.deviceId === deviceId)?.label ?? null;
    ecrireConfig({ sortieAudioLabel: label });
  }
  if (fenetre && !fenetre.isDestroyed()) {
    fenetre.webContents.send('sortie-audio', deviceId ?? 'default');
  }
  const nom = sortiesUtiles().find((s) => s.deviceId === deviceId)?.label;
  console.log(`[livechat] Son envoye sur : ${nom ?? 'la sortie par defaut de Windows'}.`);
  majMenu();
}

/** La fenetre vient d'enumerer les peripheriques (au demarrage, ou apres un branchement). */
function surSortiesAnnoncees(liste) {
  const premiereFois = sortiesAudio.length === 0;
  sortiesAudio = liste;

  if (premiereFois) {
    console.log('[livechat] Sorties audio (nom a mettre dans OVERLAY_AUDIO_DEVICE) :');
    sortiesUtiles().forEach((s) => console.log(`[livechat]   ${s.label}`));
  }

  // La sortie choisie a pu disparaitre avec le peripherique.
  const existeEncore = sortiesUtiles().some((s) => s.deviceId === sortieChoisieId);
  if (sortieChoisieId && !existeEncore) {
    console.warn('[livechat] La sortie audio choisie a disparu. Retour a celle par defaut.');
    routerVers(sortieVoulue());
    return;
  }

  if (premiereFois) routerVers(sortieVoulue());
  else majMenu();
}

ipcMain.on('sorties-audio', (_evenement, liste) => surSortiesAnnoncees(liste));

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
  const propre = url.trim();
  if (!propre) return { ok: false, erreur: 'Adresse vide.' };
  if (!/^wss?:\/\//i.test(propre)) {
    return { ok: false, erreur: "L'adresse doit commencer par ws:// ou wss://." };
  }
  changerServeur(propre);
  return { ok: true };
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

  // Le choix de depart devient "chez soi", mais ce n'est pas un clic de
  // l'utilisateur : pas de pause de la bascule automatique pour autant.
  ecranPrefere = ecran;

  // A la creation, Windows rabote la fenetre a la zone de travail : elle perd la
  // hauteur de la barre des taches. On repose les bornes exactes par le meme
  // chemin que le changement d'ecran.
  placerSur(ecran, { manuel: false });
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
                  click: () => routerVers(null, { manuel: true }),
                },
                { type: 'separator' },
                ...sortiesUtiles()
                  .filter((s) => s.deviceId !== 'default')
                  .map((sortie) => ({
                    label: sortie.label,
                    type: 'radio',
                    checked: sortie.deviceId === sortieChoisieId,
                    click: () => routerVers(sortie.deviceId, { manuel: true }),
                  })),
              ],
      },
      {
        label: 'Afficher sur',
        submenu: [
          ...ecrans().map((ecran, index) => ({
            label: decrire(ecran, index) + (ecranBascule && ecran.id === ecranChoisiId ? ' (bascule auto)' : ''),
            type: 'radio',
            checked: ecran.id === ecranChoisiId,
            click: () => placerSur(ecran),
          })),
          { type: 'separator' },
          {
            label: 'Basculer seul si plein ecran ailleurs',
            type: 'checkbox',
            checked: basculeAutoActive,
            click: basculerBasculeAuto,
          },
        ],
      },
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
        label: verificationManuelleEnCours ? 'Verification en cours...' : 'Verifier les mises a jour...',
        enabled: app.isPackaged && !verificationManuelleEnCours,
        click: verifierMajMaintenant,
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
// Mise a jour automatique : verifie la derniere release GitHub, telecharge en
// silence, et s'installe au prochain redemarrage de l'appli. Rien a faire cote
// utilisateur. N'a de sens que sur une version installee (electron-updater
// s'appuie sur des fichiers ecrits a cote de l'appli par l'installeur).
// --------------------------------------------------------------------------

// Vrai uniquement le temps d'une verification demandee a la main depuis le
// menu : ca evite que les controles silencieux en arriere-plan se mettent a
// notifier "deja a jour" toutes les 6h sans qu'on ait rien demande.
let verificationManuelleEnCours = false;

function demarrerVerificationMaj() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    console.log(`[maj] Mise a jour ${info.version} disponible, telechargement...`);
  });
  autoUpdater.on('update-not-available', () => {
    if (!verificationManuelleEnCours) return;
    verificationManuelleEnCours = false;
    console.log('[maj] Deja a jour.');
    if (Notification.isSupported()) {
      new Notification({
        title: 'LiveChat',
        body: `Deja a jour (version ${app.getVersion()}).`,
        silent: true,
      }).show();
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    verificationManuelleEnCours = false;
    console.log(`[maj] Mise a jour ${info.version} prete. Redemarrage dans 15 s.`);

    if (Notification.isSupported()) {
      new Notification({
        title: 'LiveChat',
        body: `Mise a jour ${info.version} installee. Redemarrage dans 15 secondes...`,
        silent: true,
      }).show();
    }

    // Un delai plutot qu'un redemarrage immediat : le temps que la
    // notification s'affiche, et de ne pas couper un meme en plein milieu.
    setTimeout(() => autoUpdater.quitAndInstall(), 15000);
  });
  autoUpdater.on('error', (erreur) => {
    console.warn('[maj] Verification impossible :', erreur.message);
    if (!verificationManuelleEnCours) return;
    verificationManuelleEnCours = false;
    if (Notification.isSupported()) {
      new Notification({
        title: 'LiveChat',
        body: `Verification impossible : ${erreur.message}`,
        silent: true,
      }).show();
    }
  });

  const verifier = () => autoUpdater.checkForUpdates().catch(() => {});

  if (MAJ_AUTO_ACTIVE) {
    // Un delai au demarrage pour ne pas concurrencer la connexion initiale,
    // puis un controle toutes les 6h — utile si l'appli reste ouverte plusieurs
    // jours (un PC dedie a l'overlay, par exemple).
    setTimeout(verifier, 10000);
    setInterval(verifier, 6 * 60 * 60 * 1000).unref();
  }
}

/** Verification demandee a la main depuis le menu : celle-la donne toujours une reponse visible. */
function verifierMajMaintenant() {
  if (!app.isPackaged) return;
  verificationManuelleEnCours = true;
  console.log('[maj] Verification manuelle...');
  majMenu();
  autoUpdater.checkForUpdates().catch((erreur) => {
    verificationManuelleEnCours = false;
    console.warn('[maj] Verification impossible :', erreur.message);
  });
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

    screen.on('display-added', surChangementEcrans);
    screen.on('display-removed', surChangementEcrans);
    screen.on('display-metrics-changed', surChangementEcrans);

    if (ecrans().length > 1) setInterval(verifierPleinEcran, 3000).unref();

    demarrerVerificationMaj();

    console.log('[livechat] Ecrans detectes (numero a mettre dans OVERLAY_DISPLAY) :');
    ecrans().forEach((ecran, index) => {
      const ici = ecran.id === ecranChoisiId ? "  <-- les memes s'affichent ici" : '';
      console.log(`[livechat]   ${decrire(ecran, index)}${ici}`);
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
