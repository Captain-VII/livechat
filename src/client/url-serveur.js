// --------------------------------------------------------------------------
// L'adresse du serveur, telle qu'un ami la colle vraiment.
//
// Elle est annoncee dans Discord au milieu d'un bloc de code : selon comment
// on la copie, elle arrive avec des accents graves, des guillemets, un espace
// insecable, ou en https:// (ce que Discord affiche comme lien cliquable).
// Refuser tout ca au motif que "l'adresse doit commencer par ws://" n'aide
// personne — on repare ce qui est reparable, on refuse le reste clairement.
// --------------------------------------------------------------------------

/** Un hote local ou une IP brute : pas de certificat, donc pas de TLS. */
function hoteSansTls(hote) {
  return (
    hote === 'localhost' ||
    hote === '::1' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hote) ||
    hote.endsWith('.local')
  );
}

/**
 * @param {string} brut Ce que l'utilisateur a colle.
 * @returns {{ ok: true, url: string } | { ok: false, erreur: string }}
 */
export function normaliserUrlServeur(brut) {
  let texte = (brut ?? '')
    // Espaces insecables et espaces fines, invisibles mais bien presents.
    .replace(/[  ​]/g, ' ')
    .trim()
    // Les accents graves du bloc de code Discord, et les guillemets.
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();

  if (!texte) return { ok: false, erreur: 'Adresse vide.' };

  // Une adresse collee depuis un navigateur ou un lien Discord arrive en
  // http(s) : c'est la meme machine, seul le protocole change.
  texte = texte.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');

  // Sans protocole du tout, on choisit selon l'hote : une IP ou un localhost
  // n'a pas de certificat, tout le reste en a un.
  if (!/^wss?:\/\//i.test(texte)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(texte)) {
      return { ok: false, erreur: "L'adresse doit commencer par ws:// ou wss://." };
    }
    const hote = texte.split(/[:/]/)[0].toLowerCase();
    texte = `${hoteSansTls(hote) ? 'ws' : 'wss'}://${texte}`;
  }

  let url;
  try {
    url = new URL(texte);
  } catch {
    return { ok: false, erreur: "Cette adresse n'est pas valide." };
  }

  if (!url.hostname) return { ok: false, erreur: "Cette adresse n'a pas de serveur." };

  // Une barre finale seule n'apporte rien et fait deux adresses la ou il n'y
  // en a qu'une dans les logs.
  return { ok: true, url: url.toString().replace(/\/$/, '') };
}
