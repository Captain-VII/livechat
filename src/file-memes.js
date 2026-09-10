// --------------------------------------------------------------------------
// La file : les memes passent un par un, chacun son moment a l'ecran.
//
// Isolee du bot Discord et du websocket : elle ne connait que trois choses
// qu'on lui fournit (comment diffuser, comment mesurer une video, et qui
// prevenir quand l'ecran change). C'est ce qui la rend testable sans reseau.
// --------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {number} options.dureeMs Temps d'affichage d'un meme (hors video).
 * @param {number} options.gapMs Respiration entre deux memes.
 * @param {number} options.max Taille maximale de la file d'attente.
 * @param {(url: string) => Promise<number|null>} options.dureeVideoMs Duree reelle d'une video.
 * @param {(message: object) => void} options.diffuser Envoi vers les overlays.
 * @param {() => void} [options.surChangement] Appele quand le meme a l'ecran change.
 */
export function creerFile({ dureeMs, gapMs, max, dureeVideoMs, diffuser, surChangement = () => {} }) {
  /** @type {Array<object>} Memes acceptes, pas encore diffuses. */
  const attente = [];

  let nextId = 1;
  let minuteur = null;
  let enPause = false;

  // Vrai pendant qu'on attend la duree reelle d'une video : relancer() ne doit
  // pas programmer un second defiler() en parallele pendant ce temps-la.
  let sondageEnCours = false;

  /**
   * Le meme actuellement a l'ecran, pour rattraper qui se (re)connecte pendant
   * qu'il tourne encore. Sans ca, un accroc reseau d'une seconde suffit a rater
   * un meme pour de bon : rien ne le rejoue jamais.
   * @type {{ meme: object, finPrevue: number } | null}
   */
  let enCours = null;

  // Horodatage du debut de la pause en cours, pour figer le temps restant du
  // meme a l'ecran pendant qu'elle dure (sinon finPrevue - Date.now() continue
  // de s'ecouler alors que rien ne joue).
  let pauseDebut = 0;

  /** Reveille la file si elle dort. */
  function relancer() {
    if (minuteur || sondageEnCours || enPause || attente.length === 0) return;
    minuteur = setTimeout(defiler, 0);
  }

  async function defiler() {
    minuteur = null;
    if (enPause) return;

    const meme = attente.shift();
    if (!meme) {
      enCours = null;
      diffuser({ type: 'retrait' });
      surChangement();
      return;
    }

    sondageEnCours = true;
    const duree = meme.mediaType === 'video' ? ((await dureeVideoMs(meme.mediaUrl)) ?? dureeMs) : dureeMs;
    sondageEnCours = false;

    const feuille = {
      id: nextId++,
      // Une legere rotation, decidee ici pour que tous les overlays soient d'accord.
      rotation: Math.round((Math.random() * 4 - 2) * 100) / 100,
      duree,
      ...meme,
    };

    enCours = { meme: feuille, finPrevue: Date.now() + duree };
    diffuser({ type: 'meme', meme: feuille });
    surChangement();
    console.log(
      `[livechat] ${feuille.author.name} -> ${feuille.mediaUrl ?? feuille.text ?? ''} (${duree}ms)`,
    );
    minuteur = setTimeout(defiler, duree + gapMs);
  }

  return {
    /**
     * Met un meme dans la file. Renvoie le nombre de memes devant lui.
     * Rien n'est fige ici : id et rotation sont decides au moment ou le meme
     * est vraiment diffuse.
     */
    enfiler(meme) {
      const devant = attente.length;
      attente.push(meme);

      if (attente.length > max) {
        attente.shift();
        console.warn('[livechat] File pleine : le plus vieux meme en attente est passe a la trappe.');
      }

      relancer();
      return devant;
    },

    /** Coupe le meme a l'ecran et enchaine sur le suivant. */
    passer() {
      const yAvaitQuelqueChose = enCours !== null;
      if (minuteur) clearTimeout(minuteur);
      minuteur = null;
      enCours = null;
      diffuser({ type: 'retrait' });
      surChangement();
      relancer();
      return yAvaitQuelqueChose;
    },

    basculerPause() {
      enPause = !enPause;
      if (enPause) {
        if (minuteur) clearTimeout(minuteur);
        minuteur = null;
        pauseDebut = Date.now();
      } else if (enCours) {
        // Decale finPrevue du temps passe en pause, pour que le meme reprenne
        // avec le temps qu'il lui restait plutot que de reboucler a zero.
        enCours.finPrevue += Date.now() - pauseDebut;
        minuteur = setTimeout(defiler, Math.max(0, enCours.finPrevue - Date.now()) + gapMs);
      } else {
        relancer();
      }
      console.log(`[livechat] ${enPause ? 'En pause.' : 'Reprise.'} ${attente.length} en attente.`);
      return enPause;
    },

    /** Vide la file d'attente sans toucher au meme deja a l'ecran. */
    vider() {
      const combien = attente.length;
      attente.length = 0;
      return combien;
    },

    /** Le meme a l'ecran et le temps qu'il lui reste, pour le rattrapage. */
    memeEnCours() {
      if (!enCours) return null;
      // En pause, le decompte est fige au moment ou elle a commence.
      const restant = enPause ? enCours.finPrevue - pauseDebut : enCours.finPrevue - Date.now();
      return { meme: enCours.meme, restant };
    },

    /** Un apercu de la file d'attente, pour l'afficher dans Discord. */
    apercu() {
      return {
        enPause,
        aLEcran: enCours?.meme ?? null,
        attente: attente.map((meme) => ({
          auteur: meme.author?.name ?? 'anonyme',
          apercu: meme.mediaUrl ?? meme.text ?? '',
          type: meme.mediaType ?? 'texte',
        })),
      };
    },
  };
}
