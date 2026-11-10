import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { authorOf, creerLecteurMessages } from '../src/messages.js';

const ATTENTE = 6000;
const AUTEUR = { name: 'Bob', avatar: 'bob.png' };

/** Un faux message Discord : seul ce que le lecteur lit. */
function message({ id = '1', content = '', attachments = [], embeds = [] } = {}) {
  return {
    id,
    content,
    embeds,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    author: { username: 'bob', globalName: 'Bob', displayAvatarURL: () => 'bob.png' },
    member: null,
  };
}

function lecteurDeTest() {
  const enfiles = [];
  const lecteur = creerLecteurMessages({ enfiler: (m) => enfiles.push(m), attenteEmbedMs: ATTENTE });
  return { lecteur, enfiles };
}

describe('authorOf', () => {
  it('prefere le pseudo et l avatar du serveur', () => {
    const user = { username: 'bob', globalName: 'Bob', displayAvatarURL: () => 'user.png' };
    const member = { displayName: 'Bobby', displayAvatarURL: () => 'member.png' };
    assert.deepEqual(authorOf(user, member), { name: 'Bobby', avatar: 'member.png' });
  });

  it('retombe sur l utilisateur quand member arrive brut de l API', () => {
    const user = { username: 'bob', globalName: null, displayAvatarURL: () => 'user.png' };
    assert.deepEqual(authorOf(user, { nick: 'x' }), { name: 'bob', avatar: 'user.png' });
  });
});

describe('le lecteur de messages', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(console, 'warn', () => {});
  });
  afterEach(() => mock.reset());

  it('enfile chaque piece jointe, la legende sur la premiere seulement', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    lecteur.traiter(
      message({
        content: 'regarde',
        attachments: [
          { url: 'https://cdn.x/a.png', contentType: 'image/png' },
          { url: 'https://cdn.x/notes.txt', contentType: 'text/plain' },
          { url: 'https://cdn.x/b.mp4', contentType: 'video/mp4' },
        ],
      }),
    );
    assert.deepEqual(enfiles, [
      { author: AUTEUR, text: 'regarde', mediaUrl: 'https://cdn.x/a.png', mediaType: 'image' },
      { author: AUTEUR, text: null, mediaUrl: 'https://cdn.x/b.mp4', mediaType: 'video' },
    ]);
  });

  it('prend un lien direct et garde le reste en legende', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    lecteur.traiter(message({ content: 'mdr https://x.fr/chat.gif' }));
    assert.deepEqual(enfiles, [
      { author: AUTEUR, text: 'mdr', mediaUrl: 'https://x.fr/chat.gif', mediaType: 'image' },
    ]);
  });

  it('prend un embed deja resolu', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    lecteur.traiter(
      message({
        content: 'https://tenor.com/view/chat',
        embeds: [{ video: { url: 'https://media.tenor.com/chat.mp4' } }],
      }),
    );
    assert.deepEqual(enfiles, [
      { author: AUTEUR, text: null, mediaUrl: 'https://media.tenor.com/chat.mp4', mediaType: 'video' },
    ]);
  });

  it('attend l embed d un lien sans extension, puis l enfile', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    const m = message({ content: 'ha https://tenor.com/view/chat' });
    lecteur.traiter(m);
    assert.equal(lecteur.attend('1'), true);
    assert.equal(enfiles.length, 0);

    m.embeds = [{ image: { url: 'https://media.tenor.com/chat.gif' } }];
    lecteur.resoudreEmbed(m);
    assert.equal(lecteur.attend('1'), false);
    assert.deepEqual(enfiles, [
      { author: AUTEUR, text: 'ha', mediaUrl: 'https://media.tenor.com/chat.gif', mediaType: 'image' },
    ]);

    mock.timers.tick(ATTENTE);
    assert.equal(enfiles.length, 1); // le minuteur a ete annule
  });

  it('sans embed a temps, garde le texte ou laisse tomber le lien seul', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    lecteur.traiter(message({ id: '1', content: 'ha https://tenor.com/view/chat' }));
    lecteur.traiter(message({ id: '2', content: 'https://tenor.com/view/chien' }));
    mock.timers.tick(ATTENTE);
    assert.deepEqual(enfiles, [{ author: AUTEUR, text: 'ha', mediaUrl: null, mediaType: null }]);
    assert.equal(lecteur.attend('2'), false);
  });

  it('enfile un texte seul, ignore un message vide', () => {
    const { lecteur, enfiles } = lecteurDeTest();
    lecteur.traiter(message({ content: '  salut  ' }));
    lecteur.traiter(message({ content: '   ' }));
    assert.deepEqual(enfiles, [{ author: AUTEUR, text: 'salut', mediaUrl: null, mediaType: null }]);
  });
});
