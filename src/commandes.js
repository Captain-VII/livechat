// --------------------------------------------------------------------------
// Les commandes slash : leur definition (envoyee a Discord par
// deploy-commands.js) et ce qu'elles font (cote serveur), cote a cote pour
// qu'elles ne puissent pas diverger.
//
// Chaque commande recoit un contexte plutot que d'aller chercher le bot ou le
// websocket elle-meme :
//   file         la file des memes (file-memes.js)
//   overlays()   les sockets ouvertes : { pseudo, connecteDepuis }
//   bannis       Set des identifiants Discord prives de LiveChat
//   sauverBannis()
//   nomSalon     le salon qui recoit les memes
// --------------------------------------------------------------------------

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { mediaTypeOf } from './medias.js';
import { authorOf } from './messages.js';

/** Toutes les reponses du bot ne sont visibles que de qui a lance la commande. */
function repondre(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Moderer LiveChat suit le droit de gerer les messages du salon. */
function peutModerer(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
}

/** Raccourcit un lien ou un texte pour tenir dans une ligne de la file. */
function apercuCourt(texte) {
  const propre = (texte ?? '').replace(/\s+/g, ' ').trim();
  return propre.length > 60 ? `${propre.slice(0, 57)}…` : propre;
}

/** "3 min", "1 h 12 min"... a partir d'une duree en ms. */
function dureeLisible(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function meme(interaction, { file, bannis, nomSalon }) {
  if (bannis.has(interaction.user.id)) {
    await repondre(interaction, "Tu n'as plus accès à LiveChat.");
    return;
  }

  const fichier = interaction.options.getAttachment('fichier');
  const texte = interaction.options.getString('texte');
  const lien = interaction.options.getString('lien');

  if (!fichier && !texte && !lien) {
    await repondre(interaction, 'Il me faut au moins un `fichier`, un `texte` ou un `lien`.');
    return;
  }

  const mediaUrl = fichier?.url ?? lien ?? null;
  const mediaType = mediaUrl ? mediaTypeOf(mediaUrl, fichier?.contentType) : null;

  if (mediaUrl && !mediaType) {
    await repondre(
      interaction,
      'Ce lien ne pointe pas directement sur un fichier (jpg, png, gif, webp, mp4, webm).\n' +
        `Pour un GIF du sélecteur Discord, poste-le directement dans #${nomSalon} : ` +
        'là, Discord résout le lien tout seul.',
    );
    return;
  }

  const devant = file.enfiler({
    author: authorOf(interaction.user, interaction.member),
    text: texte ?? null,
    mediaUrl,
    mediaType,
  });

  await repondre(interaction, devant === 0 ? "À l'écran." : `Dans la file, ${devant} devant toi.`);
}

async function passer(interaction, { file }) {
  const yAvaitQuelqueChose = file.passer();
  await repondre(interaction, yAvaitQuelqueChose ? 'Meme passé.' : "Rien n'était à l'écran.");
}

async function connectes(interaction, { overlays }) {
  const maintenant = Date.now();
  const liste = overlays()
    .sort((a, b) => a.connecteDepuis - b.connecteDepuis)
    .map((s) => `• **${s.pseudo}** — connecté depuis ${dureeLisible(maintenant - s.connecteDepuis)}`);

  await repondre(
    interaction,
    liste.length === 0
      ? "Personne n'a l'overlay ouvert en ce moment."
      : `**${liste.length} overlay(s) connecté(s) :**\n${liste.join('\n')}`,
  );
}

async function fileAttente(interaction, { file }) {
  const { enPause, aLEcran, attente } = file.apercu();

  const lignes = [];
  if (enPause) lignes.push('_(diffusion en pause)_');
  lignes.push(aLEcran ? `**À l'écran :** ${aLEcran.author.name}` : "**À l'écran :** rien pour le moment.");

  if (attente.length === 0) {
    lignes.push('**En attente :** rien.');
  } else {
    lignes.push(`**En attente (${attente.length}) :**`);
    // Discord coupe a 2000 caracteres : on montre le debut de la file, qui
    // est de toute facon la seule partie sur laquelle on peut encore agir.
    for (const [index, item] of attente.slice(0, 15).entries()) {
      lignes.push(`${index + 1}. **${item.auteur}** — ${item.type} ${apercuCourt(item.apercu)}`);
    }
    if (attente.length > 15) lignes.push(`… et ${attente.length - 15} de plus.`);
  }

  await repondre(interaction, lignes.join('\n'));
}

async function vider(interaction, { file }) {
  if (!peutModerer(interaction)) {
    await repondre(interaction, 'Il faut le droit de gérer les messages pour vider la file.');
    return;
  }
  const combien = file.vider();
  console.log(`[livechat] File videe (${combien} meme(s)) par ${interaction.user.tag}.`);
  await repondre(
    interaction,
    combien === 0
      ? "La file était déjà vide (le meme à l'écran, lui, va au bout : /passer pour le couper)."
      : `${combien} meme(s) en attente supprimé(s).`,
  );
}

// --------------------------------------------------------------------------
// Moderation : de quoi couper le robinet a quelqu'un sans l'exclure du serveur
// Discord. Volontairement limite a LiveChat — bannir pour de vrai reste le
// travail des moderateurs du serveur.
// --------------------------------------------------------------------------

function moderer(bannir) {
  return async (interaction, { bannis, sauverBannis }) => {
    if (!peutModerer(interaction)) {
      await repondre(interaction, 'Il faut le droit de gérer les messages pour ça.');
      return;
    }

    const cible = interaction.options.getUser('membre');

    if (bannir && cible.id === interaction.user.id) {
      await repondre(interaction, 'Te bannir toi-même, vraiment ?');
      return;
    }

    if (bannir) bannis.add(cible.id);
    else bannis.delete(cible.id);
    sauverBannis();

    console.log(
      `[livechat] ${cible.tag} ${bannir ? 'banni de' : 'reautorise sur'} LiveChat par ${interaction.user.tag}.`,
    );
    await repondre(
      interaction,
      bannir
        ? `**${cible.username}** ne peut plus envoyer de memes sur LiveChat.`
        : `**${cible.username}** peut de nouveau envoyer des memes.`,
    );
  };
}

// Les commandes de moderation sont masquees par defaut pour qui n'a pas le
// droit de gerer les messages ; le serveur revalide de son cote.
export const COMMANDES = [
  {
    definition: new SlashCommandBuilder()
      .setName('meme')
      .setDescription('Envoie un meme sur LiveChat')
      .addAttachmentOption((option) =>
        option.setName('fichier').setDescription('Une image ou une vidéo à envoyer sur LiveChat'),
      )
      .addStringOption((option) => option.setName('texte').setDescription('Une légende, ou juste du texte'))
      .addStringOption((option) =>
        option.setName('lien').setDescription('URL directe vers une image ou une vidéo'),
      ),
    executer: meme,
  },
  {
    definition: new SlashCommandBuilder()
      .setName('passer')
      .setDescription('Passe le meme actuellement affiché sur LiveChat'),
    executer: passer,
  },
  {
    definition: new SlashCommandBuilder()
      .setName('connectes')
      .setDescription('Liste qui a son overlay LiveChat ouvert en ce moment'),
    executer: connectes,
  },
  {
    definition: new SlashCommandBuilder()
      .setName('file')
      .setDescription('Montre le meme à l\'écran et ceux qui attendent leur tour'),
    executer: fileAttente,
  },
  {
    definition: new SlashCommandBuilder()
      .setName('vider')
      .setDescription('Vide la file d\'attente (le meme à l\'écran va au bout)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    executer: vider,
  },
  {
    definition: new SlashCommandBuilder()
      .setName('bannir')
      .setDescription('Empêche quelqu\'un d\'envoyer des memes sur LiveChat')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((option) =>
        option.setName('membre').setDescription('La personne à priver de LiveChat').setRequired(true),
      ),
    executer: moderer(true),
  },
  {
    definition: new SlashCommandBuilder()
      .setName('debannir')
      .setDescription('Redonne accès à LiveChat')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((option) =>
        option.setName('membre').setDescription('La personne à réautoriser').setRequired(true),
      ),
    executer: moderer(false),
  },
];

/** Le gestionnaire de Events.InteractionCreate : bouton "Passer" et commandes slash. */
export function creerGestionnaireInteractions(contexte) {
  const parNom = new Map(COMMANDES.map((c) => [c.definition.name, c.executer]));

  return async (interaction) => {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('passer:')) return;
      const idCible = Number(interaction.customId.slice('passer:'.length));
      if (contexte.file.memeEnCours()?.meme.id !== idCible) {
        await repondre(interaction, 'Déjà passé.');
        return;
      }
      await interaction.deferUpdate(); // le message du bouton sera edite par le serveur
      contexte.file.passer();
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    await parNom.get(interaction.commandName)?.(interaction, contexte);
  };
}
