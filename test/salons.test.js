import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estSalon, nomSansDecor } from '../src/salons.js';

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
