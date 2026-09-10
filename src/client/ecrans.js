// --------------------------------------------------------------------------
// Le choix de l'ecran : personne ne veut d'un meme en plein milieu d'une ranked.
//
// Deux mecanismes cohabitent ici :
//   - le choix explicite (menu, OVERLAY_DISPLAY), qui definit l'ecran "chez soi" ;
//   - la bascule automatique, qui deplace temporairement l'overlay quand un jeu
//     occupe cet ecran, puis le ramene une fois la partie finie.
// --------------------------------------------------------------------------

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { screen } from 'electron';

import { ecrireConfig, lireConfig } from './reglages.js';

const execFileAsync = promisify(execFile);

// PowerShell fait l'appel Win32 : pas de module natif a compiler, juste un
// petit script lance a intervalles reguliers. Il rapporte trois choses sur la
// fenetre au premier plan : l'etat "plein ecran exclusif" vu par le shell, les
// bornes de son ecran, et ses propres bornes (pour reperer le plein ecran
// fenetre, que le shell ne signale pas).
const SCRIPT_SONDE_PLEIN_ECRAN = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LiveChatNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, ref RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder nom, int taille);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public static string ClasseDe(IntPtr hwnd) {
    StringBuilder nom = new StringBuilder(256);
    GetClassName(hwnd, nom, nom.Capacity);
    return nom.ToString();
  }
}
'@
$state = 0
[LiveChatNative]::SHQueryUserNotificationState([ref]$state) | Out-Null
$hwnd = [LiveChatNative]::GetForegroundWindow()
$hmon = [LiveChatNative]::MonitorFromWindow($hwnd, 2)
$mi = New-Object LiveChatNative+MONITORINFO
$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][LiveChatNative+MONITORINFO])
[LiveChatNative]::GetMonitorInfo($hmon, [ref]$mi) | Out-Null
$wr = New-Object LiveChatNative+RECT
[LiveChatNative]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
@{
  state = $state
  hwnd = [string]$hwnd
  classe = [LiveChatNative]::ClasseDe($hwnd)
  style = [LiveChatNative]::GetWindowLong($hwnd, -16)
  left = $mi.rcMonitor.Left; top = $mi.rcMonitor.Top; right = $mi.rcMonitor.Right; bottom = $mi.rcMonitor.Bottom
  wleft = $wr.Left; wtop = $wr.Top; wright = $wr.Right; wbottom = $wr.Bottom
} | ConvertTo-Json -Compress
`.trim();

// QUNS_RUNNING_D3D_FULL_SCREEN vaut 3 dans QUERY_USER_NOTIFICATION_STATE.
// Attention au voisin : 2, c'est QUNS_BUSY, renvoye en permanence sur bien des
// machines — s'en servir revenait a croire l'ecran occupe en continu, et la
// bascule suivait alors la fenetre active au lieu du plein ecran.
// Meme corrigee, cette valeur ne couvre que le vrai plein ecran DirectX : la
// plupart des jeux recents tournent en "plein ecran fenetre" (une fenetre sans
// bordure aux dimensions de l'ecran), que le shell ne signale jamais. D'ou la
// seconde detection, geometrique.
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;

// Le bureau et la barre des taches couvrent l'ecran en permanence : sans les
// ecarter, la sonde verrait un "plein ecran" des que le bureau a le focus.
const CLASSES_BUREAU = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'];

// Styles Win32 d'une fenetre. Une fenetre simplement maximisee garde sa barre
// de titre et son cadre, et l'overlay se dessine tres bien par-dessus : il n'y
// a aucune raison de changer d'ecran pour elle. Or son rectangle deborde de
// l'ecran (Windows l'agrandit de la largeur du cadre), donc la seule geometrie
// la confondrait avec un plein ecran des que la barre des taches est masquee.
const WS_MAXIMIZE = 0x01000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;

// A 3s par sondage, 2 confirmations = ~6s d'etat stable avant de bouger :
// assez court pour reagir vite, assez long pour ignorer un etat qui vacille.
const SEUIL_CONFIRMATION_POLLS = 2;

// De nombreux jeux font vaciller leur etat plein ecran pendant quelques
// secondes (overlay Discord/Steam/GeForce, ecran de chargement, changement de
// fenetre active) : sans ce garde-fou, chaque vacillement suffisant pour
// aligner deux sondages de suite faisait l'aller-retour, d'ou le clignotement
// entre les deux ecrans. On impose un delai minimum entre deux bascules.
const COOLDOWN_BASCULE_AUTO_MS = 10000;

// Apres un choix manuel, on laisse la main a l'utilisateur un moment : sinon
// la bascule auto reprend aussitot l'ecran qu'il vient justement de choisir.
const PAUSE_APRES_CHOIX_MANUEL_MS = 20000;

/**
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getFenetre
 * @param {() => void} options.surChangement Rafraichit le menu de la barre des taches.
 * @param {string} options.ecranVouluEnv Contenu de OVERLAY_DISPLAY.
 * @param {boolean} options.basculeAutoParDefaut
 */
export function creerEcrans({ getFenetre, surChangement, ecranVouluEnv, basculeAutoParDefaut }) {
  let ecranChoisiId = null;
  let ecranPrefere = null; // l'ecran "chez soi", choisi au demarrage ou a la main
  let ecranBascule = false; // true si on est la-dessus a cause de la bascule auto
  let pauseBasculeAutoJusqua = 0;

  let basculeAutoActive = basculeAutoParDefaut;
  let comptePleinEcran = 0;
  let compteRetour = 0;
  let dernierBasculeAutoTs = 0;
  let avertiEchecSonde = false;

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
    const voulu = ecranVouluEnv || lireConfig().ecranLabel || '';
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
      pauseBasculeAutoJusqua = Date.now() + PAUSE_APRES_CHOIX_MANUEL_MS;
      // Un clic dans le menu : on retient ce choix pour le prochain demarrage.
      if (ecran.label) ecrireConfig({ ecranLabel: ecran.label });
    }

    const fenetre = getFenetre();
    if (fenetre && !fenetre.isDestroyed()) {
      // La fenetre est figee (transparent + resizable est instable sur Windows) :
      // on la degele juste le temps de la reposer sur l'autre ecran.
      fenetre.setResizable(true);
      fenetre.setBounds(ecran.bounds);
      fenetre.setResizable(false);
    }

    console.log(
      `[livechat] Les memes s'affichent sur : ${ecran.label} (${ecran.bounds.width}x${ecran.bounds.height}).`,
    );
    surChangement();
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

  /** Le HWND de notre propre overlay, en decimal, pour ne pas se detecter soi-meme. */
  function handleOverlay() {
    const fenetre = getFenetre();
    if (!fenetre || fenetre.isDestroyed()) return null;
    try {
      const tampon = fenetre.getNativeWindowHandle();
      return String(tampon.length === 8 ? tampon.readBigUInt64LE(0) : BigInt(tampon.readUInt32LE(0)));
    } catch {
      return null;
    }
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

    // Win32 rend des pixels physiques, Electron raisonne en pixels logiques :
    // sur un ecran mis a l'echelle (125%, 150%... le cas de tout portable
    // recent) comparer les deux directement ne correspondait jamais, et la
    // bascule ne se declenchait pas du tout. On convertit avant de chercher.
    const coinDip = screen.screenToDipPoint({ x: info.left, y: info.top });
    const ecranActif = screen.getDisplayNearestPoint({
      x: Math.round(coinDip.x),
      y: Math.round(coinDip.y),
    });

    // Le plein ecran fenetre ne leve aucun drapeau cote shell : on le reconnait
    // a sa geometrie (une fenetre qui couvre son ecran) doublee de son style
    // (sans bordure et non maximisee), la signature d'un jeu en "borderless".
    const style = Number(info.style) | 0;
    const sansBordure = (style & WS_CAPTION) === 0 && (style & WS_THICKFRAME) === 0;
    const maximisee = (style & WS_MAXIMIZE) !== 0;
    const couvreEcran =
      sansBordure &&
      !maximisee &&
      info.wleft <= info.left &&
      info.wtop <= info.top &&
      info.wright >= info.right &&
      info.wbottom >= info.bottom;

    const estBureau = CLASSES_BUREAU.includes(info.classe);
    const estNousMemes = info.hwnd === handleOverlay();

    // Toujours compare a l'ecran PREFERE, jamais a l'ecran affiche actuellement :
    // une fois bascule ailleurs, ecranChoisiId pointe deja sur l'autre ecran, et
    // comparer a ca aurait declenche un retour au tour suivant, plein ecran ou pas.
    const pleinEcran =
      !estBureau && !estNousMemes && (info.state === QUNS_RUNNING_D3D_FULL_SCREEN || couvreEcran);
    const surEcranPrefere = ecranActif?.id === ecranPrefere?.id;
    const enPause = Date.now() < pauseBasculeAutoJusqua;

    // Un sondage isole ne suffit pas : l'etat peut vaciller (changement de
    // fenetre active, etc.). On exige plusieurs sondages d'affilee dans le meme
    // sens avant de bouger, dans les deux directions.
    if (pleinEcran && surEcranPrefere) {
      comptePleinEcran += 1;
      compteRetour = 0;
    } else {
      compteRetour += 1;
      comptePleinEcran = 0;
    }

    const horsCooldown = Date.now() - dernierBasculeAutoTs >= COOLDOWN_BASCULE_AUTO_MS;

    if (comptePleinEcran >= SEUIL_CONFIRMATION_POLLS && !ecranBascule && !enPause && horsCooldown) {
      const autre = ecrans().find((e) => e.id !== ecranPrefere?.id);
      if (autre) {
        console.log('[livechat] Plein ecran detecte sur cet ecran : bascule automatique.');
        ecranBascule = true;
        dernierBasculeAutoTs = Date.now();
        placerSur(autre, { manuel: false });
      }
      return;
    }

    if (ecranBascule && compteRetour >= SEUIL_CONFIRMATION_POLLS && horsCooldown) {
      console.log("[livechat] Plein ecran termine : retour sur l'ecran prefere.");
      ecranBascule = false;
      dernierBasculeAutoTs = Date.now();
      if (ecranPrefere) placerSur(ecranPrefere, { manuel: false });
    }
  }

  function basculerBasculeAuto() {
    basculeAutoActive = !basculeAutoActive;
    ecrireConfig({ basculeAutoActive });
    console.log(
      `[livechat] Bascule automatique d'ecran : ${basculeAutoActive ? 'activee' : 'desactivee'}.`,
    );
    surChangement();
  }

  return {
    ecrans,
    decrire,
    ecranVoulu,
    placerSur,
    surChangementEcrans,
    verifierPleinEcran,
    basculerBasculeAuto,

    /** Le choix de depart devient "chez soi", sans compter comme un clic. */
    definirEcranPrefere(ecran) {
      ecranPrefere = ecran;
      ecranChoisiId = ecran.id;
    },

    estBasculeAuto: () => ecranBascule,
    ecranChoisiId: () => ecranChoisiId,
    basculeAutoActive: () => basculeAutoActive,
  };
}
