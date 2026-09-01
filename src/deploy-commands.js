import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis (voir .env.example).');
  process.exit(1);
}

const meme = new SlashCommandBuilder()
  .setName('meme')
  .setDescription('Envoie un meme sur le mur')
  .addAttachmentOption((option) =>
    option.setName('fichier').setDescription('Une image ou une video a coller au mur'),
  )
  .addStringOption((option) =>
    option.setName('texte').setDescription('Une legende, ou juste du texte'),
  )
  .addStringOption((option) =>
    option.setName('lien').setDescription('URL directe vers une image ou une video'),
  );

const rest = new REST().setToken(DISCORD_TOKEN);

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

try {
  await rest.put(route, { body: [meme.toJSON()] });
  console.log(
    DISCORD_GUILD_ID
      ? `/meme enregistree sur le serveur ${DISCORD_GUILD_ID} : disponible tout de suite.`
      : '/meme enregistree globalement : compte jusqu\'a une heure de propagation.',
  );
} catch (error) {
  console.error('Enregistrement impossible :', error);
  process.exit(1);
}
