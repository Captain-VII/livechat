// --------------------------------------------------------------------------
// D'un message Discord a des memes : piece jointe, lien direct, ou GIF dont
// Discord ne donne le fichier qu'une fraction de seconde plus tard (embed).
//
// Ne connait ni le bot ni la file : on lui passe de quoi enfiler un meme.
// C'est ce qui la rend testable avec de faux messages.
// --------------------------------------------------------------------------

import { findMediaUrl, mediaDesEmbeds, mediaTypeOf, urlsDe } from './medias.js';

export function authorOf(user, member) {
  // member peut arriver brut de l'API (pas un GuildMember) : on retombe sur user.
  const isGuildMember = typeof member?.displayAvatarURL === 'function';
  return {
    name: (isGuildMember ? member.displayName : null) ?? user.globalName ?? user.username,
    avatar: (isGuildMember ? member : user).displayAvatarURL({ extension: 'png', size: 128 }),
  };
}

/**
 * @param {object} options
 * @param {(meme: object) => void} options.enfiler
 * @param {number} options.attenteEmbedMs Temps laisse a Discord pour resoudre l'embed d'un lien.
 */
export function creerLecteurMessages({ enfiler, attenteEmbedMs }) {
  /**
   * Messages dont on attend encore l'embed de Discord.
   * @type {Map<string, { author: object, text: string|null, minuteur: NodeJS.Timeout }>}
   */
  const attenteEmbed = new Map();

  /** Met un message de cote le temps que Discord lui attache son embed. */
  function patienter(message, author, text) {
    if (attenteEmbed.has(message.id)) return;

    const minuteur = setTimeout(() => {
      attenteEmbed.delete(message.id);
      if (text) {
        // Le lien n'a rien donne, mais il y avait autre chose a dire.
        enfiler({ author, text, mediaUrl: null, mediaType: null });
      } else {
        console.warn(`[livechat] Lien sans media utilisable, laisse de cote : ${message.content.trim()}`);
      }
    }, attenteEmbedMs);

    attenteEmbed.set(message.id, { author, text, minuteur });
  }

  return {
    /** Un nouveau message du salon livechat. */
    traiter(message) {
      const author = authorOf(message.author, message.member);
      const attachments = [...message.attachments.values()].filter(
        (a) => mediaTypeOf(a.url, a.contentType) !== null,
      );

      if (attachments.length > 0) {
        // La legende accompagne la premiere piece jointe seulement.
        attachments.forEach((attachment, index) => {
          enfiler({
            author,
            text: index === 0 ? message.content || null : null,
            mediaUrl: attachment.url,
            mediaType: mediaTypeOf(attachment.url, attachment.contentType),
          });
        });
        return;
      }

      const mediaUrl = findMediaUrl(message.content);
      if (mediaUrl) {
        enfiler({
          author,
          text: message.content.replace(mediaUrl, '').trim() || null,
          mediaUrl,
          mediaType: mediaTypeOf(mediaUrl),
        });
        return;
      }

      // Parfois Discord a deja resolu l'embed quand le message nous parvient.
      const media = mediaDesEmbeds(message.embeds);
      const liens = urlsDe(message.content);
      const texteSeul = liens.reduce((t, l) => t.replace(l, ''), message.content).trim() || null;

      if (media) {
        enfiler({ author, text: texteSeul, ...media });
        return;
      }

      if (liens.length > 0) {
        // Un lien de GIF n'a pas d'extension : c'est Discord qui dira a quoi il
        // correspond, une fraction de seconde plus tard. On patiente plutot que
        // d'afficher l'URL en toutes lettres.
        patienter(message, author, texteSeul);
        return;
      }

      if (message.content.trim()) {
        enfiler({ author, text: message.content.trim(), mediaUrl: null, mediaType: null });
      }
    },

    /** Vrai si ce message attend encore son embed. */
    attend: (id) => attenteEmbed.has(id),

    /** L'embed arrive apres coup : c'est ici que les GIF finissent par tomber. */
    resoudreEmbed(message) {
      const attente = attenteEmbed.get(message?.id);
      if (!attente) return;

      const media = mediaDesEmbeds(message.embeds);
      if (!media) return;

      clearTimeout(attente.minuteur);
      attenteEmbed.delete(message.id);
      enfiler({ author: attente.author, text: attente.text, ...media });
    },
  };
}
