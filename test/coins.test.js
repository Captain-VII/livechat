import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COIN_PAR_DEFAUT, boundsIndicateur, coinValide } from '../src/client/coins.js';

const TAILLE = { largeur: 320, hauteur: 40, marge: 16 };
// Le 2e ecran de l'hote : a gauche du principal, barre des taches de 48 px en bas.
const ZONE = { x: -2560, y: 0, width: 2560, height: 1392 };

describe('boundsIndicateur', () => {
  it('pose la pastille en haut a gauche par defaut', () => {
    assert.equal(COIN_PAR_DEFAUT, 'haut-gauche');
    assert.deepEqual(boundsIndicateur(ZONE, 'haut-gauche', TAILLE), { x: -2544, y: 16, width: 320, height: 40 });
  });

  it('colle la pastille au bord droit', () => {
    assert.deepEqual(boundsIndicateur(ZONE, 'haut-droite', TAILLE), { x: -336, y: 16, width: 320, height: 40 });
  });

  it('reste au-dessus de la barre des taches dans les coins du bas', () => {
    assert.deepEqual(boundsIndicateur(ZONE, 'bas-gauche', TAILLE), { x: -2544, y: 1336, width: 320, height: 40 });
    assert.deepEqual(boundsIndicateur(ZONE, 'bas-droite', TAILLE), { x: -336, y: 1336, width: 320, height: 40 });
  });

  it('retombe sur le coin par defaut si la config est abimee', () => {
    assert.equal(coinValide('milieu'), 'haut-gauche');
    assert.equal(coinValide(undefined), 'haut-gauche');
    assert.equal(coinValide('toString'), 'haut-gauche');
    assert.equal(coinValide('bas-droite'), 'bas-droite');
  });
});
