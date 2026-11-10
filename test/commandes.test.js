import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import { COMMANDES, creerGestionnaireInteractions } from '../src/commandes.js';

/** Une fausse interaction de commande slash, qui garde ce qu'on lui repond. */
function commande(nom, { options = {}, moderateur = false, userId = 'moi' } = {}) {
  const reponses = [];
  return {
    reponses,
    commandName: nom,
    isButton: () => false,
    isChatInputCommand: () => true,
    user: { id: userId, tag: 'moi#0', username: 'moi', displayAvatarURL: () => '' },
    member: null,
    memberPermissions: { has: () => moderateur },
    options: {
      getAttachment: () => options.fichier ?? null,
      getString: (cle) => options[cle] ?? null,
      getUser: () => options.membre,
    },
    reply: async (r) => reponses.push(r.content),
  };
}

function contexte() {
  const enfiles = [];
  return {
    enfiles,
    file: {
      enfiler: (m) => enfiles.push(m) - 1, // nombre de memes devant
      passer: () => true,
      vider: () => 3,
      memeEnCours: () => null,
      apercu: () => ({ enPause: false, aLEcran: null, attente: [] }),
    },
    overlays: () => [],
    bannis: new Set(),
    sauverBannis: () => {},
    nomSalon: 'livechat',
  };
}

describe('les commandes slash', () => {
  beforeEach(() => mock.method(console, 'log', () => {}));

  it('chaque definition a son executant', () => {
    assert.deepEqual(
      COMMANDES.map((c) => c.definition.name),
      ['meme', 'passer', 'connectes', 'file', 'vider', 'bannir', 'debannir'],
    );
    for (const c of COMMANDES) assert.equal(typeof c.executer, 'function');
  });

  it('/vider et /bannir sont refusees sans le droit de gerer les messages', async () => {
    const ctx = contexte();
    const gerer = creerGestionnaireInteractions(ctx);
    const vider = commande('vider');
    const bannir = commande('bannir', { options: { membre: { id: 'lui' } } });
    await gerer(vider);
    await gerer(bannir);
    assert.match(vider.reponses[0], /droit de gérer les messages/);
    assert.match(bannir.reponses[0], /droit de gérer les messages/);
    assert.equal(ctx.bannis.size, 0);
  });

  it('/bannir puis /debannir', async () => {
    const ctx = contexte();
    const gerer = creerGestionnaireInteractions(ctx);
    const membre = { id: 'lui', tag: 'lui#0', username: 'lui' };
    await gerer(commande('bannir', { moderateur: true, options: { membre } }));
    assert.equal(ctx.bannis.has('lui'), true);
    await gerer(commande('debannir', { moderateur: true, options: { membre } }));
    assert.equal(ctx.bannis.has('lui'), false);
  });

  it('/meme enfile, refuse un lien qui n est pas un fichier, et un banni', async () => {
    const ctx = contexte();
    const gerer = creerGestionnaireInteractions(ctx);

    const ok = commande('meme', { options: { lien: 'https://x.fr/a.gif', texte: 'mdr' } });
    await gerer(ok);
    assert.equal(ok.reponses[0], "À l'écran.");
    assert.equal(ctx.enfiles[0].mediaType, 'image');

    const pasUnFichier = commande('meme', { options: { lien: 'https://tenor.com/view/x' } });
    await gerer(pasUnFichier);
    assert.match(pasUnFichier.reponses[0], /#livechat/);

    ctx.bannis.add('moi');
    const banni = commande('meme', { options: { texte: 'coucou' } });
    await gerer(banni);
    assert.equal(banni.reponses[0], "Tu n'as plus accès à LiveChat.");
    assert.equal(ctx.enfiles.length, 1);
  });

  it('le bouton Passer d un meme deja fini repond "Deja passe"', async () => {
    const ctx = contexte();
    const reponses = [];
    await creerGestionnaireInteractions(ctx)({
      isButton: () => true,
      customId: 'passer:7',
      reply: async (r) => reponses.push(r.content),
    });
    assert.deepEqual(reponses, ['Déjà passé.']);
  });
});
