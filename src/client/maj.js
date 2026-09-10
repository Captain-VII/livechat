// --------------------------------------------------------------------------
// Mise a jour automatique : verifie la derniere release GitHub, telecharge en
// silence, et s'installe au prochain redemarrage de l'appli. Rien a faire cote
// utilisateur. N'a de sens que sur une version installee (electron-updater
// s'appuie sur des fichiers ecrits a cote de l'appli par l'installeur).
// --------------------------------------------------------------------------

import electronUpdater from 'electron-updater';
import { Notification, app } from 'electron';

const { autoUpdater } = electronUpdater;

const INTERVALLE_VERIFICATION_MS = 6 * 60 * 60 * 1000;
const DELAI_AVANT_PREMIERE_VERIFICATION_MS = 10000;
const DELAI_AVANT_REDEMARRAGE_MS = 15000;

// Vrai uniquement le temps d'une verification demandee a la main depuis le
// menu : ca evite que les controles silencieux en arriere-plan se mettent a
// notifier "deja a jour" toutes les 6h sans qu'on ait rien demande.
let verificationManuelleEnCours = false;

function notifier(corps) {
  if (!Notification.isSupported()) return;
  new Notification({ title: 'LiveChat', body: corps, silent: true }).show();
}

/**
 * @param {object} options
 * @param {boolean} options.actif Verification periodique en arriere-plan.
 * @param {() => void} options.surChangement Rafraichit le menu de la barre des taches.
 */
export function demarrerVerificationMaj({ actif, surChangement }) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    console.log(`[maj] Mise a jour ${info.version} disponible, telechargement...`);
  });

  autoUpdater.on('update-not-available', () => {
    if (!verificationManuelleEnCours) return;
    verificationManuelleEnCours = false;
    surChangement();
    console.log('[maj] Deja a jour.');
    notifier(`Deja a jour (version ${app.getVersion()}).`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    verificationManuelleEnCours = false;
    surChangement();
    console.log(`[maj] Mise a jour ${info.version} prete. Redemarrage dans 15 s.`);
    notifier(`Mise a jour ${info.version} installee. Redemarrage dans 15 secondes...`);

    // Un delai plutot qu'un redemarrage immediat : le temps que la
    // notification s'affiche, et de ne pas couper un meme en plein milieu.
    setTimeout(() => autoUpdater.quitAndInstall(), DELAI_AVANT_REDEMARRAGE_MS);
  });

  autoUpdater.on('error', (erreur) => {
    console.warn('[maj] Verification impossible :', erreur.message);
    if (!verificationManuelleEnCours) return;
    verificationManuelleEnCours = false;
    surChangement();
    notifier(`Verification impossible : ${erreur.message}`);
  });

  const verifier = () => autoUpdater.checkForUpdates().catch(() => {});

  if (actif) {
    // Un delai au demarrage pour ne pas concurrencer la connexion initiale,
    // puis un controle toutes les 6h — utile si l'appli reste ouverte plusieurs
    // jours (un PC dedie a l'overlay, par exemple).
    setTimeout(verifier, DELAI_AVANT_PREMIERE_VERIFICATION_MS);
    setInterval(verifier, INTERVALLE_VERIFICATION_MS).unref();
  }
}

/** Verification demandee a la main depuis le menu : celle-la donne toujours une reponse visible. */
export function verifierMajMaintenant({ surChangement }) {
  if (!app.isPackaged) return;
  verificationManuelleEnCours = true;
  console.log('[maj] Verification manuelle...');
  surChangement();
  autoUpdater.checkForUpdates().catch((erreur) => {
    verificationManuelleEnCours = false;
    surChangement();
    console.warn('[maj] Verification impossible :', erreur.message);
  });
}

export function verificationEnCours() {
  return verificationManuelleEnCours;
}
