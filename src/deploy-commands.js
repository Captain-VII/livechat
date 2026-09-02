import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

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

const rest = new REST().setToken(DISCORD_TOKEN);

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

try {
  await rest.put(route, { body: [meme.toJSON(), passer.toJSON(), connectes.toJSON()] });
  console.log(
    DISCORD_GUILD_ID
      ? `/meme, /passer et /connectes enregistrees sur le serveur ${DISCORD_GUILD_ID} : disponibles tout de suite.`
      : '/meme, /passer et /connectes enregistrees globalement : comptez jusqu\'a une heure de propagation.',
  );
} catch (error) {
  console.error('Enregistrement impossible :', error);
  process.exit(1);
}
