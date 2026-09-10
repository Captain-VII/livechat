import 'dotenv/config';
import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis (voir .env.example).');
  process.exit(1);
}

const meme = new SlashCommandBuilder()
  .setName('meme')
  .setDescription('Envoie un meme sur LiveChat')
  .addAttachmentOption((option) =>
    option.setName('fichier').setDescription('Une image ou une video a envoyer sur LiveChat'),
  )
  .addStringOption((option) =>
    option.setName('texte').setDescription('Une legende, ou juste du texte'),
  )
  .addStringOption((option) =>
    option.setName('lien').setDescription('URL directe vers une image ou une video'),
  );

const passer = new SlashCommandBuilder()
  .setName('passer')
  .setDescription('Passe le meme actuellement affiche sur LiveChat');

const connectes = new SlashCommandBuilder()
  .setName('connectes')
  .setDescription('Liste qui a son overlay LiveChat ouvert en ce moment');

const fileAttente = new SlashCommandBuilder()
  .setName('file')
  .setDescription('Montre le meme a l\'ecran et ceux qui attendent leur tour');

// Les commandes de moderation sont masquees par defaut pour qui n'a pas le
// droit de gerer les messages ; le serveur revalide de son cote.
const vider = new SlashCommandBuilder()
  .setName('vider')
  .setDescription('Vide la file d\'attente (le meme a l\'ecran va au bout)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

const bannir = new SlashCommandBuilder()
  .setName('bannir')
  .setDescription('Empeche quelqu\'un d\'envoyer des memes sur LiveChat')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption((option) =>
    option.setName('membre').setDescription('La personne a priver de LiveChat').setRequired(true),
  );

const debannir = new SlashCommandBuilder()
  .setName('debannir')
  .setDescription('Redonne acces a LiveChat')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption((option) =>
    option.setName('membre').setDescription('La personne a reautoriser').setRequired(true),
  );

const rest = new REST().setToken(DISCORD_TOKEN);

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

const commandes = [meme, passer, connectes, fileAttente, vider, bannir, debannir];

try {
  await rest.put(route, { body: commandes.map((c) => c.toJSON()) });
  const noms = commandes.map((c) => `/${c.name}`).join(', ');
  console.log(
    DISCORD_GUILD_ID
      ? `${noms} enregistrees sur le serveur ${DISCORD_GUILD_ID} : disponibles tout de suite.`
      : `${noms} enregistrees globalement : comptez jusqu'a une heure de propagation.`,
  );
} catch (error) {
  console.error('Enregistrement impossible :', error);
  process.exit(1);
}
