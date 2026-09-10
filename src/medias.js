// --------------------------------------------------------------------------
// Reconnaissance des medias : de quoi decider si une URL vaut la peine d'etre
// affichee, et combien de temps la laisser a l'ecran.
// --------------------------------------------------------------------------

import path from 'node:path';

export const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

export function extensionOf(url) {
  try {
    // Les CDN Discord collent des query params signes : on ne garde que le chemin.
    return path.extname(new URL(url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

export function mediaTypeOf(url, contentType) {
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('image/')) return 'image';

  const ext = extensionOf(url);
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return null;
}

export function urlsDe(texte) {
  return texte?.match(/https?:\/\/\S+/gi) ?? [];
}

/** Premiere URL du texte qui pointe directement sur une image ou une video. */
export function findMediaUrl(text) {
  return urlsDe(text).find((url) => mediaTypeOf(url) !== null) ?? null;
}

/**
 * Cherche un media dans les embeds resolus par Discord. C'est par la qu'arrivent
 * les GIF des selecteurs integres (Klipy, Tenor, Giphy...) : leur lien n'a pas
 * d'extension, seul Discord sait a quel fichier il correspond. On ne code donc
 * aucune liste d'hebergeurs, on lit ce que Discord a trouve.
 */
export function mediaDesEmbeds(embeds) {
  for (const embed of embeds ?? []) {
    for (const url of [embed.video?.url, embed.image?.url, embed.thumbnail?.url]) {
      const mediaType = url ? mediaTypeOf(url) : null;
      if (mediaType) return { mediaUrl: url, mediaType };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Duree reelle d'une video : lue dans son conteneur MP4, sans FFmpeg. La boite
// 'mvhd' contient l'echelle de temps et la duree ; on la cherche d'abord dans
// les premiers octets du fichier (encodage "streaming"), sinon dans les
// derniers (encodage classique, ou la table des index arrive a la fin).
// --------------------------------------------------------------------------

const TAILLE_SONDE_OCTETS = 262144; // 256 Ko : large marge, petite requete.

async function plageOctets(url, range) {
  const reponse = await fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(4000) });
  if (!reponse.ok && reponse.status !== 206) throw new Error(`HTTP ${reponse.status}`);
  return Buffer.from(await reponse.arrayBuffer());
}

/** Cherche la boite 'mvhd' dans un extrait de fichier et en tire la duree en secondes. */
export function dureeDepuisMvhd(buf) {
  const idx = buf.indexOf('mvhd');
  if (idx === -1) return null;
  try {
    const version = buf[idx + 4];
    if (version === 1) {
      const timescale = buf.readUInt32BE(idx + 24);
      const duration = Number(buf.readBigUInt64BE(idx + 28));
      return timescale > 0 ? duration / timescale : null;
    }
    const timescale = buf.readUInt32BE(idx + 16);
    const duration = buf.readUInt32BE(idx + 20);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

/**
 * Duree d'une video en millisecondes, ou null si elle n'a pas pu etre lue
 * (webm, erreur reseau, format inattendu).
 */
export async function dureeVideoMs(url, plafondMs) {
  try {
    const debut = await plageOctets(url, `bytes=0-${TAILLE_SONDE_OCTETS - 1}`);
    let secondes = dureeDepuisMvhd(debut);

    if (secondes == null) {
      const fin = await plageOctets(url, `bytes=-${TAILLE_SONDE_OCTETS}`);
      secondes = dureeDepuisMvhd(fin);
    }

    if (secondes == null || !Number.isFinite(secondes) || secondes <= 0) return null;
    return Math.min(Math.round(secondes * 1000), plafondMs);
  } catch (erreur) {
    console.warn(`[livechat] Duree de la video illisible (${erreur.message}), duree par defaut utilisee.`);
    return null;
  }
}
