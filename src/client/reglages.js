// --------------------------------------------------------------------------
// Les reglages, de deux sortes :
//
// - ceux du .env, pour qui lance LiveChat depuis un terminal ;
// - ceux choisis a la main dans le menu, qui doivent survivre a un
//   redemarrage du PC (ecran, sortie audio, son coupe, bascule auto,
//   adresse du serveur).
//
// Les premiers priment toujours sur les seconds : une variable d'environnement
// est un choix explicite de la session en cours.
// --------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

/** Lit un reglage numerique, en gueulant plutot qu'en avalant une valeur bancale. */
export function reglage(nom, defaut, { min = 0, max = Infinity } = {}) {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === '') return defaut;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur < min || valeur > max) {
    console.warn(`[livechat] ${nom} invalide ("${brut}") : on retombe sur ${defaut}.`);
    return defaut;
  }
  return valeur;
}

/** Lit un reglage oui/non : 'off', 'non' et 'false' desactivent. */
export function reglageActif(nom, defaut) {
  const brut = (process.env[nom] ?? '').trim();
  if (!brut) return defaut;
  return !/^(off|non|false)$/i.test(brut);
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

export function lireConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function ecrireConfig(partiel) {
  const config = { ...lireConfig(), ...partiel };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}
