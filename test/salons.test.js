import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estSalon, nomSansDecor, salonsNommes } from '../src/salons.js';

describe('estSalon', () => {
  it('reconnait le salon tel quel', () => {
    assert.equal(estSalon({ name: 'livechat' }, 'livechat'), true);
  });

  it('ignore un emoji et un separateur devant le nom', () => {
    assert.equal(estSalon({ name: '📡┃livechat' }, 'livechat'), true);
    assert.equal(estSalon({ name: '💬-livechat' }, 'livechat'), true);
    assert.equal(estSalon({ name: '🛡️┃livechat' }, 'livechat'), true);
  });

  it('ne confond pas avec un autre salon', () => {
    assert.equal(estSalon({ name: '📡┃livechat-archives' }, 'livechat'), false);
    assert.equal(estSalon({ name: '💬┃discussion' }, 'livechat'), false);
    assert.equal(estSalon(null, 'livechat'), false);
  });

  it('garde les accents du nom', () => {
    assert.equal(nomSansDecor('📜┃règlement'), 'règlement');
  });
});

describe('salonsNommes', () => {
  const envoyer = () => {};
  const salons = [
    { name: '📡┃livechat', send: envoyer, guild: { id: 'a' } },
    { name: 'livechat', send: envoyer, guild: { id: 'b' } },
    { name: 'livechat', guild: { id: 'a' } }, // vocal ou categorie : pas de send
    { name: 'discussion', send: envoyer, guild: { id: 'a' } },
  ];

  it('garde les salons du bon nom ou le bot peut ecrire', () => {
    assert.deepEqual(salonsNommes(salons, 'livechat'), [salons[0], salons[1]]);
  });

  it('se limite au serveur demande', () => {
    assert.deepEqual(salonsNommes(salons, 'livechat', 'b'), [salons[1]]);
  });
});
