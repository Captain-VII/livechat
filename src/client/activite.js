// --------------------------------------------------------------------------
// Est-ce qu'on joue ou qu'on regarde un film sur l'ecran principal ?
//
// Logique pure, sans Electron ni PowerShell : elle recoit un sondage (les
// fenetres visibles, les lectures en cours, les jeux connus de Windows) et
// decide s'il faut partir sur l'autre ecran ou revenir. D'ou les tests.
//
// Le plein ecran seul ratait trop de choses : un jeu en fenetre, un film sur
// YouTube dans un coin de l'ecran. On reconnait donc l'activite elle-meme :
//   - un jeu, a son executable (liste de la Game Bar, dossiers des lanceurs,
//     liste perso), et en repli a son plein ecran ;
//   - un film, a la lecture annoncee a Windows (les controles multimedia du
//     clavier), par le navigateur ou le lecteur dont la fenetre est la.
// --------------------------------------------------------------------------

// A 2s par sondage, 2 confirmations = ~4s d'activite continue avant de bouger :
// assez court pour reagir vite, assez long pour ignorer un etat qui vacille.
export const SEUIL_CONFIRMATION_POLLS = 2;

// Delai minimum entre deux bascules : sans lui, un jeu dont l'etat vacille
// (overlay Steam, ecran de chargement) faisait l'aller-retour entre les ecrans.
export const COOLDOWN_BASCULE_AUTO_MS = 10000;

// Un film mis en pause, un jeu dont on sort une minute : on ne rentre pas au
// premier temps mort, seulement si ca dure.
export const DELAI_GRACE_MS = 60000;

// Le bureau et la barre des taches couvrent l'ecran en permanence.
const CLASSES_BUREAU = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'];

// La ou les lanceurs installent leurs jeux.
const DOSSIERS_LANCEURS = [
  '\\steamapps\\common\\',
  '\\epic games\\',
  '\\riot games\\',
  '\\xboxgames\\',
  '\\gog galaxy\\games\\',
  '\\gog games\\',
  '\\ubisoft game launcher\\games\\',
  '\\ea games\\',
];

// Jamais des jeux, meme si la Game Bar ou un dossier de lanceur le pretend
// (Wallpaper Engine vit dans steamapps, la Game Bar prend parfois Discord).
// Les lanceurs non plus : le Riot Client dans son dossier "Riot Games" faisait
// basculer avant meme d'avoir lance une partie.
const JAMAIS_JEU = new Set([
  'explorer', 'discord', 'steam', 'steamwebhelper', 'epicgameslauncher',
  'riot client', 'riotclientservices', 'riotclientux', 'riotclientuxrender',
  'leagueclient', 'leagueclientux', 'leagueclientuxrender',
  'upc', 'ubisoftconnect', 'eadesktop', 'galaxyclient', 'battle.net',
  'wallpaper32', 'wallpaper64', 'obs64', 'obs32',
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
]);

// Des sessions multimedia qui ne sont jamais un film.
const APPLIS_MUSIQUE = /spotify|itunes|applemusic|zunemusic|deezer|tidal|amazonmusic|soundcloud/i;

// Dans un navigateur, tout s'annonce en "Music", video comprise : on reconnait
// la musique au site affiche (titre de la fenetre)...
const SITES_MUSIQUE = /youtube music|spotify|deezer|soundcloud|apple music|tidal|qobuz|bandcamp/i;

// ... a la chaine (les chaines "- Topic" generees par YouTube, VEVO)...
const ARTISTES_MUSIQUE = /(\s-\s*topic|vevo)$/i;

// ... ou au titre de la video.
const TITRES_MUSIQUE =
  /official\s+(music\s+)?video|official\s+audio|official\s+lyric|\blyrics?\b|\bparoles\b|clip\s+officiel|audio\s+officiel|visuali[sz]er|\(audio\)|\[audio\]/i;

// Les navigateurs s'annoncent sous un nom qui n'est pas celui de leur exe.
const ALIAS_APPLIS = {
  chrome: 'chrome',
  msedge: 'msedge',
  '308046b0af4a39cb': 'firefox',
  firefox: 'firefox',
  brave: 'brave',
  opera: 'opera',
  vivaldi: 'vivaldi',
};

// Styles Win32, pour reconnaitre le plein ecran fenetre (voir estPleinEcran).
const WS_MAXIMIZE = 0x01000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;

/** 'C:\\Jeux\\Hades.exe' -> 'hades'. */
export function nomExe(chemin) {
  return (chemin ?? '').toLowerCase().split('\\').pop().replace(/\.exe$/, '');
}

/** OVERLAY_GAMES="hades.exe; Celeste" -> Set { 'hades', 'celeste' }. */
export function lireListeJeux(brut) {
  return new Set(
    (brut ?? '')
      .split(/[;,]/)
      .map((nom) => nomExe(nom.trim()))
      .filter(Boolean),
  );
}

/**
 * @param {string} exe Chemin complet de l'executable.
 * @param {{ jeuxConnus?: Set<string>, jeuxPerso?: Set<string> }} options
 *   jeuxConnus : chemins complets en minuscules (Game Bar) ; jeuxPerso : noms d'exe.
 */
export function estJeu(exe, { jeuxConnus = new Set(), jeuxPerso = new Set() } = {}) {
  const chemin = (exe ?? '').toLowerCase();
  if (!chemin) return false;
  const nom = nomExe(chemin);
  if (jeuxPerso.has(nom)) return true;
  if (JAMAIS_JEU.has(nom)) return false;
  if (jeuxConnus.has(chemin)) return true;
  return DOSSIERS_LANCEURS.some((dossier) => chemin.includes(dossier));
}

/** La session multimedia vient-elle de ce processus ? */
export function sessionDe(appId, exe) {
  const app = (appId ?? '').toLowerCase();
  const nom = nomExe(exe);
  if (!app || !nom) return false;
  // Applis du Store (Netflix, Films et TV) : leur fenetre est hebergee par
  // ApplicationFrameHost, et leur identifiant contient un "!".
  if (nom === 'applicationframehost') return app.includes('!');
  if (ALIAS_APPLIS[app.split(/[._!]/)[0]] === nom) return true;
  return nom.length >= 3 && app.includes(nom);
}

/** Minuscules, espaces tasses : pour comparer un titre de media a un titre de fenetre. */
function aplatir(texte) {
  return (texte ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function estNavigateur(appId) {
  return ALIAS_APPLIS[(appId ?? '').toLowerCase().split(/[._!]/)[0]] !== undefined;
}

/** Une lecture de navigateur qui a tout d'une musique. */
export function ressembleMusique(session, titreFenetre) {
  return (
    SITES_MUSIQUE.test(titreFenetre ?? '') ||
    ARTISTES_MUSIQUE.test((session.artiste ?? '').trim()) ||
    TITRES_MUSIQUE.test(session.titre ?? '')
  );
}

/**
 * L'onglet qui joue est-il celui qu'on voit ? Le titre de la fenetre d'un
 * navigateur est celui de l'onglet actif : il contient le titre de la video
 * (YouTube, Netflix) ou le nom de la chaine (Twitch).
 */
export function ongletAffiche(session, titreFenetre) {
  const fenetre = aplatir(titreFenetre);
  const titre = aplatir(session.titre);
  const artiste = aplatir(session.artiste);
  if (!titre && !artiste) return true; // rien d'annonce : on ne peut pas trancher, on fait confiance
  return Boolean((titre && fenetre.includes(titre)) || (artiste.length >= 3 && fenetre.includes(artiste)));
}

/**
 * Un film en lecture dans cette fenetre (la musique ne compte pas).
 *
 * Les navigateurs annoncent TOUT en "Music", video comprise. Pour eux, on
 * exige que l'onglet qui joue soit celui affiche, et que ca ne ressemble pas a
 * de la musique (site, chaine, titre). Une musique YouTube dans un onglet en
 * arriere-plan, ou YouTube Music, ne font donc plus basculer.
 *
 * strict: false sert a garder une bascule deja faite : on a vu le film, on ne
 * le perd pas parce que l'utilisateur change d'onglet pour lire le chat.
 *
 * @param {Array<{ app: string, statut: string, type: string, titre?: string, artiste?: string }>} sessions
 * @param {{ exe: string, titre?: string }} fenetre
 */
export function filmEnLecture(sessions, fenetre, { strict = true } = {}) {
  return (sessions ?? []).some((s) => {
    const app = s.app ?? '';
    if (s.statut !== 'Playing' || APPLIS_MUSIQUE.test(app) || !sessionDe(app, fenetre.exe)) return false;
    if (!estNavigateur(app)) return s.type !== 'Music';
    if (!strict) return true;
    return ongletAffiche(s, fenetre.titre) && !ressembleMusique(s, fenetre.titre);
  });
}

/**
 * Plein ecran exclusif (signale par le shell) ou plein ecran fenetre : une
 * fenetre sans bordure, non maximisee, qui couvre son ecran. Une fenetre
 * simplement maximisee deborde aussi de l'ecran, mais l'overlay se dessine
 * tres bien par-dessus : pas de raison de partir pour elle.
 */
export function estPleinEcran(fenetre, d3d) {
  if (d3d) return true;
  const style = fenetre.style | 0;
  const sansBordure = (style & WS_CAPTION) === 0 && (style & WS_THICKFRAME) === 0;
  const maximisee = (style & WS_MAXIMIZE) !== 0;
  return Boolean(fenetre.couvre) && sansBordure && !maximisee;
}

/**
 * Les activites en cours sur l'ecran principal, celle au premier plan d'abord.
 * @returns {Array<{ hwnd: number, type: 'jeu'|'film'|'plein-ecran', exe: string }>}
 */
export function trouverActivites(sondage, { jeuxConnus, jeuxPerso, pidSoi } = {}) {
  const activites = [];
  for (const f of sondage.fenetres ?? []) {
    if (!f.principal || f.pid === pidSoi || CLASSES_BUREAU.includes(f.classe)) continue;

    let type = null;
    if (estJeu(f.exe, { jeuxConnus, jeuxPerso })) type = 'jeu';
    else if (filmEnLecture(sondage.sessions, f)) type = 'film';
    // Repli pour un jeu inconnu : seulement au premier plan, car des overlays
    // (GeForce, Steam) laissent des fenetres invisibles de la taille de l'ecran.
    else if (f.hwnd === sondage.premier && estPleinEcran(f, sondage.d3d)) type = 'plein-ecran';

    if (type) activites.push({ hwnd: f.hwnd, type, exe: f.exe });
  }
  return activites.sort((a, b) => (b.hwnd === sondage.premier) - (a.hwnd === sondage.premier));
}

export function etatInitial() {
  return { bascule: false, ancre: null, compteDetection: 0, compteFin: 0, dernierBasculeTs: 0 };
}

/**
 * Un tour de la machine a etats.
 *
 * Avant la bascule, il faut une activite vue a chaque sondage, plusieurs fois
 * d'affilee. Apres, on s'ancre a la fenetre qui l'a declenchee : tant qu'elle
 * reste sur le principal et que l'activite reprend dans le delai de grace,
 * l'overlay reste a l'abri, meme si le focus part sur l'autre ecran (Discord
 * pendant un film).
 *
 * @param {ReturnType<typeof etatInitial>} etat
 * @param {object} sondage Voir sonde-activite.js.
 * @param {object} options
 * @param {number} options.maintenant
 * @param {boolean} [options.enPause] Un choix manuel recent : on ne part pas.
 * @returns {{ etat: object, action: 'partir'|'revenir'|null, activite?: object }}
 */
export function evaluer(etat, sondage, { maintenant, enPause = false, ...options }) {
  const activites = trouverActivites(sondage, options);
  const horsCooldown = maintenant - etat.dernierBasculeTs >= COOLDOWN_BASCULE_AUTO_MS;

  if (!etat.bascule) {
    const compteDetection = activites.length ? etat.compteDetection + 1 : 0;
    if (compteDetection >= SEUIL_CONFIRMATION_POLLS && !enPause && horsCooldown) {
      const activite = activites[0];
      return {
        etat: {
          ...etatInitial(),
          bascule: true,
          ancre: { ...activite, vuTs: maintenant },
          dernierBasculeTs: maintenant,
        },
        action: 'partir',
        activite,
      };
    }
    return { etat: { ...etat, compteDetection }, action: null };
  }

  let ancre = etat.ancre;
  if (ancre) {
    const fenetre = (sondage.fenetres ?? []).find((f) => f.hwnd === ancre.hwnd);
    // Un film deja reconnu se garde tant qu'il joue, meme si on change d'onglet.
    const filmContinue =
      ancre.type === 'film' &&
      fenetre?.principal &&
      filmEnLecture(sondage.sessions, fenetre, { strict: false });
    const encore = activites.find((a) => a.hwnd === ancre.hwnd) ?? (filmContinue ? ancre : null);
    if (encore) ancre = { ...encore, vuTs: maintenant };
    else if (!fenetre?.principal || maintenant - ancre.vuTs >= DELAI_GRACE_MS) ancre = null;
    // Sinon : la fenetre est toujours la, l'activite est suspendue, on patiente.
  }
  // Une autre activite a pris le relais (on a lance un film apres le jeu).
  if (!ancre && activites.length) ancre = { ...activites[0], vuTs: maintenant };

  const compteFin = ancre ? 0 : etat.compteFin + 1;
  if (compteFin >= SEUIL_CONFIRMATION_POLLS && horsCooldown) {
    return { etat: { ...etatInitial(), dernierBasculeTs: maintenant }, action: 'revenir' };
  }
  return { etat: { ...etat, ancre, compteFin }, action: null };
}
