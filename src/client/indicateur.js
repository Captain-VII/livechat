// --------------------------------------------------------------------------
// L'indicateur "livechat en cours" : une petite pastille discrete sur l'AUTRE
// ecran que celui de l'overlay, le temps qu'un meme s'affiche. Pratique quand
// la bascule automatique a envoye les memes sur l'ecran d'a cote pendant un
// film ou une partie : sans lui, on ne savait pas qu'il fallait tourner la tete.
//
// Une fenetre a part, minuscule, traversee par les clics et jamais focalisee :
// elle ne doit ni gener ni sortir un jeu de son plein ecran.
// --------------------------------------------------------------------------

import path from 'node:path';

import { BrowserWindow } from 'electron';

import { COINS, boundsIndicateur, coinValide } from './coins.js';
import { ecrireConfig, lireConfig } from './reglages.js';

// Assez large pour "Livechat en cours · un pseudo" ; le reste est tronque.
const TAILLE = { largeur: 320, hauteur: 40, marge: 16 };

/**
 * @param {object} options
 * @param {string} options.dossier Le dossier de indicateur.html.
 * @param {() => import('electron').Display|null} options.getAutreEcran
 *   L'ecran ou poser l'indicateur : un autre que celui de l'overlay, ou null.
 * @param {() => void} options.surChangement Rafraichit le menu de la barre des taches.
 */
export function creerIndicateur({ dossier, getAutreEcran, surChangement }) {
  const config = lireConfig();
  let actif = config.indicateurActif ?? true;
  let coin = coinValide(config.indicateurCoin);

  /** @type {BrowserWindow|null} */
  let fenetre = null;
  /** La page de la fenetre, une fois chargee : tout appel l'attend. */
  let chargement = null;
  /** Le meme en cours, ou null : de quoi se reafficher apres un changement d'ecran. */
  let memeEnCours = null;

  function creerFenetre() {
    fenetre = new BrowserWindow({
      ...boundsIndicateur({ x: 0, y: 0, width: 800, height: 600 }, coin, TAILLE),
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    fenetre.setAlwaysOnTop(true, 'screen-saver');
    fenetre.setIgnoreMouseEvents(true);
    fenetre.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    fenetre.on('closed', () => {
      fenetre = null;
      chargement = null;
    });
    chargement = fenetre.loadFile(path.join(dossier, 'indicateur.html'));
  }

  function masquer() {
    if (fenetre && !fenetre.isDestroyed() && fenetre.isVisible()) fenetre.hide();
  }

  /** Pose (ou repose) l'indicateur selon l'etat courant. */
  async function rafraichir() {
    const ecran = getAutreEcran();
    if (!memeEnCours || !actif || !ecran) {
      masquer();
      return;
    }

    if (!fenetre || fenetre.isDestroyed()) creerFenetre();
    await chargement.catch(() => {});
    // Le meme a pu finir pendant le chargement de la fenetre.
    if (!memeEnCours || !fenetre) return;

    fenetre.setBounds(boundsIndicateur(ecran.workArea, coin, TAILLE));
    const auteur = memeEnCours.author?.name ?? '';
    await fenetre.webContents
      .executeJavaScript(`afficherIndicateur(${JSON.stringify(auteur)}, ${JSON.stringify(coin)})`)
      .catch(() => {});
    // showInactive et jamais show : show prendrait le focus, et sortirait un
    // jeu de son plein ecran.
    if (memeEnCours && fenetre && !fenetre.isVisible()) fenetre.showInactive();
  }

  function basculer() {
    actif = !actif;
    ecrireConfig({ indicateurActif: actif });
    console.log(`[livechat] Indicateur sur l'autre ecran : ${actif ? 'active' : 'desactive'}.`);
    rafraichir();
    surChangement();
  }

  function choisirCoin(nouveau) {
    coin = coinValide(nouveau);
    ecrireConfig({ indicateurCoin: coin });
    rafraichir();
    surChangement();
  }

  return {
    /** Un meme commence a s'afficher. */
    montrer(meme) {
      memeEnCours = meme;
      rafraichir();
    },

    /** Le meme est fini (ou passe). */
    cacher() {
      memeEnCours = null;
      masquer();
    },

    /** L'overlay a change d'ecran, ou un ecran a ete branche/debranche. */
    rafraichir,

    /** Le sous-menu de la barre des taches. */
    menu() {
      return [
        {
          label: 'Afficher pendant un livechat',
          type: 'checkbox',
          checked: actif,
          click: basculer,
        },
        { type: 'separator' },
        ...Object.entries(COINS).map(([cle, libelle]) => ({
          label: libelle,
          type: 'radio',
          checked: coin === cle,
          enabled: actif,
          click: () => choisirCoin(cle),
        })),
      ];
    },
  };
}
