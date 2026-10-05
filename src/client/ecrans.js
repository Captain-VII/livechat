// --------------------------------------------------------------------------
// Le choix de l'ecran : personne ne veut d'un meme en plein milieu d'une ranked.
//
// Deux mecanismes cohabitent ici :
//   - le choix explicite (menu, OVERLAY_DISPLAY), qui definit l'ecran "chez soi" ;
//   - la bascule automatique : quand on joue ou qu'on regarde un film sur
//     l'ecran principal, l'overlay part sur l'autre, puis revient une fois
//     l'activite finie (la detection elle-meme vit dans activite.js).
// --------------------------------------------------------------------------

import { screen } from 'electron';

import { etatInitial, evaluer, lireListeJeux, nomExe } from './activite.js';
import { ecrireConfig, lireConfig } from './reglages.js';

// Apres un choix manuel, on laisse la main a l'utilisateur un moment : sinon
// la bascule auto reprend aussitot l'ecran qu'il vient justement de choisir.
const PAUSE_APRES_CHOIX_MANUEL_MS = 20000;

/**
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getFenetre
 * @param {() => void} options.surChangement Rafraichit le menu de la barre des taches.
 * @param {string} options.ecranVouluEnv Contenu de OVERLAY_DISPLAY.
 * @param {boolean} options.basculeAutoParDefaut
 * @param {string} options.jeuxEnv Contenu de OVERLAY_GAMES : des exe a traiter comme des jeux.
 */
export function creerEcrans({ getFenetre, surChangement, ecranVouluEnv, basculeAutoParDefaut, jeuxEnv }) {
  let ecranChoisiId = null;
  let ecranPrefere = null; // l'ecran "chez soi", choisi au demarrage ou a la main
  let pauseBasculeAutoJusqua = 0;

  let basculeAutoActive = basculeAutoParDefaut;
  // etat.bascule : true si l'overlay est a l'abri sur l'autre ecran.
  let etat = etatInitial();

  // Les jeux que Windows ne reconnait pas : OVERLAY_GAMES, plus la liste "jeux"
  // du config.json.
  const jeuxConfig = lireConfig().jeux;
  const jeuxPerso = lireListeJeux([jeuxEnv, ...(Array.isArray(jeuxConfig) ? jeuxConfig : [])].join(';'));

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
    const nom = ecran.label || `écran ${index + 1}`;
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
      etat = etatInitial();
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
    const affiches = screen.getAllDisplays();

    // L'ecran "chez soi" est une photo prise au moment du choix : on la
    // rafraichit, sinon le retour de bascule reposerait l'overlay aux bornes
    // d'un ecran redimensionne, voire debranche (fenetre invisible).
    if (ecranPrefere) {
      const prefere = affiches.find((e) => e.id === ecranPrefere.id);
      if (!prefere) {
        console.warn("[livechat] L'ecran prefere a disparu.");
        etat = etatInitial();
      }
      ecranPrefere = prefere ?? null;
    }

    const actuel = affiches.find((e) => e.id === ecranChoisiId);
    if (actuel) {
      if (!ecranPrefere) ecranPrefere = actuel; // on adopte l'ecran ou l'on est
      placerSur(actuel, { manuel: false }); // ses bornes ont pu changer
      return;
    }
    console.warn("[livechat] L'ecran choisi a disparu.");
    etat = etatInitial();
    // Un repli, pas un choix : on ne l'ecrit pas dans la config, pour retrouver
    // l'ecran retenu quand il sera rebranche.
    const repli = ecranVoulu();
    ecranPrefere = repli;
    placerSur(repli, { manuel: false });
  }

  /** Un sondage de sonde-activite.js : partir, revenir, ou ne rien faire. */
  function surSondage(sondage) {
    if (!basculeAutoActive) return;
    const principal = screen.getPrimaryDisplay();
    const autre = ecrans().find((e) => e.id !== principal.id);
    if (!autre) return; // un seul ecran : nulle part ou aller

    // Seul l'ecran principal est surveille : si l'overlay vit deja sur un
    // autre, il est a l'abri et rien ne bouge.
    if (!etat.bascule && ecranPrefere?.id !== principal.id) return;

    const resultat = evaluer(etat, sondage, {
      maintenant: Date.now(),
      enPause: Date.now() < pauseBasculeAutoJusqua,
      jeuxConnus: sondage.jeux,
      jeuxPerso,
      pidSoi: process.pid, // les fenetres Electron appartiennent au processus principal
    });
    etat = resultat.etat;

    if (resultat.action === 'partir') {
      const { type, exe } = resultat.activite;
      const quoi = type === 'film' ? 'Film' : 'Jeu';
      console.log(`[livechat] ${quoi} sur l'ecran principal (${nomExe(exe)}) : bascule automatique.`);
      placerSur(autre, { manuel: false });
    } else if (resultat.action === 'revenir') {
      console.log("[livechat] Plus de jeu ni de film sur l'ecran principal : retour.");
      if (ecranPrefere) placerSur(ecranPrefere, { manuel: false });
    }
  }

  function basculerBasculeAuto() {
    basculeAutoActive = !basculeAutoActive;
    ecrireConfig({ basculeAutoActive });

    // Desactivee en pleine bascule : plus rien ne ramenerait l'overlay, on le
    // rentre tout de suite a la maison.
    const etaitBascule = etat.bascule;
    etat = etatInitial();
    if (!basculeAutoActive && etaitBascule && ecranPrefere) placerSur(ecranPrefere, { manuel: false });
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
    surSondage,
    basculerBasculeAuto,

    /** Le choix de depart devient "chez soi", sans compter comme un clic. */
    definirEcranPrefere(ecran) {
      ecranPrefere = ecran;
      ecranChoisiId = ecran.id;
    },

    estBasculeAuto: () => etat.bascule,
    ecranChoisiId: () => ecranChoisiId,
    basculeAutoActive: () => basculeAutoActive,
  };
}
