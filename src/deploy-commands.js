import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import { COMMANDES } from './commandes.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis (voir .env.example).');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

const commandes = COMMANDES.map((c) => c.definition);

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
