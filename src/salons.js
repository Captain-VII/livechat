// --------------------------------------------------------------------------
// Reconnaitre un salon a son nom, decoration comprise.
//
// Beaucoup de serveurs prefixent leurs salons d'un emoji et d'un separateur :
// "📡┃livechat", "💬-livechat", "| livechat". Comparer le nom exact ratait
// tous ces salons : rien de ce qui y etait poste ne partait a l'ecran.
// --------------------------------------------------------------------------

/** "📡┃LiveChat" -> "livechat" : sans ce qui precede la premiere lettre ou le premier chiffre. */
export function nomSansDecor(nom) {
  return (nom ?? '').toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
}

/** Le salon porte-t-il ce nom, a la decoration pres ? */
export function estSalon(salon, nom) {
  return nomSansDecor(salon?.name) === nomSansDecor(nom);
}
