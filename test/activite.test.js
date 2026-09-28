import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COOLDOWN_BASCULE_AUTO_MS,
  DELAI_GRACE_MS,
  estJeu,
  etatInitial,
  evaluer,
  filmEnLecture,
  lireListeJeux,
  sessionDe,
  trouverActivites,
} from '../src/client/activite.js';

const SOI = 4242;
const STYLE_FENETRE = 0x00cf0000; // WS_OVERLAPPEDWINDOW : barre de titre + cadre
const STYLE_SANS_BORDURE = 0x14000000 | 0x80000000; // WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS

function fenetre(hwnd, exe, extra = {}) {
  return { hwnd, pid: hwnd, exe, classe: 'Fenetre', style: STYLE_FENETRE, principal: true, couvre: false, ...extra };
}

function sondage({ fenetres = [], sessions = [], premier = 0, d3d = false } = {}) {
  return { fenetres, sessions, premier, d3d, jeux: new Set() };
}

const HADES = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hades\\Hades.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SPOTIFY = 'C:\\Users\\moi\\AppData\\Roaming\\Spotify\\Spotify.exe';
const DISCORD = 'C:\\Users\\moi\\AppData\\Local\\Discord\\app-1.0\\Discord.exe';

/** Enchaine des sondages, un toutes les 2 s, et rend les actions. */
function derouler(sondages, { depart = 1_000_000, etat = etatInitial(), enPause = false } = {}) {
  const actions = [];
  sondages.forEach((s, i) => {
    const r = evaluer(etat, s, { maintenant: depart + i * 2000, enPause, jeuxPerso: new Set(), pidSoi: SOI });
    etat = r.etat;
    actions.push(r.action);
  });
  return { etat, actions };
}

describe('estJeu', () => {
  it('reconnait un jeu Steam a son dossier', () => {
    assert.equal(estJeu(HADES), true);
  });

  it('reconnait un jeu connu de la Game Bar, ou nulle part ailleurs', () => {
    const exe = 'D:\\Jeux\\Tarkov\\EscapeFromTarkov.exe';
    assert.equal(estJeu(exe), false);
    assert.equal(estJeu(exe, { jeuxConnus: new Set([exe.toLowerCase()]) }), true);
  });

  it('prend la liste perso (OVERLAY_GAMES), avec ou sans .exe', () => {
    const jeuxPerso = lireListeJeux('Celeste.exe; minecraft ');
    assert.equal(estJeu('D:\\Celeste\\Celeste.exe', { jeuxPerso }), true);
    assert.equal(estJeu('D:\\MC\\Minecraft.exe', { jeuxPerso }), true);
  });

  it('ne prend pas le lanceur pour le jeu', () => {
    assert.equal(estJeu('C:\\Riot Games\\Riot Client\\Riot Client.exe'), false);
    assert.equal(
      estJeu('C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe'),
      true,
    );
  });

  it('ne prend jamais un navigateur ou Discord pour un jeu', () => {
    assert.equal(estJeu(DISCORD, { jeuxConnus: new Set([DISCORD.toLowerCase()]) }), false);
    assert.equal(estJeu(CHROME), false);
  });
});

describe('films', () => {
  it('relie la session au bon processus', () => {
    assert.equal(sessionDe('Chrome', CHROME), true);
    assert.equal(sessionDe('308046B0AF4A39CB', 'C:\\Mozilla Firefox\\firefox.exe'), true);
    assert.equal(sessionDe('vlc.exe', 'C:\\VideoLAN\\VLC\\vlc.exe'), true);
    assert.equal(sessionDe('Chrome', DISCORD), false);
  });

  it("reconnait une video dans le navigateur, meme annoncee en Music", () => {
    const sessions = [{ app: 'Chrome', statut: 'Playing', type: 'Music' }];
    assert.equal(filmEnLecture(sessions, CHROME), true);
  });

  it('ignore une video en pause', () => {
    assert.equal(filmEnLecture([{ app: 'Chrome', statut: 'Paused', type: '' }], CHROME), false);
  });

  it('ignore Spotify', () => {
    assert.equal(filmEnLecture([{ app: 'Spotify.exe', statut: 'Playing', type: 'Music' }], SPOTIFY), false);
  });
});

describe('trouverActivites', () => {
  it("ne regarde que l'ecran principal", () => {
    const s = sondage({ fenetres: [fenetre(1, HADES, { principal: false })] });
    assert.deepEqual(trouverActivites(s, { pidSoi: SOI }), []);
  });

  it("s'ignore soi-meme et le bureau", () => {
    const s = sondage({
      premier: 2,
      fenetres: [
        fenetre(1, 'C:\\LiveChat\\LiveChat.exe', { pid: SOI, couvre: true, style: STYLE_SANS_BORDURE }),
        fenetre(2, 'C:\\Windows\\explorer.exe', { classe: 'Progman', couvre: true, style: STYLE_SANS_BORDURE }),
      ],
    });
    assert.deepEqual(trouverActivites(s, { pidSoi: SOI }), []);
  });

  it('prend un jeu inconnu en plein ecran fenetre, mais seulement au premier plan', () => {
    const jeu = fenetre(7, 'D:\\Jeu\\Inconnu.exe', { couvre: true, style: STYLE_SANS_BORDURE });
    assert.equal(trouverActivites(sondage({ fenetres: [jeu], premier: 7 }), {})[0]?.type, 'plein-ecran');
    assert.deepEqual(trouverActivites(sondage({ fenetres: [jeu], premier: 99 }), {}), []);
  });

  it("n'entre pas dans une simple fenetre maximisee", () => {
    const maximisee = fenetre(7, 'C:\\Code\\Code.exe', { couvre: true, style: STYLE_FENETRE | 0x01000000 });
    assert.deepEqual(trouverActivites(sondage({ fenetres: [maximisee], premier: 7 }), {}), []);
  });
});

describe('evaluer', () => {
  const jeuEnCours = sondage({ fenetres: [fenetre(1, HADES)], premier: 1 });
  const rien = sondage({ fenetres: [fenetre(2, DISCORD)], premier: 2 });

  it('part apres deux sondages de jeu, meme en fenetre', () => {
    assert.deepEqual(derouler([jeuEnCours, jeuEnCours]).actions, [null, 'partir']);
  });

  it("ne part pas sur un sondage isole", () => {
    assert.deepEqual(derouler([jeuEnCours, rien, jeuEnCours, rien]).actions, [null, null, null, null]);
  });

  it('ne part pas juste apres un choix manuel', () => {
    assert.deepEqual(derouler([jeuEnCours, jeuEnCours], { enPause: true }).actions, [null, null]);
  });

  it("reste a l'abri quand le focus part sur l'autre ecran", () => {
    const discordAuPremierPlan = sondage({
      fenetres: [fenetre(1, HADES), fenetre(2, DISCORD, { principal: false })],
      premier: 2,
    });
    const { actions } = derouler([jeuEnCours, jeuEnCours, ...Array(20).fill(discordAuPremierPlan)]);
    assert.equal(actions.includes('revenir'), false);
  });

  it('revient quand le jeu est ferme (apres le cooldown)', () => {
    const { actions } = derouler([jeuEnCours, jeuEnCours, ...Array(6).fill(rien)]);
    assert.equal(actions[1], 'partir');
    // Jeu ferme au 3e sondage (t+4s) : deux sondages de confirmation, puis on
    // attend la fin des 10 s de cooldown avant de revenir.
    const indexRetour = actions.indexOf('revenir');
    assert.ok(indexRetour > 1);
    assert.ok((indexRetour - 1) * 2000 >= COOLDOWN_BASCULE_AUTO_MS);
  });

  it("garde le film en pause un moment, puis revient", () => {
    const enLecture = sondage({
      fenetres: [fenetre(3, CHROME)],
      sessions: [{ app: 'Chrome', statut: 'Playing', type: 'Music' }],
      premier: 3,
    });
    const enPause = sondage({
      fenetres: [fenetre(3, CHROME)],
      sessions: [{ app: 'Chrome', statut: 'Paused', type: 'Music' }],
      premier: 3,
    });
    const pauseCourte = derouler([enLecture, enLecture, ...Array(10).fill(enPause)]).actions;
    assert.equal(pauseCourte.includes('revenir'), false);

    const toursDeGrace = DELAI_GRACE_MS / 2000;
    const pauseLongue = derouler([enLecture, enLecture, ...Array(toursDeGrace + 3).fill(enPause)]).actions;
    assert.equal(pauseLongue.includes('revenir'), true);
  });

  it("revient tout de suite si la fenetre du film quitte l'ecran principal", () => {
    const enLecture = sondage({
      fenetres: [fenetre(3, CHROME)],
      sessions: [{ app: 'Chrome', statut: 'Playing', type: '' }],
      premier: 3,
    });
    const deplacee = sondage({
      fenetres: [fenetre(3, CHROME, { principal: false })],
      sessions: [{ app: 'Chrome', statut: 'Playing', type: '' }],
      premier: 3,
    });
    const { actions } = derouler([enLecture, enLecture, ...Array(6).fill(deplacee)]);
    assert.equal(actions.includes('revenir'), true);
  });
});
