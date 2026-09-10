import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { creerFile } from '../src/file-memes.js';

const DUREE = 5000;
const GAP = 500;

/** Une file prete a tester, avec la liste de ce qui a ete diffuse. */
function fileDeTest(options = {}) {
  const diffuses = [];
  const file = creerFile({
    dureeMs: DUREE,
    gapMs: GAP,
    max: 40,
    dureeVideoMs: async () => null,
    diffuser: (message) => diffuses.push(message),
    ...options,
  });
  return { file, diffuses };
}

function meme(nom) {
  return { author: { name: nom }, text: nom, mediaUrl: null, mediaType: null };
}

/** Laisse tourner les minuteurs simules ET les promesses en attente. */
async function avancer(ms) {
  mock.timers.tick(ms);
  // defiler() est asynchrone (il peut mesurer une video) : sans ce battement,
  // le meme n'est pas encore diffuse quand on verifie.
  await Promise.resolve();
  await Promise.resolve();
}

describe('la file des memes', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it('affiche le premier meme tout de suite', async () => {
    const { file, diffuses } = fileDeTest();

    const devant = file.enfiler(meme('alice'));
    assert.equal(devant, 0, 'personne devant : il passe tout de suite');

    await avancer(0);
    assert.equal(diffuses.length, 1);
    assert.equal(diffuses[0].type, 'meme');
    assert.equal(diffuses[0].meme.author.name, 'alice');
    assert.equal(diffuses[0].meme.duree, DUREE);
  });

  it('annonce combien de monde attend devant', () => {
    const { file } = fileDeTest();
    assert.equal(file.enfiler(meme('alice')), 0);
    assert.equal(file.enfiler(meme('bob')), 1);
    assert.equal(file.enfiler(meme('carol')), 2);
  });

  it('enchaine les memes un par un, avec la respiration entre deux', async () => {
    const { file, diffuses } = fileDeTest();
    file.enfiler(meme('alice'));
    file.enfiler(meme('bob'));

    await avancer(0);
    assert.equal(diffuses.at(-1).meme.author.name, 'alice');

    // Pendant le temps d'affichage d'alice, bob ne doit pas passer.
    await avancer(DUREE);
    assert.equal(diffuses.at(-1).meme.author.name, 'alice');

    await avancer(GAP);
    assert.equal(diffuses.at(-1).meme.author.name, 'bob');
  });

  it('retire le plus vieux quand la file deborde', () => {
    const { file } = fileDeTest({ max: 2 });
    file.enfiler(meme('alice'));
    file.enfiler(meme('bob'));
    file.enfiler(meme('carol'));

    // alice est deja partie a l'ecran ; il reste bob et carol, pas plus.
    assert.ok(file.apercu().attente.length <= 2);
  });

  it('joue une video sur sa duree reelle plutot que la duree fixe', async () => {
    const { file, diffuses } = fileDeTest({ dureeVideoMs: async () => 12000 });
    file.enfiler({ author: { name: 'alice' }, mediaUrl: 'https://x.test/a.mp4', mediaType: 'video' });

    await avancer(0);
    assert.equal(diffuses.at(-1).meme.duree, 12000);
  });

  it('retombe sur la duree par defaut si la video est illisible', async () => {
    const { file, diffuses } = fileDeTest({ dureeVideoMs: async () => null });
    file.enfiler({ author: { name: 'alice' }, mediaUrl: 'https://x.test/a.webm', mediaType: 'video' });

    await avancer(0);
    assert.equal(diffuses.at(-1).meme.duree, DUREE);
  });

  describe('passer', () => {
    it('coupe le meme a l\'ecran et enchaine sur le suivant', async () => {
      const { file, diffuses } = fileDeTest();
      file.enfiler(meme('alice'));
      file.enfiler(meme('bob'));
      await avancer(0);

      assert.equal(file.passer(), true, 'il y avait bien quelque chose a couper');
      assert.equal(diffuses.at(-1).type, 'retrait');

      await avancer(0);
      assert.equal(diffuses.at(-1).meme.author.name, 'bob');
    });

    it('dit quand il n\'y avait rien a couper', () => {
      const { file } = fileDeTest();
      assert.equal(file.passer(), false);
    });
  });

  describe('le rattrapage de qui se connecte en cours de route', () => {
    it('ne donne que le temps restant, pas la duree complete', async () => {
      const { file } = fileDeTest();
      file.enfiler(meme('alice'));
      await avancer(0);

      await avancer(2000);
      const actuel = file.memeEnCours();
      assert.equal(actuel.meme.author.name, 'alice');
      assert.equal(actuel.restant, DUREE - 2000);
    });

    it("rend null quand l'ecran est vide", () => {
      const { file } = fileDeTest();
      assert.equal(file.memeEnCours(), null);
    });
  });

  describe('la pause', () => {
    it('fige le temps restant au lieu de le laisser filer', async () => {
      const { file } = fileDeTest();
      file.enfiler(meme('alice'));
      await avancer(0);
      await avancer(2000); // il reste 3000

      file.basculerPause();
      assert.equal(file.memeEnCours().restant, 3000);

      // Une minute de pause ne doit rien retirer au temps restant : c'est ce
      // qui partait de travers avant, l'overlay d'un arrivant voyait le
      // decompte continuer (ou repartir de zero) pendant la pause.
      await avancer(60000);
      assert.equal(file.memeEnCours().restant, 3000);
    });

    it('reprend avec le temps qui restait, pas une duree complete', async () => {
      const { file, diffuses } = fileDeTest();
      file.enfiler(meme('alice'));
      file.enfiler(meme('bob'));
      await avancer(0);
      await avancer(2000);

      file.basculerPause();
      await avancer(60000);
      file.basculerPause(); // reprise

      // Il restait 3000 ms a alice : bob ne doit pas passer avant.
      await avancer(2999);
      assert.equal(diffuses.at(-1).meme.author.name, 'alice');

      await avancer(1 + GAP);
      assert.equal(diffuses.at(-1).meme.author.name, 'bob');
    });

    it('ne lance rien tant qu\'elle dure', async () => {
      const { file, diffuses } = fileDeTest();
      file.basculerPause();
      file.enfiler(meme('alice'));

      await avancer(60000);
      assert.equal(diffuses.length, 0, 'rien ne part a l\'ecran en pause');

      file.basculerPause();
      await avancer(0);
      assert.equal(diffuses.at(-1).meme.author.name, 'alice');
    });
  });

  describe('vider', () => {
    it('jette ce qui attend sans toucher a ce qui est a l\'ecran', async () => {
      const { file } = fileDeTest();
      file.enfiler(meme('alice'));
      file.enfiler(meme('bob'));
      file.enfiler(meme('carol'));
      await avancer(0);

      assert.equal(file.vider(), 2);
      assert.equal(file.apercu().attente.length, 0);
      assert.equal(file.memeEnCours().meme.author.name, 'alice', "alice reste a l'ecran");
    });
  });
});
