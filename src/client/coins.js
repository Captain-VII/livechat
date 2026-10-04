// --------------------------------------------------------------------------
// Ou poser l'indicateur "livechat en cours" sur l'ecran : logique pure, testee.
// --------------------------------------------------------------------------

export const COINS = {
  'haut-gauche': 'En haut a gauche',
  'haut-droite': 'En haut a droite',
  'bas-gauche': 'En bas a gauche',
  'bas-droite': 'En bas a droite',
};

export const COIN_PAR_DEFAUT = 'haut-gauche';

/** Un coin connu, ou celui par defaut (config abimee, ancienne valeur...). */
export function coinValide(coin) {
  return Object.hasOwn(COINS, coin) ? coin : COIN_PAR_DEFAUT;
}

/**
 * Les bornes de l'indicateur dans la zone de travail d'un ecran (hors barre
 * des taches, pour qu'un coin du bas ne passe pas dessous).
 *
 * @param {{ x: number, y: number, width: number, height: number }} zone
 * @param {string} coin
 * @param {{ largeur: number, hauteur: number, marge: number }} taille
 */
export function boundsIndicateur(zone, coin, { largeur, hauteur, marge }) {
  const [vertical, horizontal] = coinValide(coin).split('-');
  return {
    x: Math.round(horizontal === 'gauche' ? zone.x + marge : zone.x + zone.width - largeur - marge),
    y: Math.round(vertical === 'haut' ? zone.y + marge : zone.y + zone.height - hauteur - marge),
    width: largeur,
    height: hauteur,
  };
}
