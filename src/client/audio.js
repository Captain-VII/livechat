// --------------------------------------------------------------------------
// Le choix de la sortie audio : envoyer les memes sur un canal a part, pour les
// piloter separement du jeu ou du micro.
//
// Seul un renderer sait enumerer les peripheriques : la fenetre overlay nous
// annonce la liste, on en fait un menu, et on lui renvoie le choix.
// --------------------------------------------------------------------------

import { ecrireConfig, lireConfig } from './reglages.js';

/**
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getFenetre
 * @param {() => void} options.surChangement Rafraichit le menu de la barre des taches.
 * @param {string} options.sortieVoulueEnv Contenu de OVERLAY_AUDIO_DEVICE.
 */
export function creerAudio({ getFenetre, surChangement, sortieVoulueEnv }) {
  /** @type {Array<{ deviceId: string, label: string }>} Annoncees par la fenetre. */
  let sorties = [];
  let sortieChoisieId = null;

  /** Les sorties presentables : Chromium ajoute un alias "communications" inutile ici. */
  function sortiesUtiles() {
    return sorties.filter((s) => s.deviceId !== 'communications');
  }

  /** Resout OVERLAY_AUDIO_DEVICE dans la liste annoncee par la fenetre. */
  function sortieVoulue() {
    // OVERLAY_AUDIO_DEVICE prime ; sinon, la derniere sortie choisie a la main.
    const voulue = sortieVoulueEnv || lireConfig().sortieAudioLabel || '';
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

    const fenetre = getFenetre();
    if (fenetre && !fenetre.isDestroyed()) {
      fenetre.webContents.send('sortie-audio', deviceId ?? 'default');
    }

    const nom = sortiesUtiles().find((s) => s.deviceId === deviceId)?.label;
    console.log(`[livechat] Son envoye sur : ${nom ?? 'la sortie par defaut de Windows'}.`);
    surChangement();
  }

  return {
    sortiesUtiles,
    routerVers,
    sortieChoisieId: () => sortieChoisieId,

    /** La fenetre vient d'enumerer les peripheriques (au demarrage, ou apres un branchement). */
    surSortiesAnnoncees(liste) {
      const premiereFois = sorties.length === 0;
      sorties = liste;

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
      else surChangement();
    },
  };
}
